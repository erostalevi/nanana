import { Search } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';
import { useNow } from '../lib/useNow';
import { formatBytes, relativeTime } from '../lib/time';
import type { RequestSummary } from '../lib/types';
import { AnsweredIcon, MethodBadge, SigDot, StatusChip } from './badges';

const Row = memo(function Row({ r, selected, now, fresh, onSelect }: { r: RequestSummary; selected: boolean; now: number; fresh: boolean; onSelect: (id: string) => void }) {
  return (
    <li className={fresh ? 'animate-slidein' : undefined}>
      <button
        type="button"
        onClick={() => onSelect(r.id)}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${r.method} ${r.path}`}
        className={`flex w-full flex-col gap-1 border-b border-line px-3 py-2.5 text-left transition hover:bg-raised ${selected ? 'bg-raised shadow-[inset_3px_0_0_rgb(var(--accent))]' : ''} ${r.isPreflight ? 'opacity-70' : ''}`}
      >
        <span className="flex items-center gap-2">
          <MethodBadge method={r.method} />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={r.path}>{r.path}</span>
          <SigDot sig={r.signature} />
          <StatusChip status={r.responseStatus} pending={!r.isPreflight} />
        </span>
        <span className="flex items-center gap-2 pl-16 text-xs text-faint">
          <AnsweredIcon by={r.answeredBy} />
          <time dateTime={r.receivedAt}>{relativeTime(r.receivedAt, now)}</time>
          <span aria-hidden>·</span>
          <span>{formatBytes(r.bodySize)}</span>
          {r.latencyMs != null && (
            <>
              <span aria-hidden>·</span>
              <span>{r.latencyMs} ms</span>
            </>
          )}
          {r.mocked && <span className="chip bg-accent/15 text-accent">mock</span>}
          {r.forwardError && <span className="chip bg-bad/15 text-bad" title={r.forwardError}>fwd error</span>}
        </span>
      </button>
    </li>
  );
});

export function filterRequests(list: RequestSummary[], query: string, showPreflight: boolean): RequestSummary[] {
  const q = query.trim().toLowerCase();
  return list.filter((r) => {
    if (r.isPreflight && !showPreflight) return false;
    if (!q) return true;
    return r.method.toLowerCase().includes(q) || r.path.toLowerCase().includes(q) || r.bodyPreview.toLowerCase().includes(q);
  });
}

export function RequestList({ requests, selectedId, onSelect, empty }: { requests: RequestSummary[]; selectedId: string | null; onSelect: (id: string) => void; empty?: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const [showPreflight, setShowPreflight] = useState(false);
  const now = useNow(1000);
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) initial.current = new Set(requests.map((r) => r.id));
  const visible = useMemo(() => filterRequests(requests, query, showPreflight), [requests, query, showPreflight]);
  const newest = requests[0];
  const hiddenPreflights = requests.filter((r) => r.isPreflight).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line p-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-faint" aria-hidden />
          <label htmlFor="req-filter" className="sr-only">Filter requests by method or path</label>
          <input id="req-filter" type="search" className="input pl-8" placeholder="Filter: POST, /pay, ..." value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={showPreflight} onChange={(e) => setShowPreflight(e.target.checked)} className="accent-[rgb(var(--accent))]" />
          Preflights{hiddenPreflights > 0 ? ` (${hiddenPreflights})` : ''}
        </label>
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{newest && !newest.isPreflight ? `Latest request: ${newest.method} ${newest.path}` : ''}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {requests.length === 0 ? (
          empty
        ) : visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-faint">No requests match this filter.</p>
        ) : (
          <ul aria-label="Captured requests">
            {visible.map((r) => (
              <Row key={r.id} r={r} selected={r.id === selectedId} now={now} fresh={!initial.current!.has(r.id)} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
