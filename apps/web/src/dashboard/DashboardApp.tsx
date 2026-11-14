import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Logo, Spinner } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { ApiError, api, errorMessage, getApiBase } from '../lib/api';
import { clearStoredToken, consumeFragmentToken } from '../lib/token';
import { startStream, type StreamStatus } from '../lib/sse';
import type { RequestSummary, Subdomain } from '../lib/types';
import { DashContext, useDash as useDashCtx, type DashCtx } from './ctx';
import { DeleteEndpointDialog, MockDialog, SettingsDialog } from './dialogs';
import { DetailPane } from './DetailPane';
import { EmptyState } from './EmptyState';
import { Header } from './Header';
import { applyStreamEvent, qk } from './live';
import { RequestList } from './RequestList';

function useIsDesktop(): boolean {
  const q = '(min-width: 1024px)';
  const [m, set] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(q).matches : true));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(q);
    const h = () => set(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return m;
}

function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-4 py-3"><Logo size="sm" /><ThemeToggle /></header>
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-4 pb-24">
        <h1 className="mb-3 text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="space-y-4 text-sm leading-6 text-muted">{children}</div>
      </main>
    </div>
  );
}

function Gone({ apex, why }: { apex: string; why: 'expired' | 'deleted' | 'missing' }) {
  return (
    <Screen title={why === 'deleted' ? 'This endpoint was deleted' : 'This endpoint expired'}>
      <p>{why === 'missing' ? "This endpoint doesn't exist, or it has already expired." : 'Endpoints vanish after 24 h without activity or 7 days at most. Captured requests were deleted with it.'}</p>
      <p><a className="btn btn-primary" href={apex}>Create a new endpoint</a></p>
    </Screen>
  );
}

function NeedAccess({ apex, hadToken }: { apex: string; hadToken: boolean }) {
  return (
    <Screen title={hadToken ? 'That token was not accepted' : 'You need the dashboard link'}>
      <p>{hadToken ? 'The token for this endpoint is no longer valid (it may have been rotated), or you are not the owner.' : 'This dashboard needs the full link with the token (it ends in #t=nnt_...), or you can sign in as the owner of this endpoint.'}</p>
      <p><a className="btn btn-primary" href={`${apex}/login`}>Sign in as the owner</a></p>
      <p className="text-xs text-faint">The token lives after the # in the URL, so it is never sent to any server. Lost it? Endpoints without an account cannot be recovered.</p>
    </Screen>
  );
}

export function DashboardApp({ slug, base, apex }: { slug: string; base: string; apex: string }) {
  const [token] = useState(() => consumeFragmentToken(slug));
  // Pasting a full dashboard link (with #t=...) into a tab that already shows this dashboard only changes the
  // hash, which does not reload the page: reload so the new token is picked up and stripped.
  useEffect(() => {
    const onHash = () => {
      if (/(^|[#&])t=nn[ta]_/.test(window.location.hash)) window.location.reload();
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const ctx = useMemo<DashCtx>(() => ({ slug, token, base, apex }), [slug, token, base, apex]);
  const subQ = useQuery<Subdomain, ApiError>({
    queryKey: qk.sub(slug),
    queryFn: () => api<Subdomain>(`/subdomains/${slug}`, { token }),
    staleTime: Infinity,
    retry: (n, e) => !(e instanceof ApiError && [401, 403, 404].includes(e.status)) && n < 2,
  });
  const [gone, setGone] = useState<null | 'expired' | 'deleted' | 'missing'>(null);
  const [denied, setDenied] = useState(false);
  const onDenied = useCallback(() => setDenied(true), []);

  useEffect(() => {
    if (subQ.error instanceof ApiError) {
      if (subQ.error.status === 404) setGone('missing');
      else if (subQ.error.status === 401 || subQ.error.status === 403) {
        if (token) clearStoredToken(slug);
        setDenied(true);
      }
    }
  }, [subQ.error, token, slug]);

  if (gone) return <Gone apex={apex} why={gone} />;
  if (denied) return <NeedAccess apex={apex} hadToken={!!token} />;
  if (subQ.isError) return <Screen title="Could not load this dashboard"><p>{errorMessage(subQ.error)}</p><p><button className="btn" onClick={() => void subQ.refetch()}>Try again</button></p></Screen>;
  if (!subQ.data) return <div className="grid min-h-screen place-items-center"><Spinner label="Loading dashboard" /></div>;

  return (
    <DashContext.Provider value={ctx}>
      <Dashboard sub={subQ.data} onGone={setGone} onDenied={onDenied} />
    </DashContext.Provider>
  );
}

function Dashboard({ sub, onGone, onDenied }: { sub: Subdomain; onGone: (w: 'expired' | 'deleted') => void; onDenied: () => void }) {
  const ctx = useDashCtx();
  const qc = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'settings' | 'mock' | 'delete'>(null);
  const isDesktop = useIsDesktop();

  const reqQ = useQuery({
    queryKey: qk.requests(ctx.slug),
    queryFn: async () => (await api<{ requests: RequestSummary[] }>(`/subdomains/${ctx.slug}/requests?limit=100&includePreflight=true`, { token: ctx.token })).requests,
    staleTime: Infinity,
  });
  const requests = reqQ.data ?? [];
  const tunnelTarget = useQuery<string | null>({ queryKey: qk.tunnel(ctx.slug), queryFn: () => null, enabled: false, initialData: null }).data;

  useEffect(() => {
    // Opening the stream is also "dashboard activity" server-side. The URL carries no token: it goes in a header.
    return startStream({
      url: `${getApiBase()}/subdomains/${ctx.slug}/stream`,
      token: ctx.token,
      onEvent: (ev) => applyStreamEvent(qc, ctx.slug, ev, () => onGone('expired')),
      onStatus: setStatus,
      onReconnect: () => {
        void qc.invalidateQueries({ queryKey: qk.requests(ctx.slug) });
        void qc.invalidateQueries({ queryKey: qk.sub(ctx.slug) });
      },
      onFatal: (s) => (s === 404 ? onGone('expired') : onDenied()),
    });
  }, [ctx.slug, ctx.token, qc, onGone, onDenied]);

  // Desktop: show the newest request by default.
  useEffect(() => {
    if (isDesktop && selected === null && requests[0]) setSelected(requests[0].id);
  }, [isDesktop, selected, requests]);

  const selectedReq = requests.find((r) => r.id === selected) ?? null;
  const onDeletedRequest = useCallback(() => setSelected(null), []);

  return (
    <div className="flex h-screen flex-col">
      <Header sub={sub} tunnelTarget={tunnelTarget} status={status} onSettings={() => setDialog('settings')} onMock={() => setDialog('mock')} onDelete={() => setDialog('delete')} />
      {sub.readOnly && (
        <div role="alert" className="border-b border-bad/40 bg-bad/10 px-4 py-2.5 text-sm text-fg" data-testid="read-only-banner">
          <strong className="text-bad">This endpoint is read-only.</strong> New requests are not being captured because the owner&apos;s Pro plan lapsed (senders get 402). Existing captures stay visible. If you own it, resubscribe from your <a className="link" href={`${ctx.apex}/account`}>account</a> to resume capturing.
        </div>
      )}
      <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(340px,420px)_1fr]">
        <section aria-label="Requests" className={`min-h-0 min-w-0 flex-col border-r border-line ${selectedReq ? 'hidden lg:flex' : 'flex'}`}>
          {reqQ.isLoading ? <div className="p-6"><Spinner label="Loading requests" /></div> : reqQ.isError ? <p className="p-6 text-sm text-bad">Could not load requests: {errorMessage(reqQ.error)}</p> : (
            <RequestList requests={requests} selectedId={selected} onSelect={setSelected} empty={<EmptyState url={sub.url} />} />
          )}
        </section>
        <section aria-label="Request details" className={`min-h-0 min-w-0 flex-col ${selectedReq ? 'flex' : 'hidden lg:flex'}`}>
          {selectedReq ? (
            <DetailPane key={selectedReq.id} summary={selectedReq} sub={sub} onBack={() => setSelected(null)} onDeleted={onDeletedRequest} />
          ) : (
            <div className="grid flex-1 place-items-center p-8 text-center text-sm text-faint">{requests.length ? 'Select a request to inspect it.' : 'Nothing to inspect yet.'}</div>
          )}
        </section>
      </main>
      {dialog === 'settings' && <SettingsDialog sub={sub} onClose={() => setDialog(null)} />}
      {dialog === 'mock' && <MockDialog sub={sub} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteEndpointDialog sub={sub} onClose={() => setDialog(null)} onDeleted={() => onGone('deleted')} />}
    </div>
  );
}
