import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog, Modal, Notice } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Subdomain } from '../lib/types';
import { useDash } from './ctx';
import { qk } from './live';

export function SettingsDialog({ sub, onClose }: { sub: Subdomain; onClose: () => void }) {
  const { slug, token } = useDash();
  const qc = useQueryClient();
  const [status, setStatus] = useState(String(sub.offlineStatus));
  const [body, setBody] = useState(sub.offlineBody);
  const [header, setHeader] = useState(sub.hmac?.header ?? '');
  const [algo, setAlgo] = useState<string>(sub.hmac?.algo ?? 'sha256');
  const [secret, setSecret] = useState('');
  const [removeSecret, setRemoveSecret] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<Subdomain>(`/subdomains/${slug}`, { method: 'PATCH', token, body: patch }),
    onSuccess: (s) => {
      qc.setQueryData(qk.sub(slug), s);
      // Signature results of existing captures depend on the HMAC config: refresh the list.
      void qc.invalidateQueries({ queryKey: qk.requests(slug) });
      onClose();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalErr(null);
    const n = Number(status);
    if (!Number.isInteger(n) || n < 100 || n > 599) return setLocalErr('Offline status must be a whole number between 100 and 599.');
    if (new TextEncoder().encode(body).length > 4096) return setLocalErr('Offline body must be 4096 bytes or less.');
    const patch: Record<string, unknown> = {};
    if (n !== sub.offlineStatus) patch.offlineStatus = n;
    if (body !== sub.offlineBody) patch.offlineBody = body;
    if (header.trim() && header.trim() !== sub.hmac?.header) patch.hmacHeader = header.trim();
    if (algo !== (sub.hmac?.algo ?? 'sha256')) patch.hmacAlgo = algo;
    if (removeSecret) patch.hmacSecret = null;
    else if (secret) patch.hmacSecret = secret;
    if (secret && !header.trim() && !sub.hmac?.header) return setLocalErr('Choose the header that carries the signature (for example X-Signature).');
    if (!Object.keys(patch).length) return onClose();
    m.mutate(patch);
  };

  return (
    <Modal title="Endpoint settings" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-6">
        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">Offline response</legend>
          <p className="text-xs text-muted">What senders get when no tunnel answers (or the tunnel fails). Use 502 or 503 to deliberately trigger sender retries.</p>
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <div>
              <label className="label" htmlFor="s-status">Status</label>
              <input id="s-status" className="input font-mono" inputMode="numeric" value={status} onChange={(e) => setStatus(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="s-body">Body (max 4096 bytes)</label>
              <textarea id="s-body" className="input min-h-[4.5rem] font-mono" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
            </div>
          </div>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-semibold">HMAC signature check</legend>
          <p className="text-xs text-muted">Verified over the raw body. Accepts hex, <code>sha256=hex</code>, base64 and Stripe-style <code>t=...,v1=...</code>.</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <div>
              <label className="label" htmlFor="s-header">Header name</label>
              <input id="s-header" className="input font-mono" placeholder="X-Hub-Signature-256" value={header} onChange={(e) => setHeader(e.target.value)} spellCheck={false} />
            </div>
            <div>
              <label className="label" htmlFor="s-algo">Algorithm</label>
              <select id="s-algo" className="input" value={algo} onChange={(e) => setAlgo(e.target.value)}>
                <option value="sha256">sha256</option>
                <option value="sha1">sha1</option>
                <option value="sha512">sha512</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="s-secret">Secret (write-only)</label>
            <input
              id="s-secret"
              type="password"
              autoComplete="new-password"
              className="input font-mono"
              disabled={removeSecret}
              placeholder={sub.hmac?.configured ? 'A secret is saved. Type to replace it.' : 'Paste the signing secret'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            {sub.hmac?.configured && (
              <label className="mt-2 flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={removeSecret} onChange={(e) => setRemoveSecret(e.target.checked)} className="accent-[rgb(var(--accent))]" /> Remove the saved secret (turns the check off)
              </label>
            )}
          </div>
        </fieldset>
        {(localErr || m.isError) && <Notice tone="error">{localErr ?? errorMessage(m.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={m.isPending}>{m.isPending ? 'Saving...' : 'Save settings'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function MockDialog({ sub, onClose }: { sub: Subdomain; onClose: () => void }) {
  const { slug, token } = useDash();
  const qc = useQueryClient();
  const [status, setStatus] = useState('500');
  const [times, setTimes] = useState('2');
  const [body, setBody] = useState('{"error":"mocked by nanana"}');
  const [hdrs, setHdrs] = useState<{ k: string; v: string }[]>([{ k: 'content-type', v: 'application/json' }]);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const set = useMutation({
    mutationFn: (payload: unknown) => api<{ status: number; remaining: number }>(`/subdomains/${slug}/mock`, { method: 'POST', token, body: payload }),
    onSuccess: (r) => {
      qc.setQueryData<Subdomain>(qk.sub(slug), (s) => (s ? { ...s, mock: r } : s));
      onClose();
    },
  });
  const clear = useMutation({
    mutationFn: () => api(`/subdomains/${slug}/mock`, { method: 'DELETE', token }),
    onSuccess: () => {
      qc.setQueryData<Subdomain>(qk.sub(slug), (s) => (s ? { ...s, mock: null } : s));
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalErr(null);
    const s = Number(status);
    const t = Number(times);
    if (!Number.isInteger(s) || s < 100 || s > 599) return setLocalErr('Status must be between 100 and 599.');
    if (!Number.isInteger(t) || t < 1 || t > 50) return setLocalErr('Times must be between 1 and 50.');
    const headers: Record<string, string> = {};
    for (const { k, v } of hdrs) if (k.trim()) headers[k.trim()] = v;
    set.mutate({ status: s, times: t, body, ...(Object.keys(headers).length ? { headers } : {}) });
  };

  return (
    <Modal title="Mock the next responses" onClose={onClose} wide>
      <div className="mb-4 rounded-lg border border-line bg-bg p-3 text-sm" aria-live="polite">
        {sub.mock ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>Active: respond <strong className="font-mono">{sub.mock.status}</strong>, <strong>{sub.mock.remaining}</strong> use{sub.mock.remaining === 1 ? '' : 's'} left.</span>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => clear.mutate()} disabled={clear.isPending}>Clear mock</button>
          </div>
        ) : (
          <span className="text-muted">No mock rule active. Requests go to your tunnel or the offline response.</span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted">Mocked requests are not forwarded. After the count runs out, behavior returns to normal. Typical use: <code>500</code> twice, then let the sender's retry reach your real handler.</p>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="m-status">Status</label>
            <input id="m-status" className="input font-mono" inputMode="numeric" value={status} onChange={(e) => setStatus(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="m-times">Times (1 to 50)</label>
            <input id="m-times" className="input font-mono" inputMode="numeric" value={times} onChange={(e) => setTimes(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="m-body">Body</label>
          <textarea id="m-body" className="input min-h-[5rem] font-mono" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5">
          <span className="label">Response headers</span>
          {hdrs.map((h, i) => (
            <div key={i} className="flex gap-1.5">
              <input aria-label={`Header name ${i + 1}`} className="input w-2/5 font-mono" value={h.k} onChange={(e) => setHdrs(hdrs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
              <input aria-label={`Header value ${i + 1}`} className="input flex-1 font-mono" value={h.v} onChange={(e) => setHdrs(hdrs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove header ${i + 1}`} onClick={() => setHdrs(hdrs.filter((_, j) => j !== i))}><X size={14} aria-hidden /></button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setHdrs([...hdrs, { k: '', v: '' }])}><Plus size={12} aria-hidden /> Add header</button>
        </div>
        {(localErr || set.isError || clear.isError) && <Notice tone="error">{localErr ?? errorMessage(set.error ?? clear.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn-primary" disabled={set.isPending}>{set.isPending ? 'Saving...' : sub.mock ? 'Replace mock' : 'Start mock'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteEndpointDialog({ sub, onClose, onDeleted }: { sub: Subdomain; onClose: () => void; onDeleted: () => void }) {
  const { slug, token } = useDash();
  const m = useMutation({ mutationFn: () => api(`/subdomains/${slug}`, { method: 'DELETE', token }), onSuccess: onDeleted });
  return (
    <ConfirmDialog title="Delete this endpoint?" confirmLabel="Delete endpoint" onClose={onClose} onConfirm={() => m.mutate()} busy={m.isPending} error={m.isError ? errorMessage(m.error) : null}>
      <p>This immediately deletes <code className="text-fg">{sub.slug}</code>, all captured requests, replays and the mock rule. The URL stops working and cannot be restored.</p>
    </ConfirmDialog>
  );
}
