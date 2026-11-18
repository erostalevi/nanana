#!/usr/bin/env node
// nanana load test: simulates webhook traffic against production (or any base), tails the
// instance's resource usage through SSM while it runs, and prints a verdict at the end.
//
//   node tools/loadtest/loadtest.mjs --profile medium --yes
//   node tools/loadtest/loadtest.mjs --rps 150 --duration 90 --subs 30 --tunnel-share 40 --body 2048
//   node tools/loadtest/loadtest.mjs --profile probe --yes                  # ramp up until 50% of requests fail
//   node tools/loadtest/loadtest.mjs --base localhost:3001 --scheme http --no-monitor --token dev   (local API)
//
// Every mode (light, medium, heavy, probe) sends a share of its requests to endpoints that have a fake CLI tunnel
// connected (--tunnel-share, percent). Profiles carry their own default; DEFAULT_TUNNEL_SHARE applies to custom runs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, request } from 'undici';
import WebSocket from 'ws';
import { aws, color, fmt, parseArgs, sleep, summarize } from './lib.mjs';
import { Monitor, cpuPercent } from './monitor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Percent of requests sent to tunnelled endpoints when neither the profile nor --tunnel-share says otherwise. */
const DEFAULT_TUNNEL_SHARE = 30;
const PROFILES = {
  light: { rps: 30, duration: 60, subs: 5, tunnelShare: 20, body: 1024 },
  medium: { rps: 100, duration: 90, subs: 20, tunnelShare: 30, body: 2048 },
  heavy: { rps: 250, duration: 120, subs: 40, tunnelShare: 30, body: 4096 },
  // probe: rps/duration do not apply; it starts at probeStart and multiplies by probeFactor every stepSeconds.
  probe: { rps: 1000, duration: 0, subs: 40, tunnelShare: 30, body: 2048 },
};
const HARD_CAPS = { rps: 600, duration: 300, subs: 100, tunnels: 40, body: 512 * 1024 };
const PROBE_HARD_MAX_RPS = 2000;
const PROBE_DEFAULTS = { probeStart: 20, probeFactor: 1.3, stepSeconds: 20, maxRps: 1000, failAt: 50 };

const args = parseArgs(process.argv.slice(2), {
  profile: 'medium', base: 'nanana.lat', scheme: 'https', region: 'us-east-1', monitor: true, token: '', yes: false, sampleEvery: 6, ...PROBE_DEFAULTS,
});
const isProbe = args.profile === 'probe';
const prof = { ...(PROFILES[args.profile] ?? PROFILES.medium) };
if (typeof args.tunnelShare !== 'number') args.tunnelShare = prof.tunnelShare ?? DEFAULT_TUNNEL_SHARE;
for (const k of Object.keys(HARD_CAPS)) if (typeof args[k] === 'number') prof[k] = args[k];
for (const k of Object.keys(HARD_CAPS)) if (prof[k] !== undefined) prof[k] = Math.min(prof[k], HARD_CAPS[k]);
prof.tunnelShare = Math.max(0, Math.min(100, args.tunnelShare));
if (isProbe) {
  // the probe is allowed above the fixed-profile rps cap: that is its whole point
  prof.rps = Math.min(Number(args.maxRps) || PROBE_DEFAULTS.maxRps, PROBE_HARD_MAX_RPS);
  prof.probe = {
    start: Math.max(1, Number(args.probeStart)), factor: Math.max(1.05, Number(args.probeFactor)), stepSeconds: Math.max(8, Number(args.stepSeconds)),
    maxRps: prof.rps, failAt: Math.min(100, Math.max(1, Number(args.failAt))),
  };
}
if (args.noMonitor) args.monitor = false;

/** How many subdomains get a fake CLI tunnel so that `share` percent of requests can be answered through one. */
function planTunnels(subCount, sharePct, explicit) {
  if (sharePct <= 0 || subCount <= 0) return 0;
  const wanted = typeof explicit === 'number' ? explicit : Math.ceil((subCount * sharePct) / 100);
  const room = sharePct >= 100 ? subCount : Math.max(1, subCount - 1); // keep at least one plain endpoint unless share is 100%
  return Math.max(1, Math.min(wanted, HARD_CAPS.tunnels, room));
}

const apiUrl = `${args.scheme}://api.${args.base}`;
const hostFor = (slug) => `${args.scheme}://${slug}.${args.base}`;
const log = (...a) => console.log(...a);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ---- preflight ---------------------------------------------------------------------
async function preflight() {
  const ctx = { token: args.token, instanceId: null };
  if (args.monitor) {
    const who = await aws(['sts', 'get-caller-identity', '--query', 'Account']);
    log(color.dim(`AWS account ${who}, region ${args.region}`));
    ctx.instanceId = await aws(['ec2', 'describe-instances', '--filters', 'Name=tag:project,Values=nanana', 'Name=tag:role,Values=app', 'Name=instance-state-name,Values=running', '--query', 'Reservations[0].Instances[0].InstanceId'], { region: args.region });
    if (!ctx.instanceId || ctx.instanceId === 'None') throw new Error('Could not find the nanana instance (tags project=nanana, role=app).');
    if (!ctx.token) ctx.token = await aws(['ssm', 'get-parameter', '--name', '/nanana/prod/LOADTEST_TOKEN', '--with-decryption', '--query', 'Parameter.Value'], { region: args.region });
  }
  if (!ctx.token) throw new Error('No load-test token: pass --token or enable monitoring so it can be read from SSM.');
  const h = await request(`${apiUrl}/healthz`, { method: 'GET' }).catch((e) => ({ error: e }));
  if (h.error || h.statusCode !== 200) throw new Error(`${apiUrl}/healthz is not healthy (${h.error?.message ?? h.statusCode})`);
  await h.body.dump();
  return ctx;
}

// ---- fake tunnels ------------------------------------------------------------------
function toBytes(id) { return Buffer.from(id.replace(/-/g, ''), 'hex'); }
function fromBytes(b) { const h = b.subarray(0, 16).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }

function connectTunnel(sub, token) {
  const wsUrl = `${args.scheme === 'https' ? 'wss' : 'ws'}://api.${args.base}/tunnel?sub=${sub.slug}`;
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${sub.token}`, 'X-Nanana-Protocol': '1' } });
  const bodies = new Map();
  const answer = (id) => {
    const body = Buffer.from('{"ok":true,"via":"loadtest"}');
    ws.send(JSON.stringify({ t: 'res', id, status: 200, headers: { 'content-type': 'application/json' }, bodyLen: body.length }));
    ws.send(Buffer.concat([toBytes(id), body]), { binary: true });
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const id = fromBytes(data);
      const e = bodies.get(id);
      if (!e) return;
      e.got += data.length - 16;
      if (e.got >= e.len) { bodies.delete(id); answer(id); }
      return;
    }
    const m = JSON.parse(data.toString());
    if (m.t === 'ping') ws.send('{"t":"pong"}');
    else if (m.t === 'req') {
      if (m.bodyLen === 0) answer(m.id);
      else bodies.set(m.id, { len: m.bodyLen, got: 0 });
    }
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_r, res) => reject(new Error(`tunnel HTTP ${res.statusCode}`)));
  });
}

// ---- traffic -----------------------------------------------------------------------
function makeRequest(i, bodyBytes) {
  const r = Math.random();
  const payload = JSON.stringify({ event: 'payment.updated', id: `ev_${i}`, amount: 1000 + (i % 9000), pad: 'x'.repeat(Math.max(0, bodyBytes - 70)) });
  if (r < 0.8) return { method: 'POST', path: `/webhooks/payments?i=${i}`, headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef', 'user-agent': 'loadtest/1' }, body: payload };
  if (r < 0.9) return { method: 'GET', path: `/return?token_ws=${i}`, headers: { 'user-agent': 'loadtest/1' } };
  if (r < 0.95) return { method: 'POST', path: '/form', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `a=${i}&b=${'y'.repeat(Math.min(bodyBytes, 512))}` };
  return { method: 'PUT', path: '/binary', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(Math.min(bodyBytes, 4096), i % 256) };
}

async function main() {
  log(color.bold('nanana load test'));
  const tunnelCount = planTunnels(prof.subs, prof.tunnelShare, typeof args.tunnels === 'number' ? args.tunnels : undefined);
  prof.tunnels = tunnelCount;
  if (isProbe) log(`profile=probe start=${prof.probe.start}rps x${prof.probe.factor} every ${prof.probe.stepSeconds}s up to ${prof.probe.maxRps}rps, stop at ${prof.probe.failAt}% failing, subs=${prof.subs} tunnel-share=${prof.tunnelShare}% (${tunnelCount} tunnelled endpoints) body~${prof.body}B target=${args.base}`);
  else log(`profile=${args.profile} rps=${prof.rps} duration=${prof.duration}s subs=${prof.subs} tunnel-share=${prof.tunnelShare}% (${tunnelCount} tunnelled endpoints) body~${prof.body}B target=${args.base}`);
  const ctx = await preflight();
  if (isProbe) log(color.yellow('The probe keeps raising the load until about half of the requests fail, so it WILL degrade the target for a few minutes (load shedding and recovery are part of what it measures).'));
  else {
    const expectedReq = Math.round(prof.rps * prof.duration * 0.8);
    log(color.dim(`~${expectedReq} requests, ~${((expectedReq * (prof.body + 700)) / 1e6).toFixed(0)} MB of traffic, subdomains are deleted at the end.`));
  }
  if (!args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(`This hits ${args.base}. Continue? [y/N] `);
    rl.close();
    if (!/^y/i.test(a)) { log('aborted'); return; }
  }

  const monitor = args.monitor ? new Monitor({ instanceId: ctx.instanceId, region: args.region }) : null;
  const agent = new Agent({ connections: 64, keepAliveTimeout: 30_000, headersTimeout: 15_000, bodyTimeout: 15_000, connect: { timeout: 10_000 } });
  const subs = [];
  const tunnels = [];
  const cleanup = async () => {
    for (const t of tunnels) try { t.close(); } catch { /* */ }
    await Promise.all(subs.map((s) => request(`${apiUrl}/subdomains/${s.slug}`, { method: 'DELETE', headers: { authorization: `Bearer ${s.token}` }, dispatcher: agent }).then((r) => r.body.dump()).catch(() => {})));
  };
  process.once('SIGINT', async () => { log('\ninterrupted, cleaning up...'); await cleanup(); process.exit(130); });

  let base;
  let creditStart = null;
  try {
    if (monitor) {
      log(color.dim('taking baseline snapshot...'));
      [base, creditStart] = await Promise.all([monitor.snapshot(), monitor.creditBalance()]);
      if (creditStart.balance != null && creditStart.balance < 40) log(color.yellow(`note: the instance has only ${creditStart.balance.toFixed(0)} CPU credits banked, so sustained heavy load can exhaust them and throttle the box to its 20% baseline (that is a real finding about burst headroom, not a bug).`));
      log(color.dim(`baseline: mem avail ${base.memAvail}MB, swap ${base.swapUsed}MB, load ${base.load?.join(' ')}, credit balance ${creditStart.balance?.toFixed(0) ?? 'n/a'}`));
    }

    log(`creating ${prof.subs} subdomains...`);
    for (let i = 0; i < prof.subs; i += 5) {
      await Promise.all(Array.from({ length: Math.min(5, prof.subs - i) }, async () => {
        const r = await request(`${apiUrl}/subdomains`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loadtest-token': ctx.token }, body: '{}', dispatcher: agent });
        const j = await r.body.json();
        if (r.statusCode !== 201) throw new Error(`could not create a subdomain: ${r.statusCode} ${JSON.stringify(j)}`);
        subs.push({ slug: j.subdomain.slug, token: j.token });
      }));
    }
    for (let i = 0; i < Math.min(tunnelCount, subs.length); i++) tunnels.push(await connectTunnel(subs[i]));
    if (tunnels.length) log(`${tunnels.length} fake CLI tunnels connected (${prof.tunnelShare}% of requests go to these endpoints)`);
    const tunnelled = subs.slice(0, tunnels.length);
    const plain = subs.slice(tunnels.length);
    let rrT = 0, rrP = 0;
    const counts = { toTunnelled: 0, toPlain: 0, tunnelAnswered: 0 };
    /** Picks the endpoint for the next request so that `tunnelShare` percent go to tunnelled endpoints. */
    const pickSub = () => {
      const useTunnel = tunnelled.length > 0 && (plain.length === 0 || Math.random() * 100 < prof.tunnelShare);
      if (useTunnel) { counts.toTunnelled++; return { sub: tunnelled[rrT++ % tunnelled.length], tunnel: true }; }
      counts.toPlain++;
      return { sub: plain[rrP++ % plain.length], tunnel: false };
    };

    // ---- run -------------------------------------------------------------------------
    const lat = [];
    const latBySecond = new Map();
    const status = new Map();
    const errors = new Map();
    let sent = 0, done = 0, inflight = 0, skipped = 0;
    const pending = new Map(); // request id -> { t, step }, to spot requests that hang during a collapse
    const win = []; // recent {t, ms, ok}
    const startAt = Date.now();
    let running = true;
    const fixedEndAt = isProbe ? Infinity : startAt + prof.duration * 1000;
    // fixed profiles ramp 20% -> 100% of the target; default is the first 20% of the run, --ramp-seconds shortens it (e.g. for soak tests)
    const rampMs = (typeof args.rampSeconds === 'number' ? Math.max(1, args.rampSeconds) : prof.duration * 0.2) * 1000;
    const samples = [];
    let prevSnap = base;
    let monitorBusy = false;
    let curRps = isProbe ? prof.probe.start : 0; // probe: set by the step loop; fixed: derived from the ramp below
    let curStep = null;

    const fire = () => {
      const id = sent;
      const { sub, tunnel } = pickSub();
      const q = makeRequest(id, prof.body);
      const step = curStep;
      inflight++; sent++;
      if (step) step.sent++;
      const t0 = performance.now();
      pending.set(id, { t: Date.now(), step });
      request(`${hostFor(sub.slug)}${q.path}`, { method: q.method, headers: { ...q.headers, 'x-loadtest-token': ctx.token }, body: q.body, dispatcher: agent })
        .then(async (r) => {
          if (tunnel && r.statusCode === 200) {
            const text = await r.body.text();
            if (text.includes('"via":"loadtest"')) counts.tunnelAnswered++;
          } else await r.body.dump();
          record(id, r.statusCode, performance.now() - t0);
        })
        .catch((e) => { errors.set(e.code || e.name, (errors.get(e.code || e.name) || 0) + 1); record(id, 'error', performance.now() - t0); });
    };
    const record = (id, st, ms) => {
      inflight--; done++;
      const meta = pending.get(id);
      pending.delete(id);
      status.set(st, (status.get(st) || 0) + 1);
      const sec = Math.floor((Date.now() - startAt) / 1000);
      const ok = st !== 'error' && st < 500;
      if (st !== 'error') { lat.push(ms); (latBySecond.get(sec) ?? latBySecond.set(sec, []).get(sec)).push(ms); }
      win.push({ t: Date.now(), ms, ok });
      const step = meta?.step;
      if (step) { step.done++; if (ok) step.ok++; else step.fail++; if (st !== 'error') step.lat.push(ms); }
    };

    // One scheduler for every mode: rate(elapsed) requests per second, fractional carry between ticks.
    const rateAt = (elapsed) => (isProbe ? curRps : prof.rps * Math.min(1, 0.2 + 0.8 * (elapsed / rampMs))); // fixed profiles ramp 20% -> 100% over the first 20% of the run
    let carry = 0, lastTick = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      if (!running || now >= fixedEndAt) return;
      carry += rateAt(now - startAt) * dt;
      const due = Math.floor(carry);
      carry -= due;
      for (let k = 0; k < due; k++) {
        if (inflight > 4000) { skipped++; if (curStep) curStep.skipped++; continue; }
        fire();
      }
    }, 40);

    log(color.bold('\n time   tgt   rps   p50    p95    err%  | cpu%  load  mem-avail  swap   | api/pg/caddy MB | tunnels conns'));
    let lastDone = 0, lastPrint = Date.now();
    const printer = setInterval(() => {
      const now = Date.now();
      const recent = win.filter((w) => now - w.t < 5000);
      win.splice(0, win.length - recent.length);
      const ls = summarize(recent.map((w) => w.ms));
      const rpsNow = ((done - lastDone) / (now - lastPrint)) * 1000;
      lastDone = done; lastPrint = now;
      const tgt = Math.round(isProbe ? curRps : rateAt(now - startAt));
      const errPct = recent.length ? (recent.filter((w) => !w.ok).length / recent.length) * 100 : 0;
      const s = samples[samples.length - 1];
      const mon = s ? `${(s.cpu?.busy ?? 0).toFixed(0).padStart(3)}%  ${(s.load?.[0] ?? 0).toFixed(2).padStart(4)}  ${String(s.memAvail).padStart(6)}MB  ${String(s.swapUsed).padStart(4)}MB | ${['nanana-api', 'nanana-postgres', 'nanana-caddy'].map((c) => String(Math.round(s.ctr[c]?.memMb ?? 0)).padStart(3)).join('/')}         | ${s.conns ?? '-'}` : (monitor ? color.dim('(waiting for first SSM sample)') : color.dim('(monitoring off)'));
      log(`${String(Math.round((now - startAt) / 1000)).padStart(4)}s ${String(tgt).padStart(5)} ${rpsNow.toFixed(0).padStart(5)} ${fmt.ms(ls.p50).padStart(6)} ${fmt.ms(ls.p95).padStart(6)} ${errPct.toFixed(1).padStart(6)} | ${mon}`);
    }, 5000);

    const sampler = monitor ? (async () => {
      while (running || (!isProbe && Date.now() < fixedEndAt + 4000)) {
        if (monitorBusy) { await sleep(500); continue; }
        monitorBusy = true;
        try {
          const snap = await monitor.snapshot();
          snap.cpu = cpuPercent(prevSnap, snap);
          snap.at = Date.now();
          prevSnap = snap;
          samples.push(snap);
        } catch (e) { /* skip a failed sample */ }
        monitorBusy = false;
        await sleep(Math.max(0, args.sampleEvery * 1000 - 4000));
        if (!isProbe && Date.now() >= fixedEndAt + 4000) break;
      }
    })() : Promise.resolve();

    let probe = null;
    if (isProbe) probe = await runProbe();
    else {
      while (Date.now() < fixedEndAt) await sleep(250);
    }
    const endAt = isProbe ? Date.now() : fixedEndAt;
    running = false;
    clearInterval(ticker);
    log(color.dim('traffic stopped, draining...'));
    const drainUntil = Date.now() + 15000;
    while (inflight > 0 && Date.now() < drainUntil) await sleep(200);
    if (probe) probe.recoverySec = await measureRecovery(plain[0] ?? tunnelled[0]);
    await sampler;
    clearInterval(printer);

    // ---- probe: step loop ----------------------------------------------------------------
    async function runProbe() {
      const P = prof.probe;
      const steps = [];
      let rps = P.start;
      let endReason = 'cap';
      for (;;) {
        const step = { rps: Math.round(rps), startedAt: Date.now(), sent: 0, done: 0, ok: 0, fail: 0, skipped: 0, lat: [], broke: false, generatorLimited: false };
        curStep = step;
        curRps = rps;
        let failPct = 0;
        while (Date.now() - step.startedAt < P.stepSeconds * 1000) {
          await sleep(1000);
          const age = Date.now() - step.startedAt;
          const ev = evaluateStep(step);
          failPct = ev.failPct;
          if (age >= 6000 && ev.n >= 60 && ev.failPct >= P.failAt) { step.broke = true; break; }
          if (step.sent > 50 && step.skipped > 0.05 * (step.sent + step.skipped)) {
            // Requests are skipped when 4000 are in flight. That is either this machine failing to keep up (server still
            // answering fast and cleanly) or the server hanging (requests pile up). Only the first is a generator limit.
            if (ev.failPct >= 5 || age >= 6000 && summarize(step.lat.slice(-200)).p95 > 1000) { step.broke = true; step.pileUp = true; }
            else step.generatorLimited = true;
            break;
          }
        }
        step.endedAt = Date.now();
        const ev = evaluateStep(step);
        step.failPct = ev.failPct;
        step.n = ev.n;
        const ls = summarize(step.lat);
        step.p50 = ls.p50; step.p95 = ls.p95; step.p99 = ls.p99;
        step.achievedRps = step.ok / Math.max(1, (step.endedAt - step.startedAt) / 1000); // successful responses per second
        const inStep = samples.filter((x) => x.at >= step.startedAt && x.at <= step.endedAt + 4000);
        step.cpuAvg = inStep.length ? inStep.reduce((a, x) => a + (x.cpu?.busy ?? 0), 0) / inStep.length : null;
        step.conns = inStep.length ? Math.max(...inStep.map((x) => x.conns ?? 0)) : null;
        steps.push(step);
        printStep(step);
        if (step.broke) { endReason = 'broke'; break; }
        if (step.generatorLimited) { endReason = 'generator'; break; }
        if (rps >= P.maxRps) { endReason = 'cap'; break; }
        rps = Math.min(P.maxRps, Math.max(rps + 1, Math.round((rps * P.factor) / 5) * 5));
      }
      curRps = 0;
      curStep = null;
      return { steps, endReason, failAt: P.failAt, recoverySec: null };
    }
    /** Failure rate of a step: 5xx and network errors, plus requests still hanging after 4 s (a collapse shows up as timeouts). */
    function evaluateStep(step) {
      const now = Date.now();
      let stale = 0;
      for (const v of pending.values()) if (v.step === step && now - v.t > 4000) stale++;
      const n = step.ok + step.fail + stale;
      return { n, failPct: n ? ((step.fail + stale) / n) * 100 : 0 };
    }
    function printStep(st) {
      const msOrNa = (x, v) => (x.lat.length ? fmt.ms(v) : 'n/a');
      const tag = st.broke ? color.red('  <- BROKE') : st.generatorLimited ? color.yellow('  <- generator limit') : st.failPct > 5 ? color.yellow('  <- degrading') : '';
      log(color.bold(`  step ${String(st.rps).padStart(5)} rps: ok ${st.achievedRps.toFixed(0).padStart(5)}/s  p50 ${msOrNa(st, st.p50).padStart(6)}  p95 ${msOrNa(st, st.p95).padStart(6)}  failing ${st.failPct.toFixed(1).padStart(5)}%  cpu ${st.cpuAvg == null ? ' n/a' : st.cpuAvg.toFixed(0).padStart(3) + '%'}${tag}`));
    }
    /** After the probe: how long until a plain request is answered quickly again. */
    async function measureRecovery(sub) {
      if (!sub) return null;
      const t0 = Date.now();
      let good = 0;
      while (Date.now() - t0 < 90_000) {
        const s = performance.now();
        const ok = await request(`${hostFor(sub.slug)}/probe-recovery`, { method: 'POST', headers: { 'x-loadtest-token': ctx.token }, body: '{}', dispatcher: agent }).then(async (r) => { await r.body.dump(); return r.statusCode === 200; }).catch(() => false);
        good = ok && performance.now() - s < 1000 ? good + 1 : 0;
        if (good >= 3) return (Date.now() - t0) / 1000;
        await sleep(1000);
      }
      return Infinity;
    }

    // ---- after ------------------------------------------------------------------------
    let after = null, creditEnd = null, logErrors = null, health = null;
    if (monitor) {
      log(color.dim('final snapshot, log scan and CloudWatch credits...'));
      await sleep(8000);
      [after, creditEnd, logErrors] = await Promise.all([monitor.snapshot(), monitor.creditBalance(), monitor.logErrorCounts(new Date(startAt - 5000).toISOString())]);
      after.cpu = cpuPercent(prevSnap, after);
    }
    const hr = await request(`${apiUrl}/healthz`).catch(() => null);
    health = hr?.statusCode === 200;
    if (hr) await hr.body.dump();

    const result = buildResult({ prof, args, startAt, endAt, sent, done, skipped, status, errors, lat, latBySecond, samples, base, after, creditStart, creditEnd, logErrors, health, ctx });
    result.tunnels = { share: prof.tunnelShare, endpoints: tunnels.length, stillConnected: tunnels.filter((w) => w.readyState === WebSocket.OPEN).length, requestsToTunnelled: counts.toTunnelled, requestsToPlain: counts.toPlain, answeredThroughTunnel: counts.tunnelAnswered };
    if (probe) {
      result.probe = { ...probe, steps: probe.steps.map(({ lat: _l, startedAt, endedAt, ...rest }) => ({ ...rest, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString() })) };
      printProbe(result);
    } else printVerdict(result);
    printTunnels(result);
    mkdirSync(join(HERE, 'results'), { recursive: true });
    const file = join(HERE, 'results', `${stamp()}.json`);
    writeFileSync(file, JSON.stringify(result, null, 2));
    if (monitor && !probe) {
      writeFileSync(join(HERE, 'results', 'last-run.json'), JSON.stringify(result, null, 2));
      log(color.dim(`\nsaved ${file}  (the estimator calibrates itself from results/last-run.json)`));
    } else log(color.dim(`\nsaved ${file} (not used for calibration: ${probe ? 'a probe run ends in a collapse, so its CPU cost per request is not representative' : 'no resource monitoring'})`));
  } finally {
    log(color.dim('deleting test subdomains...'));
    await cleanup();
    await agent.close();
  }
}

function buildResult(x) {
  const total = x.done;
  const ok2xx = [...x.status].filter(([k]) => typeof k === 'number' && k < 400).reduce((a, [, v]) => a + v, 0);
  const s5xx = [...x.status].filter(([k]) => typeof k === 'number' && k >= 500).reduce((a, [, v]) => a + v, 0);
  const s429 = x.status.get(429) || 0;
  const netErr = x.status.get('error') || 0;
  const dur = (x.endAt - x.startAt) / 1000;
  const lat = summarize(x.lat);
  const secs = [...x.latBySecond.keys()].sort((a, b) => a - b);
  const q = (arr, p) => summarize(arr).p95;
  const quarter = Math.max(1, Math.floor(secs.length / 4));
  const first = secs.slice(0, quarter).flatMap((s) => x.latBySecond.get(s));
  const last = secs.slice(-quarter).flatMap((s) => x.latBySecond.get(s));
  const cpuSamples = x.samples.map((s) => s.cpu?.busy).filter((v) => v != null);
  const lastThird = cpuSamples.slice(-Math.max(1, Math.floor(cpuSamples.length / 3)));
  const avg = (a) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : null);
  const minAvail = Math.min(...x.samples.map((s) => s.memAvail).filter((v) => v != null), x.after?.memAvail ?? Infinity);
  const maxSwap = Math.max(0, ...x.samples.map((s) => s.swapUsed ?? 0));
  const peakCpu = cpuSamples.length ? Math.max(...cpuSamples) : null;
  const avgCpuAll = avg(cpuSamples);
  const idleBase = x.base?.cpuRaw ? null : null;
  void idleBase;
  const restarted = Object.keys(x.after?.state ?? {}).filter((c) => x.after.state[c].restarts > (x.base?.state?.[c]?.restarts ?? 0) || x.after.state[c].startedAt !== x.base?.state?.[c]?.startedAt);
  const ctrPeak = {};
  for (const s of x.samples) for (const [c, v] of Object.entries(s.ctr)) ctrPeak[c] = Math.max(ctrPeak[c] ?? 0, v.memMb);
  return {
    when: new Date(x.startAt).toISOString(),
    config: { ...x.prof, tunnelShare: x.prof.tunnelShare, base: x.args.base },
    traffic: { sent: x.sent, completed: total, skippedClientSide: x.skipped, achievedRps: total / dur, durationSec: dur, ok2xx, s5xx, s429, netErr, errorCodes: Object.fromEntries(x.errors) },
    latencyMs: lat,
    latencyDriftP95: { firstQuarter: q(first), lastQuarter: q(last) },
    resources: {
      samples: x.samples.length,
      cpuPeak: peakCpu,
      cpuAvg: avgCpuAll,
      cpuAvgLastThird: avg(lastThird),
      stealAvg: avg(x.samples.map((s) => s.cpu?.steal).filter((v) => v != null)),
      loadPeak: Math.max(0, ...x.samples.map((s) => s.load?.[0] ?? 0)),
      memAvailMin: Number.isFinite(minAvail) ? minAvail : null,
      memAvailBase: x.base?.memAvail ?? null,
      swapPeak: maxSwap,
      swapBase: x.base?.swapUsed ?? null,
      containerMemPeakMb: ctrPeak,
      connsPeak: Math.max(0, ...x.samples.map((s) => s.conns ?? 0)),
      pgConnsPeak: Math.max(0, ...x.samples.map((s) => s.pgConns ?? 0)),
      oomDelta: (x.after?.oom ?? 0) - (x.base?.oom ?? 0),
      restartedContainers: restarted,
      disk: x.after?.disk ?? null,
    },
    credits: { start: x.creditStart?.balance ?? null, end: x.creditEnd?.balance ?? null, cpuUtilCw: x.creditEnd?.cpu ?? null },
    logErrors: x.logErrors,
    healthAfter: x.health,
    cpuMsPerRequest: avgCpuAll != null && total ? ((avgCpuAll / 100) * 2 * 1000 * dur) / total : null,
    verdictInputs: { s429Total: s429 },
  };
}

function printVerdict(r) {
  const fails = [];
  const warns = [];
  const t = r.traffic;
  const total = Math.max(1, t.completed);
  const errRate = ((t.s5xx + t.netErr) / total) * 100;
  if (!r.healthAfter) fails.push('API /healthz is not healthy after the test');
  if (r.resources.restartedContainers.length) fails.push(`containers restarted: ${r.resources.restartedContainers.join(', ')}`);
  if (r.resources.oomDelta > 0) fails.push(`kernel OOM events during the test: ${r.resources.oomDelta}`);
  if (errRate > 1) fails.push(`5xx + network errors ${errRate.toFixed(2)}% (limit 1%)`);
  if (r.latencyMs.p99 > 3000) fails.push(`p99 latency ${fmt.ms(r.latencyMs.p99)} (limit 3s)`);
  if (r.resources.memAvailMin != null && r.resources.memAvailMin < 50) fails.push(`available memory dropped to ${r.resources.memAvailMin}MB (limit 50MB)`);
  if (r.latencyMs.p95 > 500) warns.push(`p95 latency ${fmt.ms(r.latencyMs.p95)} (target under 500ms)`);
  if (errRate > 0.1 && errRate <= 1) warns.push(`error rate ${errRate.toFixed(2)}%`);
  if (t.s429 > 0) warns.push(`${t.s429} responses were 429: the load-test bypass is not active`);
  if (r.resources.swapPeak != null && r.resources.swapBase != null && r.resources.swapPeak - r.resources.swapBase > 100) warns.push(`swap grew by ${r.resources.swapPeak - r.resources.swapBase}MB (memory pressure)`);
  if (r.resources.cpuAvgLastThird != null && r.resources.cpuAvgLastThird > 85) warns.push(`CPU averaged ${r.resources.cpuAvgLastThird.toFixed(0)}% at the end (credit-throttling risk on a t3)`);
  if (r.resources.stealAvg != null && r.resources.stealAvg > 10) warns.push(`CPU steal ${r.resources.stealAvg.toFixed(0)}% (credits exhausted: the instance is being throttled)`);
  if (r.credits.start != null && r.credits.end != null && r.credits.start > 0 && r.credits.end < r.credits.start * 0.7) warns.push(`CPU credits fell from ${r.credits.start.toFixed(0)} to ${r.credits.end.toFixed(0)} (30%+ burn)`);
  if (r.latencyDriftP95.firstQuarter > 0 && r.latencyDriftP95.lastQuarter > 2 * r.latencyDriftP95.firstQuarter && r.latencyDriftP95.lastQuarter > 200) warns.push(`latency degraded over time (p95 ${fmt.ms(r.latencyDriftP95.firstQuarter)} -> ${fmt.ms(r.latencyDriftP95.lastQuarter)})`);
  if (t.skippedClientSide > 0) warns.push(`${t.skippedClientSide} requests were skipped because 4000 were already in flight: either the load generator could not keep up, or (if the error rate and latency above are bad) the server stopped answering and requests piled up`);
  const logs = r.logErrors ? Object.entries(r.logErrors).filter(([, n]) => n > 20) : [];
  for (const [c, n] of logs) warns.push(`${n} error lines in ${c} logs during the test`);

  const L = (s = '') => console.log(s);
  L(color.bold('\n================ RESULT ================'));
  L(`requests      ${t.completed} completed of ${t.sent} sent in ${t.durationSec.toFixed(0)}s  (${t.achievedRps.toFixed(0)} rps achieved, target ${r.config.rps})`);
  L(`status        2xx/3xx/4xx: ${t.ok2xx}   5xx: ${t.s5xx}   429: ${t.s429}   network errors: ${t.netErr} ${Object.keys(t.errorCodes).length ? JSON.stringify(t.errorCodes) : ''}`);
  L(`latency       p50 ${fmt.ms(r.latencyMs.p50)}  p90 ${fmt.ms(r.latencyMs.p90)}  p95 ${fmt.ms(r.latencyMs.p95)}  p99 ${fmt.ms(r.latencyMs.p99)}  max ${fmt.ms(r.latencyMs.max)}`);
  if (r.resources.samples) {
    L(`cpu           avg ${r.resources.cpuAvg?.toFixed(0)}%  peak ${r.resources.cpuPeak?.toFixed(0)}%  steal ${r.resources.stealAvg?.toFixed(1)}%  load peak ${r.resources.loadPeak.toFixed(2)}`);
    L(`memory        min available ${r.resources.memAvailMin}MB (was ${r.resources.memAvailBase}MB)  swap peak ${r.resources.swapPeak}MB  containers peak ${JSON.stringify(Object.fromEntries(Object.entries(r.resources.containerMemPeakMb).map(([k, v]) => [k.replace('nanana-', ''), Math.round(v)])))}`);
    L(`connections   443 peak ${r.resources.connsPeak}   postgres peak ${r.resources.pgConnsPeak}   disk ${JSON.stringify(r.resources.disk)}`);
    L(`cpu credits   ${r.credits.start?.toFixed(0) ?? 'n/a'} -> ${r.credits.end?.toFixed(0) ?? 'n/a'} (CloudWatch is 5-minute granularity, so this lags)`);
  }
  L(`cost per req  ${r.cpuMsPerRequest ? r.cpuMsPerRequest.toFixed(1) + ' ms of CPU' : 'n/a'}`);
  L();
  for (const f of fails) L(color.red(`  FAIL  ${f}`));
  for (const w of warns) L(color.yellow(`  WARN  ${w}`));
  const verdict = fails.length ? 'FAIL' : warns.length ? 'PASS WITH WARNINGS' : 'PASS';
  L();
  L(color.bold(`VERDICT: ${fails.length ? color.red(verdict) : warns.length ? color.yellow(verdict) : color.green(verdict)}`) + `  (${r.config.rps} rps target, ${r.config.subs} subdomains, ${r.config.tunnelShare}% via ${r.config.tunnels} tunnelled endpoints)`);
  if (!fails.length && !warns.length) L(color.dim('The box handled this load with headroom. Try --profile heavy, or run `pnpm --filter loadtest estimate`.'));
  r.verdict = verdict;
  r.fails = fails;
  r.warns = warns;
}

function printTunnels(r) {
  const t = r.tunnels;
  if (!t || (!t.requestsToTunnelled && !t.requestsToPlain)) return;
  const total = t.requestsToTunnelled + t.requestsToPlain;
  console.log(`tunnels       ${t.endpoints} tunnelled endpoints (${t.stillConnected} still connected): ${(t.requestsToTunnelled / Math.max(1, total) * 100).toFixed(0)}% of requests targeted them (setting ${t.share}%), ${t.answeredThroughTunnel} answered through a tunnel`);
}

function printProbe(r) {
  const P = r.probe;
  const steps = P.steps;
  const L = (s = '') => console.log(s);
  const comfortable = [...steps].reverse().find((s) => !s.broke && !s.generatorLimited && s.failPct <= 1 && s.p95 <= 500);
  const usable = [...steps].reverse().find((s) => !s.broke && !s.generatorLimited && s.failPct <= 5);
  const broke = steps.find((s) => s.broke);
  L(color.bold('\n================ PROBE RESULT ================'));
  L('step     target   ok/sec     p50     p95     p99  failing   cpu');
  for (const s of steps) L(`${String(steps.indexOf(s) + 1).padStart(4)} ${String(s.rps).padStart(9)} ${s.achievedRps.toFixed(0).padStart(9)} ${(s.n && s.p50 ? fmt.ms(s.p50) : 'n/a').padStart(7)} ${(s.n && s.p95 ? fmt.ms(s.p95) : 'n/a').padStart(7)} ${(s.n && s.p99 ? fmt.ms(s.p99) : 'n/a').padStart(7)} ${(s.failPct.toFixed(1) + '%').padStart(8)} ${s.cpuAvg == null ? '  n/a' : (s.cpuAvg.toFixed(0) + '%').padStart(5)}${s.broke ? '  BROKE' : ''}`);
  L();
  L(`comfortable   ${comfortable ? `up to ${comfortable.rps} rps (at most 1% failing, p95 under 500 ms)` : 'none: even the first step was not clean'}`);
  L(`still usable  ${usable ? `up to ${usable.rps} rps (under 5% failing)` : 'none'}`);
  if (P.endReason === 'broke') L(color.red(`broke         at ${broke.rps} rps target (${broke.failPct.toFixed(0)}% of requests failing, limit ${P.failAt}%); ${broke.achievedRps.toFixed(0)} rps still succeeded, cpu ${broke.cpuAvg == null ? 'n/a' : broke.cpuAvg.toFixed(0) + '%'}, connections ${broke.conns ?? 'n/a'}`));
  else if (P.endReason === 'generator') L(color.yellow('stopped       the load generator on this machine could not push harder (it skipped requests); the server limit is higher than the last step. Run the probe from a bigger machine.'));
  else L(color.yellow(`stopped       reached the ${r.config.probe.maxRps} rps cap without ${P.failAt}% failing: the limit is above that (raise --max-rps, up to ${PROBE_HARD_MAX_RPS}).`));
  if (P.recoverySec != null) L(`recovery      ${Number.isFinite(P.recoverySec) ? `back to normal answers ${P.recoverySec.toFixed(0)} s after the load stopped` : color.red('did NOT recover within 90 s: check the server')}`);
  if (r.resources.samples) L(`cpu credits   ${r.credits.start?.toFixed(0) ?? 'n/a'} -> ${r.credits.end?.toFixed(0) ?? 'n/a'} (CloudWatch lags by up to 5 minutes)`);
  L();
  L(color.bold(`PROBE: ${P.endReason === 'broke' ? `limit found at about ${broke.rps} rps (comfortable ${comfortable?.rps ?? '-'} rps)` : P.endReason === 'generator' ? 'generator-limited, server limit not reached' : `no failure up to ${steps[steps.length - 1].rps} rps`}  (${r.config.tunnelShare}% via tunnels)`));
  r.verdict = P.endReason === 'broke' ? 'LIMIT_FOUND' : P.endReason === 'generator' ? 'GENERATOR_LIMITED' : 'NOT_REACHED';
}

main().catch((e) => {
  console.error(color.red(`\nload test failed: ${e.message}`));
  process.exit(1);
});
