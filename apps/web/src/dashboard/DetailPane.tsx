import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Terminal, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CopyButton, Notice, Spinner, Tabs } from '../components/ui';
import { parseQuery } from '../lib/body';
import { api, errorMessage } from '../lib/api';
import { buildCurl } from '../lib/curl';
import { formatBytes, relativeTime } from '../lib/time';
import type { Replay, RequestDetail, RequestSummary, Subdomain } from '../lib/types';
import { useNow } from '../lib/useNow';
import { AnsweredIcon, MethodBadge, SigDot, StatusChip, sigLabel } from './badges';
import { BodyViewer, KvTable, headerRows, headerValue } from './BodyViewer';
import { useDash } from './ctx';
import { qk } from './live';
import { ReplayBar, useReplayTarget } from './ReplayBar';

type TabId = 'request' | 'response' | 'signature' | 'replays';

/** URL used by "Copy as curl": the picked replay target, else the original public URL + path. */
export function curlTargetUrl(path: string, publicUrl: string, target: { kind: 'tunnel' | 'url'; url: string }, tunnelTarget: string | null): string {
  if (target.kind === 'url' && target.url.trim()) return target.url.trim();
  if (target.kind === 'tunnel' && tunnelTarget) {
    const origin = /^https?:\/\//.test(tunnelTarget) ? tunnelTarget : `http://${tunnelTarget}`;
    return origin.replace(/\/+$/, '') + path;
  }
  return publicUrl.replace(/\/+$/, '') + path;
}

export function DetailPane({ summary, sub, onBack, onDeleted }: { summary: RequestSummary; sub: Subdomain; onBack: () => void; onDeleted: () => void }) {
  const ctx = useDash();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('request');
  const [target, setTarget] = useReplayTarget(ctx.slug, sub.tunnelOnline);
  const now = useNow(5000);
  const tunnelTarget = useQuery<string | null>({ queryKey: qk.tunnel(ctx.slug), queryFn: () => null, enabled: false, initialData: null }).data;

  const q = useQuery({ queryKey: qk.request(summary.id), queryFn: () => api<RequestDetail>(`/requests/${summary.id}`, { token: ctx.token }), staleTime: 60_000 });
  useEffect(() => setTab('request'), [summary.id]);

  const del = useMutation({
    mutationFn: () => api(`/requests/${summary.id}`, { method: 'DELETE', token: ctx.token }),
    onSuccess: () => {
      qc.setQueryData<RequestSummary[]>(qk.requests(ctx.slug), (l) => (l ?? []).filter((x) => x.id !== summary.id));
      onDeleted();
    },
  });

  const d = q.data;
  const curl = useMemo(() => {
    if (!d) return () => '';
    return () => buildCurl({ method: d.method, url: curlTargetUrl(d.path, sub.url, target, tunnelTarget), headers: d.headers, body: d.body });
  }, [d, sub.url, target, tunnelTarget]);
  const curlUrl = d ? curlTargetUrl(d.path, sub.url, target, tunnelTarget) : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-ghost btn-sm lg:hidden" onClick={onBack}><ArrowLeft size={14} aria-hidden /> Requests</button>
          <MethodBadge method={summary.method} />
          <h2 className="order-last min-w-0 basis-full truncate font-mono text-sm sm:order-none sm:basis-0 sm:flex-1" title={summary.path}>{summary.path}</h2>
          <CopyButton getText={curl} label="Copy as curl" className={d ? '' : 'pointer-events-none opacity-50'} />
          <button type="button" className="btn btn-sm btn-danger" onClick={() => del.mutate()} disabled={del.isPending} aria-label="Delete this request"><Trash2 size={14} aria-hidden /><span className="hidden sm:inline">Delete</span></button>
        </div>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
          <time dateTime={summary.receivedAt} title={new Date(summary.receivedAt).toLocaleString()}>{relativeTime(summary.receivedAt, now)}</time>
          <span>{summary.sourceIp}</span>
          <span>{formatBytes(summary.bodySize)}</span>
          {summary.contentType && <span className="font-mono">{summary.contentType}</span>}
          <span className="inline-flex items-center gap-1"><AnsweredIcon by={summary.answeredBy} /> {summary.answeredBy}</span>
          <StatusChip status={summary.responseStatus} />
          {summary.latencyMs != null && <span>{summary.latencyMs} ms</span>}
          <span className="inline-flex items-center gap-1"><SigDot sig={summary.signature} /> {sigLabel(summary.signature)}</span>
        </p>
        {del.isError && <Notice tone="error">{errorMessage(del.error)}</Notice>}
        <ReplayBar requestId={summary.id} tunnelOnline={sub.tunnelOnline} target={target} setTarget={setTarget} onDone={() => setTab('replays')} />
        {d && <p className="truncate font-mono text-[11px] text-faint" title={curlUrl}>curl target: {curlUrl}</p>}
      </div>
      <Tabs
        label="Request details"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'request', label: 'Request' },
          { id: 'response', label: 'Response' },
          { id: 'signature', label: 'Signature', badge: <SigDot sig={d?.signatureDetail.state ?? summary.signature} /> },
          { id: 'replays', label: 'Replays', badge: d && d.replays.length ? <span className="chip bg-raised text-muted">{d.replays.length}</span> : null },
        ]}
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto p-3">
        {q.isLoading && <Spinner label="Loading request" />}
        {q.isError && <Notice tone="error">Could not load this request: {errorMessage(q.error)}</Notice>}
        {d && tab === 'request' && <RequestTab d={d} />}
        {d && tab === 'response' && <ResponseTab d={d} />}
        {d && tab === 'signature' && <SignatureTab d={d} />}
        {d && tab === 'replays' && <ReplaysTab replays={d.replays} />}
      </div>
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wider text-faint">{title}</h3>{aside}</div>
      {children}
    </section>
  );
}

function RequestTab({ d }: { d: RequestDetail }) {
  const { pathname, pairs } = parseQuery(d.path);
  return (
    <>
      {pairs.length > 0 && (
        <Section title="Query string">
          <p className="mb-2 font-mono text-xs text-muted">{pathname}</p>
          <KvTable rows={pairs} />
        </Section>
      )}
      <Section title={`Headers (${headerRows(d.headers).length})`}><KvTable rows={headerRows(d.headers)} empty="No headers." /></Section>
      <Section title="Body"><BodyViewer body={d.body} contentType={headerValue(d.headers, 'content-type') ?? d.contentType} /></Section>
    </>
  );
}

function ResponseTab({ d }: { d: RequestDetail }) {
  if (d.responseStatus == null && !d.responseHeaders && !d.responseBody) {
    return <p className="text-sm text-faint">{d.isPreflight ? 'This CORS preflight was answered automatically with a 204.' : 'Waiting for the response to be recorded...'}</p>;
  }
  return (
    <>
      <Section title="What we sent back">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Status</dt><dd><StatusChip status={d.responseStatus} /></dd>
          <dt className="text-muted">Answered by</dt><dd className="inline-flex items-center gap-1"><AnsweredIcon by={d.answeredBy} /> {d.answeredBy}{d.mocked ? ' (mock rule)' : ''}</dd>
          {d.latencyMs != null && (<><dt className="text-muted">Latency</dt><dd>{d.latencyMs} ms</dd></>)}
          {d.forwardError && (<><dt className="text-muted">Forward error</dt><dd className="font-mono text-bad">{d.forwardError}</dd></>)}
        </dl>
      </Section>
      <Section title="Response headers"><KvTable rows={headerRows(d.responseHeaders)} empty="No headers recorded." /></Section>
      <Section title="Response body">
        <BodyViewer body={d.responseBody} contentType={headerValue(d.responseHeaders, 'content-type')} emptyLabel="Empty response body." />
        {d.responseBody?.truncated && <p className="mt-2 text-xs text-faint">Stored response was truncated (only the first 1 MB is kept; the sender got the full response).</p>}
      </Section>
    </>
  );
}

function SignatureTab({ d }: { d: RequestDetail }) {
  const s = d.signatureDetail;
  const copy = (label: string, v: string | null) => (
    <div>
      <div className="mb-1 flex items-center justify-between"><span className="text-xs text-muted">{label}</span>{v && <CopyButton text={v} />}</div>
      <p className="break-all rounded-lg border border-line bg-bg p-2 font-mono text-[12.5px]">{v ?? '(none)'}</p>
    </div>
  );
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm"><SigDot sig={s.state} /> <strong>{sigLabel(s.state)}</strong></p>
      {s.state === 'not_configured' && <p className="text-sm text-muted">Set an HMAC secret and header name in Settings to verify signatures on every request (existing captures are re-checked too).</p>}
      {s.state === 'header_missing' && <p className="text-sm text-muted">The request did not include the configured signature header{s.header ? <> (<code>{s.header}</code>)</> : null}.</p>}
      {s.state !== 'not_configured' && (
        <>
          <div><span className="text-xs text-muted">Header</span><p className="font-mono text-sm">{s.header ?? '(none)'}</p></div>
          {copy('Received', s.received)}
          {copy('Expected (computed over the raw body)', s.expected)}
        </>
      )}
    </div>
  );
}

function ReplaysTab({ replays }: { replays: Replay[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow(5000);
  if (!replays.length) return <p className="text-sm text-faint">No replays yet. Pick a target above and hit Replay.</p>;
  return (
    <ul className="space-y-2">
      {replays.map((r) => (
        <li key={r.id} className="rounded-lg border border-line">
          <button type="button" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-raised">
            <StatusChip status={r.status} />
            <span className="inline-flex items-center gap-1 text-muted">{r.targetType === 'tunnel' ? <><Terminal size={13} aria-hidden /> tunnel</> : <span className="max-w-[16rem] truncate font-mono text-xs" title={r.targetUrl ?? ''}>{r.targetUrl}</span>}</span>
            <span className="text-xs text-faint">{r.durationMs} ms</span>
            <span className="ml-auto text-xs text-faint">{relativeTime(r.createdAt, now)}</span>
            {r.error && <span className="w-full text-xs text-bad">Error: {r.error}</span>}
          </button>
          {open === r.id && (
            <div className="space-y-3 border-t border-line p-3">
              <Section title="Response headers"><KvTable rows={headerRows(r.responseHeaders)} empty="No headers." /></Section>
              <Section title="Response body"><BodyViewer body={r.responseBody} contentType={headerValue(r.responseHeaders, 'content-type')} emptyLabel={r.error ? 'No response (see error).' : 'Empty response body.'} /></Section>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
