import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Notice, Spinner } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import type { AdminMinute, AdminStats } from '../lib/types';

const REFRESH_MS = 5000;

function uptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const money = (cents: number, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
const num = (n: number) => new Intl.NumberFormat('en-US').format(n);
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{title}</h2>
        {hint && <p className="text-xs text-faint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-accent' : '';
  return (
    <div className="card p-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 font-mono text-2xl ${color}`}>{value}</dd>
      {sub && <dd className="mt-1 text-xs text-faint">{sub}</dd>}
    </div>
  );
}

/** A labelled gauge. `value` and `max` share a unit; `invert` marks "more is better" (available memory). */
function Meter({ label, value, max, text, warnAt, badAt, invert = false }: { label: string; value: number; max: number; text: string; warnAt: number; badAt: number; invert?: boolean }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const level = invert ? (pct <= badAt ? 'bad' : pct <= warnAt ? 'warn' : 'ok') : pct >= badAt ? 'bad' : pct >= warnAt ? 'warn' : 'ok';
  const bar = level === 'bad' ? 'bg-bad' : level === 'warn' ? 'bg-accent' : 'bg-ok';
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className="font-mono text-sm">{text}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-line" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value)} aria-valuetext={`${text}, ${level === 'ok' ? 'healthy' : level === 'warn' ? 'watch' : 'critical'}`}>
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** 60 one-minute bars: captured requests, with refused requests stacked on top. Plain SVG, no chart library. */
function TrafficChart({ series }: { series: AdminMinute[] }) {
  const W = 600;
  const H = 120;
  const gap = 2;
  const bw = W / series.length - gap;
  const max = Math.max(5, ...series.map((m) => m.captured + m.rejected));
  const total = series.reduce((a, m) => a + m.captured, 0);
  const peak = Math.max(...series.map((m) => m.captured));
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label={`Requests per minute over the last hour: ${total} captured, peak ${peak} per minute`}>
        {[0.5, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={H - H * f} y2={H - H * f} stroke="rgb(var(--line))" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((m, i) => {
          const hc = (m.captured / max) * (H - 6);
          const hr = (m.rejected / max) * (H - 6);
          const x = i * (bw + gap);
          const live = i === series.length - 1;
          return (
            <g key={m.minute}>
              <title>{`${new Date(m.minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${m.captured} captured, ${m.rejected} refused`}</title>
              <rect x={x} y={H - hc} width={bw} height={Math.max(hc, m.captured ? 1 : 0)} fill="rgb(var(--accent))" opacity={live ? 0.55 : 1} />
              <rect x={x} y={H - hc - hr} width={bw} height={hr} fill="rgb(var(--bad))" opacity="0.85" />
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-faint">
        <span>60 min ago</span>
        <span className="flex flex-wrap gap-x-3">
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent align-middle" />captured</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-bad align-middle" />refused (404, 429, 413, read-only)</span>
        </span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}

export function Admin() {
  const q = useQuery<AdminStats, ApiError>({ queryKey: ['admin-stats'], queryFn: () => api<AdminStats>('/admin/stats'), retry: false, refetchInterval: REFRESH_MS });
  const d = q.data;
  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
        {d && (
          <p className="flex items-center gap-2 text-xs text-muted" aria-live="off">
            <span className={`inline-block h-2 w-2 rounded-full ${q.isError ? 'bg-bad' : 'bg-ok'}`} aria-hidden="true" />
            {q.isError ? 'Connection lost, retrying' : `Live, refreshing every ${REFRESH_MS / 1000}s`}
          </p>
        )}
      </div>
      {q.isLoading && <Spinner />}
      {q.error instanceof ApiError && q.error.status === 401 && <p className="text-sm text-muted">You need to <Link className="link" to="/login?next=/admin">sign in</Link>.</p>}
      {q.error instanceof ApiError && q.error.status === 403 && <Notice tone="warn">Forbidden: this page is only for the service owner.</Notice>}
      {q.error instanceof ApiError && q.error.status === 404 && <Notice>The stats endpoint is not available on this server.</Notice>}
      {q.isError && ![401, 403, 404].includes((q.error as ApiError).status) && !d && <Notice tone="error">{errorMessage(q.error)}</Notice>}
      {d && (
        <>
          <Section title="Traffic" hint={`Counted since the API last restarted (${new Date(d.traffic.since).toLocaleString()})`}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Requests / min" value={d.traffic.perMinuteNow} sub={`${num(d.traffic.lastFiveMinutes)} in the last 5 min`} />
              <Stat label="Last hour" value={num(d.traffic.lastHour)} sub={`${num(d.traffic.tunneledLastHour)} answered by a tunnel`} />
              <Stat label="Avg response time" value={`${d.traffic.avgLatencyMs} ms`} sub="last 10 min, end to end" tone={d.traffic.avgLatencyMs > 1000 ? 'bad' : d.traffic.avgLatencyMs > 400 ? 'warn' : undefined} />
              <Stat label="Refused, last hour" value={num(d.traffic.rejectedLastHour)} sub="404, rate limit, too large" />
            </dl>
            <div className="card mt-3 p-4">
              <TrafficChart series={d.traffic.series} />
            </div>
            {d.traffic.topEndpoints.length > 0 && (
              <div className="card mt-3 p-4">
                <h3 className="mb-2 text-xs text-muted">Busiest endpoints, last hour (stored requests)</h3>
                <ol className="space-y-1 font-mono text-sm">
                  {d.traffic.topEndpoints.map((e) => (
                    <li key={e.slug} className="flex justify-between gap-3">
                      <span className="truncate">{e.slug}</span>
                      <span className="text-muted">{num(e.requests)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </Section>

          <Section title="Revenue" hint="Estimated from active subscriptions. Polar holds the real numbers.">
            {!d.revenue.billingEnabled && <div className="mb-3"><Notice>Billing is not enabled on this server, so there is no paid revenue yet.</Notice></div>}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="MRR" value={money(d.revenue.mrrCents, d.revenue.currency)} sub={`ARR ${money(d.revenue.arrCents, d.revenue.currency)}`} />
              <Stat label="Paying subscribers" value={d.revenue.payingSubscribers} sub={`${d.revenue.monthly} monthly, ${d.revenue.yearly} yearly`} />
              <Stat label="Payment failing" value={d.revenue.pastDue} sub="in the 7-day grace period" tone={d.revenue.pastDue ? 'warn' : undefined} />
              <Stat label="Cancelling" value={d.revenue.cancelingAtPeriodEnd} sub="end at period close" tone={d.revenue.cancelingAtPeriodEnd ? 'warn' : undefined} />
            </dl>
          </Section>

          <Section title="Growth">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Accounts" value={num(d.accounts)} sub={`${d.growth.plans.free ?? 0} free, ${(d.growth.plans.pro ?? 0) + (d.growth.plans.pro_grace ?? 0)} Pro, ${d.growth.plans.lapsed ?? 0} lapsed`} />
              <Stat label="Signups" value={d.growth.signups24h} sub={`${d.growth.signups7d} in 7 days`} />
              <Stat label="Endpoints" value={num(d.subdomains.total)} sub={`${d.subdomains.active} active, ${d.subdomains.cold} cold`} />
              <Stat label="Created, 24 h" value={d.growth.endpointsCreated24h} sub={`${d.subdomains.anonymous} anonymous, ${d.subdomains.custom} custom names`} />
              <Stat label="Tunnels online" value={d.tunnelsOnline} />
              <Stat label="Stored requests" value={num(d.capturedRequests)} sub={`${num(d.requestsLastHour)} in the last hour`} />
            </dl>
          </Section>

          <Section title="Server health" hint={`${d.health.cpus} vCPU, ${gb(d.health.memTotalMb)} RAM`}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Meter label="CPU load (1 min)" value={d.health.loadPct} max={100} text={`${d.health.load1} (${d.health.loadPct}%)`} warnAt={70} badAt={100} />
              <Meter label="Memory available" value={d.health.memAvailableMb} max={d.health.memTotalMb} text={`${gb(d.health.memAvailableMb)} of ${gb(d.health.memTotalMb)}`} warnAt={25} badAt={10} invert />
              <Meter label="Database volume" value={d.health.db.sizeMb} max={d.health.db.volumeMb} text={`${gb(d.health.db.sizeMb)} of ${gb(d.health.db.volumeMb)}`} warnAt={60} badAt={85} />
              <Meter label="Event loop delay (p99)" value={d.health.eventLoopP99Ms} max={200} text={`${d.health.eventLoopP99Ms} ms`} warnAt={25} badAt={50} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Database latency" value={`${d.health.db.pingMs} ms`} sub={`${d.health.db.connections} connections`} tone={d.health.db.pingMs > 100 ? 'warn' : undefined} />
              <Stat label="Captures table" value={gb(d.health.db.capturesMb)} />
              <Stat label="API memory" value={gb(d.health.apiRssMb)} sub={`heap ${d.health.apiHeapMb} MB`} />
              <Stat label="Uptime" value={uptime(d.uptimeSeconds)} sub={`version ${d.version}`} />
            </dl>
            <p className="mt-3 text-xs text-faint">CPU credits (the t3.micro throttle) are only visible in CloudWatch. Moderation happens through the admin CLI.</p>
          </Section>
        </>
      )}
    </div>
  );
}
