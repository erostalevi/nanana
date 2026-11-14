import type { QueryClient } from '@tanstack/react-query';
import type { RequestDetail, RequestSummary, StreamEvent, Subdomain } from '../lib/types';

export const MAX_REQUESTS = 100;

export const qk = {
  sub: (slug: string) => ['sub', slug] as const,
  requests: (slug: string) => ['requests', slug] as const,
  request: (id: string) => ['request', id] as const,
  tunnel: (slug: string) => ['tunnel', slug] as const,
};

export function upsertRequest(list: RequestSummary[], r: RequestSummary): RequestSummary[] {
  const i = list.findIndex((x) => x.id === r.id);
  if (i !== -1) {
    const next = list.slice();
    next[i] = r;
    return next;
  }
  const t = new Date(r.receivedAt).getTime();
  const at = list.findIndex((x) => new Date(x.receivedAt).getTime() < t);
  const next = list.slice();
  next.splice(at === -1 ? next.length : at, 0, r);
  return next.slice(0, MAX_REQUESTS);
}

/** Applies one stream event to the TanStack Query cache. subdomain.deleted is reported through onDeleted. */
export function applyStreamEvent(qc: QueryClient, slug: string, ev: StreamEvent, onDeleted?: () => void): void {
  const patchSub = (fn: (s: Subdomain) => Subdomain) => qc.setQueryData<Subdomain>(qk.sub(slug), (s) => (s ? fn(s) : s));
  switch (ev.type) {
    case 'hello':
      qc.setQueryData(qk.sub(slug), ev.data);
      break;
    case 'request.created':
      qc.setQueryData<RequestSummary[]>(qk.requests(slug), (l) => upsertRequest(l ?? [], ev.data));
      patchSub((s) => ({ ...s, lastActivityAt: ev.data.receivedAt, state: 'active' }));
      break;
    case 'request.updated':
      qc.setQueryData<RequestSummary[]>(qk.requests(slug), (l) => upsertRequest(l ?? [], ev.data));
      qc.invalidateQueries({ queryKey: qk.request(ev.data.id) });
      break;
    case 'request.deleted':
      qc.setQueryData<RequestSummary[]>(qk.requests(slug), (l) => (l ?? []).filter((x) => x.id !== ev.data.id));
      qc.removeQueries({ queryKey: qk.request(ev.data.id) });
      break;
    case 'tunnel.status':
      patchSub((s) => ({ ...s, tunnelOnline: ev.data.online }));
      qc.setQueryData(qk.tunnel(slug), ev.data.online ? ev.data.target : null);
      break;
    case 'mock.updated':
      patchSub((s) => ({ ...s, mock: ev.data }));
      break;
    case 'subdomain.state':
      patchSub((s) => ({
        ...s,
        state: ev.data.state,
        hardExpiresAt: ev.data.hardExpiresAt,
        lastActivityAt: ev.data.state === 'active' ? new Date().toISOString() : s.lastActivityAt,
      }));
      break;
    case 'subdomain.deleted':
      onDeleted?.();
      break;
  }
}

export function updateDetailReplays(qc: QueryClient, id: string, fn: (d: RequestDetail) => RequestDetail): void {
  qc.setQueryData<RequestDetail>(qk.request(id), (d) => (d ? fn(d) : d));
}
