import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function Logo({ size = 'md', className = '' }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const px = size === 'lg' ? 40 : size === 'sm' ? 20 : 26;
  return (
    <span className={`inline-flex items-center gap-2 font-mono font-semibold tracking-tight ${className}`}>
      <svg width={px} height={px} viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
        <rect width="64" height="64" rx="16" fill="rgb(var(--accent))" />
        <g fill="rgb(var(--accent-fg))">
          <circle cx="22" cy="24" r="4.5" />
          <circle cx="42" cy="24" r="4.5" />
        </g>
        <path d="M18 38q14 13 28 0" fill="none" stroke="rgb(var(--accent-fg))" strokeWidth="5" strokeLinecap="round" />
      </svg>
      <span className={size === 'lg' ? 'text-3xl' : 'text-lg'}>nanana</span>
    </span>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label = 'Copy', className = '', small = true, getText }: { text?: string; getText?: () => string; label?: string; className?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`btn ${small ? 'btn-sm' : ''} ${className}`}
      onClick={async () => {
        if (await copyText(getText ? getText() : (text ?? ''))) {
          setDone(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      <span aria-live="polite">{done ? 'Copied' : label}</span>
    </button>
  );
}

export function CodeBlock({ code, label, className = '' }: { code: string; label?: string; className?: string }) {
  return (
    <div className={`group relative rounded-lg border border-line bg-bg ${className}`}>
      {label && <div className="border-b border-line px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>}
      <pre className="overflow-x-auto p-3 pr-20 text-[13px] leading-6 text-fg"><code>{code}</code></pre>
      <div className="absolute right-2 top-2" style={label ? { top: '2.1rem' } : undefined}>
        <CopyButton text={code} />
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', children, className = '' }: { tone?: 'info' | 'error' | 'warn' | 'ok'; children: ReactNode; className?: string }) {
  const c = { info: 'border-line text-muted', error: 'border-bad/50 text-bad bg-bad/5', warn: 'border-warn/50 text-warn bg-warn/5', ok: 'border-ok/50 text-ok bg-ok/5' }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-sm ${c} ${className}`}>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
      {label}
    </span>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input:not([disabled]),select,[tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab' && ref.current) {
        const els = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!els.length) return;
        const f = els[0]!;
        const l = els[els.length - 1]!;
        if (e.shiftKey && document.activeElement === f) (e.preventDefault(), l.focus());
        else if (!e.shiftKey && document.activeElement === l) (e.preventDefault(), f.focus());
      }
    },
    [onClose],
  );
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKey}
        className={`card max-h-[92vh] w-full overflow-y-auto rounded-b-none p-5 shadow-2xl sm:rounded-b-xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close dialog">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose, busy, error, requireText }: { title: string; children: ReactNode; confirmLabel: string; onConfirm: () => void; onClose: () => void; busy?: boolean; error?: string | null; requireText?: string }) {
  const [typed, setTyped] = useState('');
  const ok = !requireText || typed === requireText;
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3 text-sm text-muted">{children}</div>
      {requireText && (
        <div className="mt-4">
          <label className="label" htmlFor="confirm-typed">Type <code className="text-fg">{requireText}</code> to confirm</label>
          <input id="confirm-typed" className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </div>
      )}
      {error && <Notice tone="error" className="mt-3">{error}</Notice>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={busy || !ok} onClick={onConfirm}>{busy ? 'Working...' : confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string; badge?: ReactNode }[]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line px-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          type="button"
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.id === value);
            if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length]!.id);
            if (e.key === 'ArrowLeft') onChange(tabs[(i - 1 + tabs.length) % tabs.length]!.id);
          }}
          className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition ${value === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}
