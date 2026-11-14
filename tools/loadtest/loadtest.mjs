#!/usr/bin/env node
// nanana load test: simulates webhook traffic against production (or any base), tails the
// instance's resource usage through SSM while it runs, and prints a verdict at the end.
//
//   node tools/loadtest/loadtest.mjs --profile medium --yes
//   node tools/loadtest/loadtest.mjs --rps 150 --duration 90 --subs 30 --tunnels 8 --body 2048
//   node tools/loadtest/loadtest.mjs --base localhost:3001 --scheme http --no-monitor --token dev   (local API)
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, request } from 'undici';
import WebSocket from 'ws';
import { aws, color, fmt, parseArgs, sleep, summarize } from './lib.mjs';
import { Monitor, cpuPercent } from './monitor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = {
  light: { rps: 30, duration: 60, subs: 5, tunnels: 0, body: 1024 },
  medium: { rps: 100, duration: 90, subs: 20, tunnels: 5, body: 2048 },
  heavy: { rps: 250, duration: 120, subs: 40, tunnels: 10, body: 4096 },
};
const HARD_CAPS = { rps: 600, duration: 300, subs: 100, tunnels: 40, body: 512 * 1024 };

const args = parseArgs(process.argv.slice(2), {
  profile: 'medium', base: 'nanana.lat', scheme: 'https', region: 'us-east-1', monitor: true, token: '', yes: false, sampleEvery: 6,
});
const prof = { ...PROFILES[args.profile] ?? PROFILES.medium };
for (const k of Object.keys(HARD_CAPS)) if (typeof args[k] === 'number') prof[k] = args[k];
for (const k of Object.keys(HARD_CAPS)) prof[k] = Math.min(prof[k], HARD_CAPS[k]);
if (args.noMonitor) args.monitor = false;

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
  log(`profile=${args.profile} rps=${prof.rps} duration=${prof.duration}s subs=${prof.subs} tunnels=${prof.tunnels} body~${prof.body}B target=${args.base}`);
  const ctx = await preflight();
  const expectedReq = Math.round(prof.rps * prof.duration * 0.8);
  log(color.dim(`~${expectedReq} requests, ~${((expectedReq * (prof.body + 700)) / 1e6).toFixed(0)} MB of traffic, subdomains are deleted at the end.`));
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
    for (let i = 0; i < Math.min(prof.tunnels, subs.length); i++) tunnels.push(await connectTunnel(subs[i]));
    if (tunnels.length) log(`${tunnels.length} fake CLI tunnels connected`);

    // ---- run -------------------------------------------------------------------------
    const lat = [];
    const latBySecond = new Map();
    const status = new Map();
    const errors = new Map();
    let sent = 0, done = 0, inflight = 0, skipped = 0;
    const win = []; // recent {t, ms, ok}
    const startAt = Date.now();
    const endAt = startAt + prof.duration * 1000;
    const rampMs = prof.duration * 1000 * 0.2;
    const samples = [];
    let prevSnap = base;
    let monitorBusy = false;

    const fire = (i) => {
      const sub = subs[i % subs.length];
      const q = makeRequest(i, prof.body);
      inflight++; sent++;
      const t0 = performance.now();
      request(`${hostFor(sub.slug)}${q.path}`, { method: q.method, headers: { ...q.headers, 'x-loadtest-token': ctx.token }, body: q.body, dispatcher: agent })
        .then(async (r) => {
          await r.body.dump();
          record(r.statusCode, performance.now() - t0);
        })
        .catch((e) => { errors.set(e.code || e.name, (errors.get(e.code || e.name) || 0) + 1); record('error', performance.now() - t0); });
    };
    const record = (st, ms) => {
      inflight--; done++;
      status.set(st, (status.get(st) || 0) + 1);
      const sec = Math.floor((Date.now() - startAt) / 1000);
      if (st !== 'error') { lat.push(ms); (latBySecond.get(sec) ?? latBySecond.set(sec, []).get(sec)).push(ms); }
      win.push({ t: Date.now(), ms, ok: st !== 'error' && st < 500 });
    };

    const ticker = setInterval(() => {
      const now = Date.now();
      if (now >= endAt) return;
      const elapsed = now - startAt;
      const effRps = prof.rps * Math.min(1, 0.2 + 0.8 * (elapsed / rampMs));
      const target = Math.floor((elapsed / 1000) * effRps * (1 - 0.1 * Math.min(1, elapsed / rampMs))) ; // smooth ramp
      const due = Math.max(0, Math.floor(rampIntegral(elapsed, prof.rps, rampMs)) - sent - skipped);
      void target;
      for (let k = 0; k < due; k++) {
        if (inflight > 4000) { skipped++; continue; }
        fire(sent + skipped);
      }
    }, 40);

    log(color.bold('\n time   rps   p50    p95    err%  | cpu%  load  mem-avail  swap   | api/pg/caddy MB | tunnels conns'));
    let lastDone = 0, lastTick = Date.now();
    const printer = setInterval(() => {
      const now = Date.now();
      const recent = win.filter((w) => now - w.t < 5000);
      win.splice(0, win.length - recent.length);
      const ls = summarize(recent.map((w) => w.ms));
      const rpsNow = ((done - lastDone) / (now - lastTick)) * 1000;
      lastDone = done; lastTick = now;
      const errPct = recent.length ? (recent.filter((w) => !w.ok).length / recent.length) * 100 : 0;
      const s = samples[samples.length - 1];
      const mon = s ? `${(s.cpu?.busy ?? 0).toFixed(0).padStart(3)}%  ${(s.load?.[0] ?? 0).toFixed(2).padStart(4)}  ${String(s.memAvail).padStart(6)}MB  ${String(s.swapUsed).padStart(4)}MB | ${['nanana-api', 'nanana-postgres', 'nanana-caddy'].map((c) => String(Math.round(s.ctr[c]?.memMb ?? 0)).padStart(3)).join('/')}         | ${s.conns ?? '-'}` : color.dim('(waiting for first SSM sample)');
      log(`${String(Math.round((now - startAt) / 1000)).padStart(4)}s ${rpsNow.toFixed(0).padStart(5)} ${fmt.ms(ls.p50).padStart(6)} ${fmt.ms(ls.p95).padStart(6)} ${errPct.toFixed(1).padStart(6)} | ${mon}`);
    }, 5000);

    const sampler = monitor ? (async () => {
      while (Date.now() < endAt + 4000) {
        if (monitorBusy) { await sleep(500); continue; }
        monitorBusy = true;
        try {
          const snap = await monitor.snapshot();
          snap.cpu = cpuPercent(prevSnap, snap);
          prevSnap = snap;
          samples.push(snap);
        } catch (e) { /* skip a failed sample */ }
        monitorBusy = false;
        await sleep(Math.max(0, args.sampleEvery * 1000 - 4000));
      }
    })() : Promise.resolve();

    while (Date.now() < endAt) await sleep(250);
    clearInterval(ticker);
    log(color.dim('traffic stopped, draining...'));
    const drainUntil = Date.now() + 15000;
    while (inflight > 0 && Date.now() < drainUntil) await sleep(200);
    await sampler;
    clearInterval(printer);

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
    printVerdict(result);
    mkdirSync(join(HERE, 'results'), { recursive: true });
    const file = join(HERE, 'results', `${stamp()}.json`);
    writeFileSync(file, JSON.stringify(result, null, 2));
    if (monitor) {
      writeFileSync(join(HERE, 'results', 'last-run.json'), JSON.stringify(result, null, 2));
      log(color.dim(`\nsaved ${file}  (the estimator calibrates itself from results/last-run.json)`));
    } else log(color.dim(`\nsaved ${file} (not used for calibration: no resource monitoring)`));
  } finally {
    log(color.dim('deleting test subdomains...'));
    await cleanup();
    await agent.close();
  }
}

// cumulative requests due at `elapsed` ms with a linear ramp from 20% to 100% of rps
function rampIntegral(elapsed, rps, rampMs) {
  const e = elapsed / 1000;
  const r = rampMs / 1000;
  if (elapsed <= rampMs) return rps * (0.2 * e + 0.8 * (e * e) / (2 * r));
  return rps * (0.2 * r + 0.8 * (r / 2)) + rps * (e - r);
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
    config: { ...x.prof, base: x.args.base },
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
  if (t.skippedClientSide > 0) warns.push(`the load generator itself saturated and skipped ${t.skippedClientSide} requests (results understate the target rate)`);
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
  L(color.bold(`VERDICT: ${fails.length ? color.red(verdict) : warns.length ? color.yellow(verdict) : color.green(verdict)}`) + `  (${r.config.rps} rps target, ${r.config.subs} subdomains, ${r.config.tunnels} tunnels)`);
  if (!fails.length && !warns.length) L(color.dim('The box handled this load with headroom. Try --profile heavy, or run `pnpm --filter loadtest estimate`.'));
  r.verdict = verdict;
  r.fails = fails;
  r.warns = warns;
}

main().catch((e) => {
  console.error(color.red(`\nload test failed: ${e.message}`));
  process.exit(1);
});
