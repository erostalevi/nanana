// Shared helpers: arg parsing, AWS CLI wrappers, stats.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function parseArgs(argv, defaults) {
  const out = { ...defaults, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split('=');
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (v !== undefined) out[key] = coerce(v);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[key] = coerce(argv[++i]);
    else out[key] = true;
  }
  return out;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

export async function aws(args, { region, json = false, timeout = 60000 } = {}) {
  const full = [...args, ...(region ? ['--region', region] : []), ...(json ? ['--output', 'json'] : ['--output', 'text'])];
  const { stdout } = await exec('aws', full, { timeout, maxBuffer: 16 * 1024 * 1024 });
  return json ? JSON.parse(stdout) : stdout.trim();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function summarize(values) {
  const s = Float64Array.from(values).sort();
  return {
    n: s.length,
    min: s[0] ?? 0,
    p50: percentile(s, 50),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? 0,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
  };
}

export const fmt = {
  ms: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`),
  pct: (v) => `${v.toFixed(1)}%`,
  mb: (v) => `${v.toFixed(0)}MB`,
};

export const color = {
  red: (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};
