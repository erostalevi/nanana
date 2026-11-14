import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Notice, Spinner } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import type { AdminStats } from '../lib/types';

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="card p-4"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 font-mono text-2xl">{value}</dd></div>;
}

function uptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function Admin() {
  const q = useQuery<AdminStats, ApiError>({ queryKey: ['admin-stats'], queryFn: () => api<AdminStats>('/admin/stats'), retry: false, refetchInterval: 30_000 });
  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Admin</h1>
      {q.isLoading && <Spinner />}
      {q.error instanceof ApiError && q.error.status === 401 && <p className="text-sm text-muted">You need to <Link className="link" to="/login?next=/admin">sign in</Link>.</p>}
      {q.error instanceof ApiError && q.error.status === 403 && <Notice tone="warn">Forbidden: this page is only for the service owner.</Notice>}
      {q.error instanceof ApiError && q.error.status === 404 && <Notice>The stats endpoint is not available on this server.</Notice>}
      {q.isError && ![401, 403, 404].includes((q.error as ApiError).status) && <Notice tone="error">{errorMessage(q.error)}</Notice>}
      {q.data && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Accounts" value={q.data.accounts} />
            <Stat label="Endpoints" value={q.data.subdomains.total} />
            <Stat label="Active" value={q.data.subdomains.active} />
            <Stat label="Cold" value={q.data.subdomains.cold} />
            <Stat label="Anonymous" value={q.data.subdomains.anonymous} />
            <Stat label="Custom names" value={q.data.subdomains.custom} />
            <Stat label="Tunnels online" value={q.data.tunnelsOnline} />
            <Stat label="Captured requests" value={q.data.capturedRequests} />
            <Stat label="Requests, last hour" value={q.data.requestsLastHour} />
            <Stat label="Uptime" value={uptime(q.data.uptimeSeconds)} />
            <Stat label="Version" value={q.data.version} />
          </dl>
          <p className="mt-4 text-xs text-faint">Read-only. Refreshes every 30 seconds. Moderation happens through the admin CLI.</p>
        </>
      )}
    </div>
  );
}
