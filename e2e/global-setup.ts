import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { A11Y_DIR, API_LOG, API_PORT, REPO_ROOT, RUN_DIR, VITE_LOG, WEB_PORT, API_URL, apiEnv, PID_FILE } from './lib/env';
import { resetDb } from './lib/db';

const procs: { name: string; child: ChildProcess }[] = [];

function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

/** Rebuilds apps/api/dist when it is missing or older than any source file. */
function ensureApiBuilt(): void {
  const main = path.join(REPO_ROOT, 'apps/api/dist/main.js');
  const stale = !fs.existsSync(main) || fs.statSync(main).mtimeMs < newestMtime(path.join(REPO_ROOT, 'apps/api/src'));
  if (!stale) return;
  console.log('[e2e] apps/api/dist is stale, running: pnpm --filter api build');
  const r = spawnSync('pnpm', ['--filter', 'api', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('API build failed');
  // nest's incremental build may leave main.js untouched; stamp it so the next run does not rebuild.
  const now = new Date();
  fs.utimesSync(main, now, now);
}

function portInUse(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host });
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([a, b]) => a || b);
}

async function waitFor(url: string, name: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not become ready at ${url} within ${ms} ms (${last}). See e2e/.run/*.log`);
}

function start(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>, logFile: string): void {
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], detached: true });
  child.on('exit', (code, sig) => {
    if (!stopping) console.error(`[e2e] ${name} exited unexpectedly (code=${code} signal=${sig}). See ${logFile}`);
  });
  procs.push({ name, child });
  fs.writeFileSync(PID_FILE, JSON.stringify(procs.map((p) => ({ name: p.name, pid: p.child.pid }))));
}

let stopping = false;

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    /* already gone */
  }
}

async function stopAll(): Promise<void> {
  stopping = true;
  for (const p of procs) killGroup(p.child, 'SIGTERM');
  const end = Date.now() + 5000;
  while (Date.now() < end && (await portInUse(API_PORT).then(async (a) => a || (await portInUse(WEB_PORT))))) await new Promise((r) => setTimeout(r, 100));
  for (const p of procs) killGroup(p.child, 'SIGKILL');
  procs.length = 0;
  fs.rmSync(PID_FILE, { force: true });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.rmSync(A11Y_DIR, { recursive: true, force: true });
  fs.mkdirSync(A11Y_DIR, { recursive: true });

  for (const port of [API_PORT, WEB_PORT]) {
    if (await portInUse(port)) throw new Error(`Port ${port} is already in use. Stop whatever listens there (see e2e/README.md, "Stuck processes") and re-run.`);
  }
  ensureApiBuilt();
  await resetDb();

  process.once('exit', () => {
    for (const p of procs) killGroup(p.child, 'SIGKILL');
  });

  // cwd is e2e/.run so the API never picks up apps/api/.env (process.loadEnvFile reads ./.env).
  start('api', process.execPath, [path.join(REPO_ROOT, 'apps/api/dist/main.js')], RUN_DIR, apiEnv, API_LOG);
  start(
    'vite',
    process.execPath,
    [path.join(REPO_ROOT, 'apps/web/node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort'],
    path.join(REPO_ROOT, 'apps/web'),
    { VITE_API_URL: API_URL },
    VITE_LOG,
  );
  try {
    await Promise.all([waitFor(`${API_URL}/healthz`, 'API'), waitFor(`http://localhost:${WEB_PORT}/`, 'Vite')]);
  } catch (e) {
    await stopAll();
    throw e;
  }
  return stopAll;
}
