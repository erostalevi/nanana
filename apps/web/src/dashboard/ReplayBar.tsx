import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Notice } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { lsGet, lsSet, replayUrlKey, validateHttpUrl } from '../lib/storage';
import type { Replay } from '../lib/types';
import { StatusChip } from './badges';
import { tunnelCommand, useDash } from './ctx';
import { qk, updateDetailReplays } from './live';

export type ReplayTarget = { kind: 'tunnel' | 'url'; url: string };

export function useReplayTarget(slug: string, tunnelOnline: boolean): [ReplayTarget, (t: Partial<ReplayTarget>) => void] {
  const [kind, setKind] = useState<'tunnel' | 'url'>(tunnelOnline ? 'tunnel' : 'url');
  const [url, setUrl] = useState(() => lsGet(replayUrlKey(slug)) ?? '');
  const effective = kind === 'tunnel' && !tunnelOnline ? 'url' : kind;
  return [
    { kind: effective, url },
    (t) => {
      if (t.kind) setKind(t.kind);
      if (t.url !== undefined) {
        setUrl(t.url);
        if (t.url && !validateHttpUrl(t.url)) lsSet(replayUrlKey(slug), t.url);
      }
    },
  ];
}

export function replayErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400 && e.code === 'url_blocked') return 'That URL is blocked: server-side replay only reaches public hosts. To hit localhost or a LAN address, replay through your tunnel instead.';
    if (e.status === 409 && e.code === 'tunnel_offline') return 'Your tunnel is not connected. Start the CLI and try again.';
    if (e.status === 429) return `Replay rate limit reached${e.retryAfter ? `, try again in ${e.retryAfter}s` : ''}.`;
  }
  return errorMessage(e);
}

export function ReplayBar({ requestId, tunnelOnline, target, setTarget, onDone }: { requestId: string; tunnelOnline: boolean; target: ReplayTarget; setTarget: (t: Partial<ReplayTarget>) => void; onDone?: (r: Replay) => void }) {
  const ctx = useDash();
  const qc = useQueryClient();
  const [overrides, setOverrides] = useState<{ k: string; v: string }[]>([]);
  const [showHeaders, setShowHeaders] = useState(false);
  const [touched, setTouched] = useState(false);
  const urlError = target.kind === 'url' ? validateHttpUrl(target.url) : null;

  const m = useMutation<Replay, unknown>({
    mutationFn: () => {
      const overrideHeaders: Record<string, string> = {};
      for (const { k, v } of overrides) if (k.trim()) overrideHeaders[k.trim()] = v;
      return api<Replay>(`/requests/${requestId}/replay`, {
        method: 'POST',
        token: ctx.token,
        body: {
          target: target.kind === 'tunnel' ? { type: 'tunnel' } : { type: 'url', url: target.url.trim() },
          ...(Object.keys(overrideHeaders).length ? { overrideHeaders } : {}),
        },
      });
    },
    onSuccess: (r) => {
      updateDetailReplays(qc, requestId, (d) => ({ ...d, replays: [r, ...d.replays.filter((x) => x.id !== r.id)] }));
      void qc.invalidateQueries({ queryKey: qk.request(requestId) });
      onDone?.(r);
    },
  });
  useEffect(() => m.reset(), [requestId]); // eslint-disable-line react-hooks/exhaustive-deps

  const tunnelHint = `Tunnel not connected. Run: ${tunnelCommand(ctx)}`;
  const result = m.data;
  return (
    <form
      className="space-y-2 rounded-lg border border-line bg-panel p-3"
      aria-label="Replay request"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!urlError) m.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="flex items-center gap-1" aria-label="Replay target">
          <label title={tunnelOnline ? 'Send through your connected CLI tunnel' : tunnelHint} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm ${target.kind === 'tunnel' ? 'border-accent bg-accent/10' : 'border-line'} ${tunnelOnline ? '' : 'opacity-50'}`}>
            <input type="radio" name="replay-target" value="tunnel" checked={target.kind === 'tunnel'} disabled={!tunnelOnline} onChange={() => setTarget({ kind: 'tunnel' })} className="accent-[rgb(var(--accent))]" />
            My tunnel
          </label>
          <label className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm ${target.kind === 'url' ? 'border-accent bg-accent/10' : 'border-line'}`}>
            <input type="radio" name="replay-target" value="url" checked={target.kind === 'url'} onChange={() => setTarget({ kind: 'url' })} className="accent-[rgb(var(--accent))]" />
            Public URL
          </label>
        </fieldset>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showHeaders} onClick={() => setShowHeaders(!showHeaders)}>
          Headers{overrides.length ? ` (${overrides.length})` : ''}
        </button>
        <button type="submit" className="btn btn-primary ml-auto" disabled={m.isPending || (target.kind === 'url' && !!urlError) || (target.kind === 'tunnel' && !tunnelOnline)}>
          <Play size={14} aria-hidden /> {m.isPending ? 'Replaying...' : 'Replay'}
        </button>
      </div>
      {target.kind === 'url' && (
          <div>
            <label htmlFor="replay-url" className="sr-only">Replay target URL</label>
            <input
              id="replay-url"
              className="input font-mono"
              placeholder="https://staging.example.com/webhook"
              value={target.url}
              onChange={(e) => setTarget({ url: e.target.value })}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && !!urlError}
              aria-describedby={touched && urlError ? 'replay-url-err' : undefined}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
      {!tunnelOnline && target.kind === 'url' && <p className="text-xs text-faint">My tunnel is disabled: <code>{tunnelCommand(ctx)}</code> to connect.</p>}
      {touched && urlError && <p id="replay-url-err" className="text-xs text-bad">{urlError}</p>}
      {showHeaders && (
        <div className="space-y-1.5" aria-label="Header overrides">
          <p className="text-xs text-faint">Override or add headers for this replay.</p>
          {overrides.map((o, i) => (
            <div key={i} className="flex gap-1.5">
              <input aria-label={`Override header name ${i + 1}`} className="input w-2/5 font-mono" placeholder="x-header" value={o.k} onChange={(e) => setOverrides(overrides.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
              <input aria-label={`Override header value ${i + 1}`} className="input flex-1 font-mono" placeholder="value" value={o.v} onChange={(e) => setOverrides(overrides.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove override ${i + 1}`} onClick={() => setOverrides(overrides.filter((_, j) => j !== i))}><X size={14} aria-hidden /></button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setOverrides([...overrides, { k: '', v: '' }])}><Plus size={12} aria-hidden /> Add header</button>
        </div>
      )}
      <div aria-live="polite">
        {m.isError && <Notice tone="error">{replayErrorMessage(m.error)}</Notice>}
        {result && !m.isPending && (
          result.error ? (
            <Notice tone="warn">Replay failed to reach the target: {result.error} ({result.durationMs} ms)</Notice>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">Replay result: <StatusChip status={result.status} /> in {result.durationMs} ms</p>
          )
        )}
      </div>
    </form>
  );
}
