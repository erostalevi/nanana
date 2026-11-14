#!/usr/bin/env node
// Capacity estimator for the nanana single-box setup.
//
//   node tools/loadtest/estimate.mjs                         # defaults, calibrated from results/last-run.json if present
//   node tools/loadtest/estimate.mjs --avg-rps 20 --peak-rps 120 --peak-minutes 45 --tunnel-share 0.4 --body-kb 4
//   node tools/loadtest/estimate.mjs --instance t3.small --active-subs 500 --tunnels 60
//
// It is a model, not a measurement: run loadtest.mjs first so the CPU cost per request is measured
// on your real box instead of assumed.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { color, parseArgs } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2), {
  instance: 't3.micro',
  avgRps: 10,
  peakRps: 0,
  peakMinutes: 30,
  tunnelShare: 0.3,
  bodyKb: 2,
  activeSubs: 200,
  tunnels: 20,
  credits: 0,
  dashboards: 5,
  from: join(HERE, 'results', 'last-run.json'),
  plan: 'anonymous',
  json: false,
});
if (!args.peakRps) args.peakRps = args.avgRps * 6;

// vCPU-credit economics of the t3 family (standard credit mode, as deployed).
const INSTANCES = {
  't3.micro': { vcpu: 2, ramMb: 1024, baselinePct: 10, creditsPerHour: 12, maxCredits: 288, usdHr: 0.0104 },
  't3.small': { vcpu: 2, ramMb: 2048, baselinePct: 20, creditsPerHour: 24, maxCredits: 576, usdHr: 0.0208 },
  't3.medium': { vcpu: 2, ramMb: 4096, baselinePct: 20, creditsPerHour: 24, maxCredits: 576, usdHr: 0.0416 },
  't3.large': { vcpu: 2, ramMb: 8192, baselinePct: 30, creditsPerHour: 36, maxCredits: 864, usdHr: 0.0832 },
};
// IPv4 + EBS + Route 53 + S3/ECR/misc, per month
const FIXED_MONTHLY = 3.65 + 2.4 + 0.5 + 1.5;
const LIMITS = { anonymous: { rpm: 60 }, free: { rpm: 300 } };

// ---- calibration ---------------------------------------------------------------------
let measured = null;
if (existsSync(args.from)) {
  try {
    measured = JSON.parse(readFileSync(args.from, 'utf8'));
  } catch {
    measured = null;
  }
}
const assumedCpuMs = 8;
const measuredCpuMs = measured?.cpuMsPerRequest && measured.cpuMsPerRequest > 0.5 ? measured.cpuMsPerRequest : null;
const cpuMs = measuredCpuMs ?? assumedCpuMs;
const calibrated = measuredCpuMs !== null;
const tunnelMult = 1.3; // extra framing + websocket copy for tunneled requests
const effCpuMs = cpuMs * (1 + (tunnelMult - 1) * args.tunnelShare) * (1 + (0.05 * Math.min(args.bodyKb, 100)) / 10);
const idleMsPerSec = 40; // caddy + node + postgres housekeeping at zero traffic
const memPeak = measured?.resources?.containerMemPeakMb ?? {};
const apiBaseMb = Math.max(110, memPeak['nanana-api'] ? memPeak['nanana-api'] * 0.8 : 0);
const pgBaseMb = Math.max(150, memPeak['nanana-postgres'] ? memPeak['nanana-postgres'] * 0.9 : 0);
const caddyMb = 45;
const osMb = 170;

function evalInstance(name) {
  const I = INSTANCES[name];
  const baselineMsPerSec = ((I.vcpu * I.baselinePct) / 100) * 1000;
  const ceilingMsPerSec = I.vcpu * 1000 * 0.85;
  const neutralRps = Math.max(0, (baselineMsPerSec - idleMsPerSec) / effCpuMs);
  const ceilingRps = Math.max(0, (ceilingMsPerSec - idleMsPerSec) / effCpuMs);
  const creditsPerMsPerSec = 0.06; // 1 ms/s of CPU sustained for an hour = 3.6 vCPU-s = 0.06 credits
  const peakH = args.peakMinutes / 60;
  const avgDemand = args.avgRps * effCpuMs + idleMsPerSec;
  const peakDemand = Math.min(args.peakRps * effCpuMs + idleMsPerSec, ceilingMsPerSec);
  const dailyUse = (avgDemand * (24 - peakH) + peakDemand * peakH) * creditsPerMsPerSec;
  const dailyEarn = I.creditsPerHour * 24;
  const net = dailyEarn - dailyUse;
  const startCredits = args.credits || (name === 't3.micro' && measured?.credits?.start != null ? measured.credits.start : I.maxCredits / 2);
  const peakBurnPerHour = peakDemand * creditsPerMsPerSec - I.creditsPerHour;
  const burstMinutes = peakBurnPerHour > 0 ? (startCredits / peakBurnPerHour) * 60 : Infinity;
  const tunnelMb = args.tunnels * 0.18;
  const inflightMb = Math.min(args.peakRps * 0.08, 400) * (args.bodyKb / 1024) * 2;
  const memUsed = osMb + apiBaseMb + pgBaseMb + caddyMb + tunnelMb + inflightMb + args.dashboards * 0.6;
  const rowKb = (args.bodyKb + 2) * 1.3;
  const perSubMb = Math.min((100 * rowKb) / 1024, 50);
  const diskMb = args.activeSubs * perSubMb;
  // responses + dashboard pushes leave the box; inbound webhook traffic is free
  const egressGbMonth = (args.avgRps * 2_592_000 * (args.tunnelShare * (args.bodyKb * 0.2 + 1) + 0.6)) / 1e6;
  const egressUsd = Math.max(0, egressGbMonth - 100) * 0.09;
  return {
    name,
    ...I,
    neutralRps,
    ceilingRps,
    dailyUse,
    dailyEarn,
    net,
    burstMinutes,
    memUsed,
    memPct: (memUsed / I.ramMb) * 100,
    diskMb,
    egressGbMonth,
    egressUsd,
    monthlyUsd: I.usdHr * 730 + FIXED_MONTHLY + egressUsd,
  };
}

const rows = Object.keys(INSTANCES).map(evalInstance);
const cur = rows.find((r) => r.name === args.instance) ?? rows[0];
const lim = LIMITS[args.plan] ?? LIMITS.anonymous;
const planCeiling = (args.activeSubs * lim.rpm) / 60;
// unlogged insert + update + retention delete per request on Postgres
const dbRps = 350 * (cur.vcpu / 2) * (cur.ramMb >= 2048 ? 1.4 : 1);

if (args.json) {
  console.log(JSON.stringify({ calibrated, cpuMsPerRequest: effCpuMs, current: cur, rows, planCeilingRps: planCeiling, dbRps }, null, 2));
  process.exit(0);
}

const L = (s = '') => console.log(s);
const ok = (b) => (b ? color.green('OK ') : color.red('NO '));
const fits = (r) => args.peakRps <= r.ceilingRps && r.net >= 0 && r.memPct < 85;
L(color.bold(`nanana capacity estimate for ${cur.name}`));
L(
  color.dim(
    calibrated
      ? `calibrated from the run at ${measured.when} (${effCpuMs.toFixed(1)} ms CPU per request, measured)`
      : `NOT calibrated: assuming ${effCpuMs.toFixed(1)} ms CPU per request. Run tools/loadtest/loadtest.mjs for real numbers.`,
  ),
);
L(
  color.dim(
    `scenario: avg ${args.avgRps} rps, peak ${args.peakRps} rps for ${args.peakMinutes} min/day, ${(args.tunnelShare * 100).toFixed(0)}% via tunnels, ${args.bodyKb} KB bodies, ${args.activeSubs} active subdomains, ${args.tunnels} live tunnels`,
  ),
);
L();
L(color.bold('Realistic capacity'));
L(`  sustained (CPU-credit neutral)   ${cur.neutralRps.toFixed(0)} rps    ${color.dim('what it can serve 24/7 without ever running out of CPU credits')}`);
L(
  `  burst                            ${cur.ceilingRps.toFixed(0)} rps    ${color.dim(`CPU at 85%; lasts ~${Number.isFinite(cur.burstMinutes) ? cur.burstMinutes.toFixed(0) + ' min' : 'indefinitely'} at your peak before credits run dry`)}`,
);
L(`  database limit (rough)           ${dbRps.toFixed(0)} rps    ${color.dim('insert + update + retention per request on Postgres, unlogged tables')}`);
L(
  `  per-plan traffic ceiling         ${planCeiling.toFixed(0)} rps    ${color.dim(`${args.activeSubs} subdomains x ${lim.rpm} req/min (${args.plan} limit): real traffic cannot exceed this`)}`,
);
L();
L(color.bold('Your scenario'));
L(
  `  CPU credits per day              earn ${cur.dailyEarn.toFixed(0)}, spend ${cur.dailyUse.toFixed(0)}  ->  ${cur.net >= 0 ? color.green('+' + cur.net.toFixed(0) + ' (sustainable)') : color.red(cur.net.toFixed(0) + ' (credits drain; expect throttling)')}`,
);
L(`  memory                           ${cur.memUsed.toFixed(0)} MB of ${cur.ramMb} MB (${cur.memPct.toFixed(0)}%)  ${ok(cur.memPct < 85)}`);
L(`  capture storage                  ~${cur.diskMb.toFixed(0)} MB of 10240 MB data volume  ${ok(cur.diskMb < 8000)}`);
L(`  egress                           ~${cur.egressGbMonth.toFixed(1)} GB/month (first 100 GB free)  cost ~$${cur.egressUsd.toFixed(2)}`);
L(`  verdict                          ${fits(cur) ? color.green('the current box handles this scenario') : color.yellow('this scenario outgrows the current box: see the table below')}`);
L();
L(color.bold('Instance comparison for this scenario'));
L(color.dim('  type        $/month  sustained  burst     credits/day  memory   verdict'));
for (const r of rows) {
  L(
    `  ${r.name.padEnd(10)}  $${r.monthlyUsd.toFixed(0).padStart(4)}    ${r.neutralRps.toFixed(0).padStart(5)} rps ${r.ceilingRps.toFixed(0).padStart(5)} rps  ${((r.net >= 0 ? '+' : '') + r.net.toFixed(0)).padStart(6)}      ${r.memPct.toFixed(0).padStart(3)}%    ${fits(r) ? color.green('fits') : color.red('tight')}${r.name === cur.name ? color.dim('  (current)') : ''}`,
  );
}
L();
L(color.bold('Upgrade triggers (t3.micro -> t3.small, about +$7.6/month)'));
L(`  - sustained traffic above ~${(cur.neutralRps * 0.7).toFixed(0)} rps for hours, or the CPU-credit balance trending to 0 in CloudWatch`);
L('  - memory available under 150 MB or swap growing during peaks');
L('  - more than ~150 simultaneous tunnels (file descriptors and per-tunnel buffers)');
L(color.dim('\nThese are modelled numbers. Treat them as order-of-magnitude and verify with loadtest.mjs.'));
