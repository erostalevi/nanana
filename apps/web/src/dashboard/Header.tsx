import { Settings, Sparkles, Trash2, Unplug, Plug } from 'lucide-react';
import { useState } from 'react';
import { CodeBlock, CopyButton, Logo } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { expiryInfo, formatCountdown } from '../lib/time';
import type { StreamStatus } from '../lib/sse';
import type { Subdomain } from '../lib/types';
import { useNow } from '../lib/useNow';
import { tunnelCommand, useDash } from './ctx';

export function ProBadge({ sub }: { sub: Subdomain }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span className="chip bg-accent/15 text-accent" title="Pro plan">Pro</span>
      <span className="chip bg-accent/15 text-accent" title="No idle death and no 7-day limit">always-on</span>
      {sub.reserved && <span className="chip bg-raised text-muted" title="This name stays reserved while the owner is on Pro">reserved</span>}
      {sub.readOnly && <span className="chip bg-bad/15 text-bad">read-only</span>}
    </div>
  );
}

export function ExpiryBadge({ sub }: { sub: Subdomain }) {
  const now = useNow(1000);
  if (sub.alwaysOn) return <ProBadge sub={sub} />;
  const e = expiryInfo(sub, now);
  const active = sub.state === 'active';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span className={`chip ${active ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}`} title={active ? 'Active: activity within the last hour' : 'Cold: idle for over an hour, still capturing. Any activity wakes it up.'}>
        <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-ok' : 'bg-warn'}`} aria-hidden />
        {sub.state}
      </span>
      {active && e.sleepsInMs != null && <span title="Goes cold after 1 hour without activity">sleeps in <b className="font-mono font-medium text-fg">{formatCountdown(e.sleepsInMs)}</b></span>}
      <span title={`Deleted after 24 h idle or at the 7-day limit (${new Date(sub.hardExpiresAt).toLocaleString()})`}>
        gone in <b className="font-mono font-medium text-fg">{formatCountdown(e.goneInMs)}</b>
        {e.limitedBy === 'hard' ? ' (7-day limit)' : ' if idle'}
      </span>
      {e.limitedBy === 'idle' && <span className="hidden sm:inline" title="Hard lifetime ceiling">limit in <span className="font-mono">{formatCountdown(e.hardMs)}</span></span>}
    </div>
  );
}

function TunnelIndicator({ sub, target }: { sub: Subdomain; target: string | null }) {
  const ctx = useDash();
  const [open, setOpen] = useState(false);
  const on = sub.tunnelOnline;
  return (
    <div className="relative">
      <button type="button" className={`btn btn-sm ${on ? 'border-ok/50 text-ok' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {on ? <Plug size={14} aria-hidden /> : <Unplug size={14} aria-hidden />}
        {on ? `Tunnel connected${target ? `: ${target}` : ''}` : 'Tunnel not connected'}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-[min(92vw,26rem)] space-y-3 rounded-xl border border-line bg-panel p-4 shadow-2xl">
          <p className="text-sm text-muted">{on ? 'Webhooks are being proxied to your machine and your app\'s response goes back to the sender.' : 'Forward webhooks to your local app. Run the CLI:'}</p>
          <CodeBlock code={tunnelCommand(ctx)} label="Connect a tunnel" />
          <p className="text-xs text-faint">Install: <code>curl -fsSL https://nanana.lat/install.sh | sh</code>. One tunnel per endpoint: a new connection replaces the old one. Add <code>-h 192.168.1.20</code> to target another host on your network.</p>
        </div>
      )}
    </div>
  );
}

export function Header({ sub, tunnelTarget, status, onSettings, onMock, onDelete }: { sub: Subdomain; tunnelTarget: string | null; status: StreamStatus; onSettings: () => void; onMock: () => void; onDelete: () => void }) {
  const ctx = useDash();
  return (
    <header className="border-b border-line bg-panel">
      <h1 className="sr-only">Webhook inspector for {sub.slug}</h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-4">
        <a href={ctx.apex} className="shrink-0" aria-label="nanana home"><Logo size="sm" /></a>
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-2">
          <a href={sub.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate font-mono text-sm hover:text-accent" title="Public webhook URL">{sub.url}</a>
          <CopyButton text={sub.url} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 inline-flex items-center gap-1.5 text-xs text-muted" role="status" aria-label={`Live stream ${status}`}>
            <span className={`h-2 w-2 rounded-full ${status === 'open' ? 'bg-ok' : status === 'closed' ? 'bg-bad' : 'bg-warn animate-pulse2'}`} aria-hidden />
            {status === 'open' ? 'live' : status === 'closed' ? 'offline' : 'reconnecting'}
          </span>
          <TunnelIndicator sub={sub} target={tunnelTarget} />
          <button type="button" className="btn btn-sm" onClick={onMock}>
            <Sparkles size={14} aria-hidden />
            {sub.mock ? <>Mock <span className="chip bg-accent/15 text-accent">{sub.mock.status} x{sub.mock.remaining}</span></> : 'Mock'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onSettings}><Settings size={14} aria-hidden /> Settings</button>
          <button type="button" className="btn btn-sm btn-danger" onClick={onDelete} aria-label="Delete endpoint"><Trash2 size={14} aria-hidden /></button>
          <ThemeToggle />
        </div>
      </div>
      <div className="border-t border-line px-3 py-1.5 sm:px-4"><ExpiryBadge sub={sub} /></div>
    </header>
  );
}
