import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiBase } from '../../lib/api';
import type { RequestSummary, StreamEvent, Subdomain } from '../../lib/types';
import { DashContext } from '../ctx';
import { applyStreamEvent, qk } from '../live';
import { ReplayBar, replayErrorMessage, type ReplayTarget } from '../ReplayBar';
import { RequestList } from '../RequestList';
import { ApiError } from '../../lib/api';

const SLUG = 'abc12345';

const req = (id: string, over: Partial<RequestSummary> = {}): RequestSummary => ({
  id, method: 'POST', path: `/hook/${id}`, receivedAt: new Date().toISOString(), bodySize: 12, contentType: 'application/json', sourceIp: '1.2.3.4',
  answeredBy: 'offline', responseStatus: null, latencyMs: null, isPreflight: false, mocked: false, forwardError: null, signature: 'not_configured', bodyPreview: '{"a":1}', ...over,
});

const sub = (over: Partial<Subdomain> = {}): Subdomain => ({
  slug: SLUG, url: `https://${SLUG}.nanana.lat`, dashboardUrl: `https://${SLUG}.tools.nanana.lat`, isCustom: false, ownerId: null, state: 'active',
  lastActivityAt: new Date().toISOString(), hardExpiresAt: new Date(Date.now() + 6 * 864e5).toISOString(), offlineStatus: 200, offlineBody: '{"ok":true}', hmac: null, tunnelOnline: false, mock: null, ...over,
});

function wrap(qc: QueryClient, children: ReactNode) {
  return (
    <QueryClientProvider client={qc}>
      <DashContext.Provider value={{ slug: SLUG, token: 'nnt_test', base: 'nanana.lat', apex: 'https://nanana.lat' }}>{children}</DashContext.Provider>
    </QueryClientProvider>
  );
}

function LiveList({ onSelect = () => undefined }: { onSelect?: (id: string) => void }) {
  const q = useQuery<RequestSummary[]>({ queryKey: qk.requests(SLUG), queryFn: () => [], staleTime: Infinity });
  return <RequestList requests={q.data ?? []} selectedId={null} onSelect={onSelect} empty={<p>empty state</p>} />;
}

// TanStack Query notifies observers on a timer, so flush it inside act().
const emit = (qc: QueryClient, ev: StreamEvent) =>
  act(async () => {
    applyStreamEvent(qc, SLUG, ev);
    await new Promise((r) => setTimeout(r, 5));
  });

describe('RequestList with live stream events', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.requests(SLUG), []);
    qc.setQueryData(qk.sub(SLUG), sub());
  });

  it('shows the empty state, then renders and updates rows as events arrive', async () => {
    render(wrap(qc, <LiveList />));
    expect(screen.getByText('empty state')).toBeInTheDocument();

    await emit(qc, { type: 'request.created', data: req('a') });
    const row = await screen.findByRole('button', { name: /^POST\s*\/hook\/a/ });
    expect(row).toHaveTextContent('...'); // response pending
    expect(screen.getByText('Latest request: POST /hook/a')).toBeInTheDocument();

    await emit(qc, { type: 'request.updated', data: req('a', { responseStatus: 200, answeredBy: 'tunnel', latencyMs: 31, signature: 'pass' }) });
    expect(screen.getByRole('button', { name: /^POST\s*\/hook\/a/ })).toHaveTextContent('200');
    expect(screen.getByText('Signature valid')).toBeInTheDocument();
    expect(screen.getByText('Answered by your tunnel')).toBeInTheDocument();

    await emit(qc, { type: 'request.created', data: req('b', { method: 'GET', receivedAt: new Date(Date.now() + 1000).toISOString() }) });
    const items = within(screen.getByRole('list', { name: 'Captured requests' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('/hook/b'); // newest first

    await emit(qc, { type: 'request.deleted', data: { id: 'a' } });
    expect(screen.queryByRole('button', { name: /^POST\s*\/hook\/a/ })).not.toBeInTheDocument();
  });

  it('hides preflights by default and filters by text', async () => {
    qc.setQueryData(qk.requests(SLUG), [req('p', { method: 'OPTIONS', isPreflight: true, answeredBy: 'preflight', responseStatus: 204 }), req('q', { path: '/pay' }), req('r', { method: 'GET', path: '/health' })]);
    const user = userEvent.setup();
    render(wrap(qc, <LiveList />));
    expect(screen.queryByRole('button', { name: /^OPTIONS\s*\/hook\/p/ })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Preflights/));
    expect(screen.getByRole('button', { name: /^OPTIONS\s*\/hook\/p/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Filter requests/), 'get');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^GET\s*\/health/ })).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/Filter requests/));
    await user.type(screen.getByLabelText(/Filter requests/), 'zzz');
    expect(screen.getByText('No requests match this filter.')).toBeInTheDocument();
  });

  it('calls onSelect, escapes payload text and never injects HTML', async () => {
    const evil = '/<img src=x onerror=alert(1)>';
    qc.setQueryData(qk.requests(SLUG), [req('x', { path: evil })]);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { container } = render(wrap(qc, <LiveList onSelect={onSelect} />));
    expect(container.querySelector('img')).toBeNull();
    await user.click(screen.getByRole('button', { name: (n: string) => n.replace(/\s+/g, '').startsWith(`POST${evil}`.replace(/\s+/g, '')) }));
    expect(onSelect).toHaveBeenCalledWith('x');
  });

  it('applyStreamEvent keeps sub state in sync (tunnel, mock, state, deleted)', () => {
    const onDeleted = vi.fn();
    applyStreamEvent(qc, SLUG, { type: 'tunnel.status', data: { online: true, target: 'localhost:3000' } });
    applyStreamEvent(qc, SLUG, { type: 'mock.updated', data: { status: 500, remaining: 2 } });
    applyStreamEvent(qc, SLUG, { type: 'subdomain.state', data: { state: 'cold', hardExpiresAt: '2030-01-01T00:00:00.000Z' } });
    expect(qc.getQueryData<Subdomain>(qk.sub(SLUG))).toMatchObject({ tunnelOnline: true, mock: { status: 500, remaining: 2 }, state: 'cold', hardExpiresAt: '2030-01-01T00:00:00.000Z' });
    expect(qc.getQueryData(qk.tunnel(SLUG))).toBe('localhost:3000');
    applyStreamEvent(qc, SLUG, { type: 'mock.updated', data: null });
    expect(qc.getQueryData<Subdomain>(qk.sub(SLUG))!.mock).toBeNull();
    applyStreamEvent(qc, SLUG, { type: 'subdomain.deleted', data: {} }, onDeleted);
    expect(onDeleted).toHaveBeenCalled();
  });

  it('caps the list at 100 requests', () => {
    for (let i = 0; i < 105; i++) applyStreamEvent(qc, SLUG, { type: 'request.created', data: req(`r${i}`, { receivedAt: new Date(Date.now() + i).toISOString() }) });
    expect(qc.getQueryData<RequestSummary[]>(qk.requests(SLUG))).toHaveLength(100);
  });
});

function BarHarness({ tunnelOnline, initial = { kind: 'url', url: '' } }: { tunnelOnline: boolean; initial?: ReplayTarget }) {
  const [t, setT] = useState<ReplayTarget>(initial);
  return <ReplayBar requestId="req-1" tunnelOnline={tunnelOnline} target={t} setTarget={(p) => setT({ ...t, ...p })} />;
}

describe('ReplayBar', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => setApiBase('http://api.test'));
  afterEach(() => {
    globalThis.fetch = origFetch;
    setApiBase(null);
  });
  const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  it('disables "My tunnel" with a tooltip hint when the tunnel is offline', () => {
    render(wrap(qc(), <BarHarness tunnelOnline={false} />));
    const radio = screen.getByRole('radio', { name: 'My tunnel' });
    expect(radio).toBeDisabled();
    expect(radio.closest('label')).toHaveAttribute('title', expect.stringContaining('nanana -t=nnt_test -p=3000'));
    expect(screen.getByRole('radio', { name: 'Public URL' })).toBeChecked();
  });

  it('enables the tunnel target when online and allows replaying through it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'r1', requestId: 'req-1', targetType: 'tunnel', targetUrl: null, status: 201, responseHeaders: null, responseBody: null, error: null, durationMs: 12, createdAt: new Date().toISOString() }), { status: 201 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(wrap(qc(), <BarHarness tunnelOnline initial={{ kind: 'tunnel', url: '' }} />));
    expect(screen.getByRole('radio', { name: 'My tunnel' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /Replay/ }));
    expect(await screen.findByText(/in 12 ms/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/requests/req-1/replay');
    expect(JSON.parse(init.body as string)).toEqual({ target: { type: 'tunnel' } });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer nnt_test');
  });

  it('validates the URL before enabling Replay and sends header overrides', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'url_blocked', message: 'blocked' } }), { status: 400 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(wrap(qc(), <BarHarness tunnelOnline={false} />));
    const btn = screen.getByRole('button', { name: /Replay/ });
    expect(btn).toBeDisabled();
    await user.type(screen.getByLabelText('Replay target URL'), 'ftp://x');
    expect(btn).toBeDisabled();
    await user.clear(screen.getByLabelText('Replay target URL'));
    await user.type(screen.getByLabelText('Replay target URL'), 'http://127.0.0.1/hook');
    expect(btn).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /^Headers/ }));
    await user.click(screen.getByRole('button', { name: /Add header/ }));
    await user.type(screen.getByLabelText('Override header name 1'), 'x-test');
    await user.type(screen.getByLabelText('Override header value 1'), 'yes');
    await user.click(btn);
    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked/i);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ target: { type: 'url', url: 'http://127.0.0.1/hook' }, overrideHeaders: { 'x-test': 'yes' } });
  });

  it('remembers the replay URL per slug in localStorage when it is valid', async () => {
    const user = userEvent.setup();
    const { useReplayTarget } = await import('../ReplayBar');
    function H() {
      const [t, set] = useReplayTarget(SLUG, false);
      return <input aria-label="u" value={t.url} onChange={(e) => set({ url: e.target.value })} />;
    }
    render(<H />);
    await user.type(screen.getByLabelText('u'), 'https://staging.example.com/h');
    expect(localStorage.getItem(`nanana:replay-url:${SLUG}`)).toBe('https://staging.example.com/h');
  });
});

describe('replayErrorMessage', () => {
  it('maps API errors to friendly text', () => {
    expect(replayErrorMessage(new ApiError(400, 'url_blocked', 'x'))).toMatch(/blocked.*tunnel/i);
    expect(replayErrorMessage(new ApiError(409, 'tunnel_offline', 'x'))).toMatch(/not connected/i);
    expect(replayErrorMessage(new ApiError(429, 'rate_limited', 'x', 7))).toMatch(/7s/);
    expect(replayErrorMessage(new ApiError(500, 'boom', 'kaput'))).toBe('kaput');
  });
});
