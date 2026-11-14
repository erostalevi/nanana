import { CloudOff, Plug, ShieldQuestion, Sparkles } from 'lucide-react';
import type { AnsweredBy, Signature } from '../lib/types';

const METHOD: Record<string, string> = {
  GET: 'bg-ok/15 text-ok',
  POST: 'bg-accent/15 text-accent',
  PUT: 'bg-put/15 text-put',
  PATCH: 'bg-patch/15 text-patch',
  DELETE: 'bg-bad/15 text-bad',
};

export function MethodBadge({ method }: { method: string }) {
  return <span className={`chip w-14 shrink-0 justify-center ${METHOD[method] ?? 'bg-raised text-muted'}`}>{method.length > 7 ? method.slice(0, 7) : method}</span>;
}

export function StatusChip({ status, pending }: { status: number | null; pending?: boolean }) {
  if (status == null) return <span className="chip bg-raised text-faint" title={pending ? 'Waiting for response' : 'No response'}>{pending ? '...' : '-'}</span>;
  const tone = status >= 500 ? 'bg-bad/15 text-bad' : status >= 400 ? 'bg-warn/15 text-warn' : status >= 300 ? 'bg-raised text-muted' : 'bg-ok/15 text-ok';
  return <span className={`chip ${tone}`}>{status}</span>;
}

const ANSWERED: Record<AnsweredBy, { label: string; Icon: typeof Plug }> = {
  tunnel: { label: 'Answered by your tunnel', Icon: Plug },
  mock: { label: 'Answered by a mock rule', Icon: Sparkles },
  offline: { label: 'Answered with the offline response', Icon: CloudOff },
  preflight: { label: 'CORS preflight, answered automatically', Icon: ShieldQuestion },
};

export function AnsweredIcon({ by }: { by: AnsweredBy }) {
  const { label, Icon } = ANSWERED[by] ?? ANSWERED.offline;
  return (
    <span title={label} className="inline-flex text-muted">
      <Icon size={14} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

const SIG: Record<Signature, { label: string; cls: string }> = {
  pass: { label: 'Signature valid', cls: 'bg-ok' },
  fail: { label: 'Signature invalid', cls: 'bg-bad' },
  header_missing: { label: 'Signature header missing', cls: 'bg-warn' },
  not_configured: { label: 'No HMAC check configured', cls: 'border border-faint' },
};

export function SigDot({ sig }: { sig: Signature }) {
  const s = SIG[sig];
  return (
    <span title={s.label} className="inline-flex">
      <span className={`inline-block h-2 w-2 rounded-full ${s.cls}`} aria-hidden />
      <span className="sr-only">{s.label}</span>
    </span>
  );
}

export function sigLabel(sig: Signature): string {
  return SIG[sig].label;
}
