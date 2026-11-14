import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { dashboardLink } from '../components/CreateEndpoint';
import { CodeBlock, ConfirmDialog, CopyButton, Modal, Notice, Spinner } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { currentMode } from '../lib/host';
import { expiryInfo, formatCountdown, relativeTime } from '../lib/time';
import type { CliToken, Subdomain } from '../lib/types';
import { useMe } from '../lib/useMe';
import { useNow } from '../lib/useNow';

/** Accepts either a full dashboard link (https://slug.tools.base/#t=nnt_...) or nothing. */
export function parseDashboardLink(v: string): { slug: string; token: string } | null {
  try {
    const u = new URL(v.trim());
    const m = /^([a-z0-9-]+)\.tools\./.exec(u.hostname);
    const t = new URLSearchParams(u.hash.replace(/^#/, '')).get('t');
    return m?.[1] && t ? { slug: m[1], token: t } : null;
  } catch {
    return null;
  }
}

function fmtLimit(k: string, v: unknown): string {
  if (typeof v === 'number' && /bytes$/i.test(k)) return `${(v / 1048576).toFixed(v % 1048576 ? 1 : 0)} MB`;
  return String(v);
}

function Unavailable({ e }: { e: unknown }) {
  if (e instanceof ApiError && e.status === 404) return <Notice>This part of the API is not available on this server yet.</Notice>;
  return <Notice tone="error">{errorMessage(e)}</Notice>;
}

function EndpointRow({ s, onRotate }: { s: Subdomain; onRotate: (slug: string) => void }) {
  const qc = useQueryClient();
  const now = useNow(1000);
  const e = expiryInfo(s, now);
  const [confirm, setConfirm] = useState(false);
  const base = currentMode().base;
  const refresh = () => qc.invalidateQueries({ queryKey: ['subdomains'] });
  const renew = useMutation({ mutationFn: () => api(`/subdomains/${s.slug}/renew`, { method: 'POST' }), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => api(`/subdomains/${s.slug}`, { method: 'DELETE' }), onSuccess: () => { setConfirm(false); void refresh(); } });
  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-mono text-sm hover:text-accent">{s.url}</a>
        <span className={`chip ${s.state === 'active' ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}`}>{s.state}</span>
        {s.isCustom && <span className="chip bg-raised text-muted">custom</span>}
        {s.tunnelOnline && <span className="chip bg-ok/15 text-ok">tunnel</span>}
        <span className="text-xs text-faint">gone in {formatCountdown(e.goneInMs)}{e.limitedBy === 'hard' ? ' (7-day limit)' : ' if idle'}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <a className="btn btn-sm" href={`${dashboardLink(s.slug, 'x', base).replace(/#.*/, '')}`} target="_blank" rel="noopener"><ExternalLink size={12} aria-hidden /> Dashboard</a>
        <button type="button" className="btn btn-sm" onClick={() => renew.mutate()} disabled={renew.isPending}><RefreshCw size={12} aria-hidden /> Renew +7 days</button>
        <button type="button" className="btn btn-sm" onClick={() => onRotate(s.slug)}><KeyRound size={12} aria-hidden /> Rotate token</button>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}><Trash2 size={12} aria-hidden /> Delete</button>
      </div>
      {renew.isError && <Notice tone="warn">{renew.error instanceof ApiError && renew.error.status === 409 ? 'This endpoint was already renewed once.' : errorMessage(renew.error)}</Notice>}
      {confirm && (
        <ConfirmDialog title={`Delete ${s.slug}?`} confirmLabel="Delete endpoint" onClose={() => setConfirm(false)} onConfirm={() => del.mutate()} busy={del.isPending} error={del.isError ? errorMessage(del.error) : null}>
          <p>This deletes the endpoint and everything captured on it. It cannot be undone.</p>
        </ConfirmDialog>
      )}
    </li>
  );
}

export function Account() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const base = currentMode().base;
  const enabled = !!me.data;
  const subs = useQuery<{ subdomains: Subdomain[] }>({ queryKey: ['subdomains'], queryFn: () => api('/subdomains'), enabled, retry: false });
  const tokens = useQuery<{ tokens: CliToken[] }>({ queryKey: ['cli-tokens'], queryFn: () => api('/me/tokens'), enabled, retry: false });
  const [rotated, setRotated] = useState<{ slug: string; token: string } | null>(null);
  const [rotateErr, setRotateErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [claim, setClaim] = useState({ slug: '', token: '' });
  const [showDelete, setShowDelete] = useState(false);

  const create = useMutation({
    mutationFn: () => api<{ subdomain: Subdomain; token: string }>('/subdomains', { method: 'POST', body: name.trim() ? { name: name.trim().toLowerCase() } : {} }),
    onSuccess: (r) => { setName(''); setRotated({ slug: r.subdomain.slug, token: r.token }); void qc.invalidateQueries({ queryKey: ['subdomains'] }); },
  });
  const claimM = useMutation({
    mutationFn: () => api(`/subdomains/${claim.slug.trim().toLowerCase()}/claim`, { method: 'POST', body: { token: claim.token.trim() } }),
    onSuccess: () => { setClaim({ slug: '', token: '' }); void qc.invalidateQueries({ queryKey: ['subdomains'] }); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/me/tokens/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cli-tokens'] }) });
  const delAccount = useMutation({
    mutationFn: () => api('/me', { method: 'DELETE' }),
    onSuccess: () => { qc.clear(); nav('/'); },
  });

  if (me.isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (!me.data) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="mb-3 text-2xl font-semibold">Your account</h1>
        {me.isError && me.error.status !== 401 ? <Notice tone="error">{errorMessage(me.error)}</Notice> : <p className="mb-5 text-sm text-muted">Sign in to see your endpoints, CLI logins and limits.</p>}
        <Link to="/login?next=/account" className="btn btn-primary">Sign in</Link>
      </div>
    );
  }
  const { account, limits } = me.data;
  const rotate = async (slug: string) => {
    setRotateErr(null);
    try {
      const r = await api<{ token: string }>(`/subdomains/${slug}/token`, { method: 'POST' });
      setRotated({ slug, token: r.token });
    } catch (e) {
      setRotateErr(errorMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-10 px-4 py-12">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Your account</h1>
        <p className="mt-1 text-sm text-muted">{account.email} · plan <span className="chip bg-raised text-fg">{account.plan}</span></p>
      </header>

      <section aria-labelledby="eps">
        <h2 id="eps" className="mb-3 text-lg font-semibold">Endpoints</h2>
        {rotateErr && <Notice tone="error" className="mb-3">{rotateErr}</Notice>}
        {subs.isLoading ? <Spinner /> : subs.isError ? <Unavailable e={subs.error} /> : subs.data && subs.data.subdomains.length === 0 ? <p className="text-sm text-muted">No endpoints yet. Create one below, or from the <Link to="/" className="link">home page</Link> without an account.</p> : (
          <ul className="card divide-y divide-line">{subs.data?.subdomains.map((s) => <EndpointRow key={s.slug} s={s} onRotate={rotate} />)}</ul>
        )}
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="min-w-[14rem] flex-1">
            <label className="label" htmlFor="new-name">New endpoint (optional custom name)</label>
            <input id="new-name" className="input font-mono" placeholder="my-app (leave empty for a random name)" value={name} onChange={(e) => setName(e.target.value)} pattern="[a-zA-Z0-9-]{3,32}" title="3 to 32 letters, digits or hyphens" />
          </div>
          <button className="btn btn-primary" disabled={create.isPending}>Create endpoint</button>
        </form>
        {create.isError && <Notice tone="error" className="mt-2">{errorMessage(create.error)}</Notice>}
      </section>

      <section aria-labelledby="claim">
        <h2 id="claim" className="mb-1 text-lg font-semibold">Claim an anonymous endpoint</h2>
        <p className="mb-3 text-sm text-muted">Attach an endpoint you created without an account. Paste its dashboard link, or enter the name and token.</p>
        <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); claimM.mutate(); }}>
          <div>
            <label className="label" htmlFor="c-slug">Name or dashboard link</label>
            <input id="c-slug" className="input font-mono" value={claim.slug} onChange={(e) => { const p = parseDashboardLink(e.target.value); setClaim(p ?? { ...claim, slug: e.target.value }); }} placeholder="k7x2m9qa" />
          </div>
          <div>
            <label className="label" htmlFor="c-token">Token</label>
            <input id="c-token" className="input font-mono" type="password" autoComplete="off" value={claim.token} onChange={(e) => setClaim({ ...claim, token: e.target.value })} placeholder="nnt_..." />
          </div>
          <button className="btn" disabled={claimM.isPending || !claim.slug || !claim.token}>Claim</button>
        </form>
        {claimM.isError && <Notice tone="error" className="mt-2">{errorMessage(claimM.error)}</Notice>}
        {claimM.isSuccess && <Notice tone="ok" className="mt-2">Claimed. It now appears in your list.</Notice>}
      </section>

      <section aria-labelledby="cli">
        <h2 id="cli" className="mb-3 text-lg font-semibold">CLI logins</h2>
        {tokens.isLoading ? <Spinner /> : tokens.isError ? <Unavailable e={tokens.error} /> : tokens.data && tokens.data.tokens.length === 0 ? <p className="text-sm text-muted">No CLI logins. Run <code className="font-mono">nanana login</code> to add one.</p> : (
          <ul className="card divide-y divide-line">
            {tokens.data?.tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <span className="font-medium">{t.name || 'CLI'}</span>
                <span className="text-xs text-faint">created {relativeTime(t.createdAt)}{t.lastUsedAt ? `, last used ${relativeTime(t.lastUsedAt)}` : ', never used'}</span>
                <button type="button" className="btn btn-sm btn-danger ml-auto" onClick={() => revoke.mutate(t.id)} disabled={revoke.isPending}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
        {revoke.isError && <Notice tone="error" className="mt-2">{errorMessage(revoke.error)}</Notice>}
      </section>

      <section aria-labelledby="plan">
        <h2 id="plan" className="mb-3 text-lg font-semibold">Plan and limits</h2>
        <dl className="card grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
          {Object.entries(limits).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-line py-1 last:border-0"><dt className="text-muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd className="font-mono">{fmtLimit(k, v)}</dd></div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="danger" className="rounded-xl border border-bad/40 p-4">
        <h2 id="danger" className="mb-1 text-lg font-semibold text-bad">Delete account</h2>
        <p className="mb-3 text-sm text-muted">Removes your account, sign-ins, CLI logins and every endpoint you own. This cannot be undone.</p>
        <button type="button" className="btn btn-danger" onClick={() => setShowDelete(true)}>Delete my account</button>
      </section>

      {showDelete && (
        <ConfirmDialog title="Delete your account?" confirmLabel="Delete account forever" requireText={account.email} onClose={() => setShowDelete(false)} onConfirm={() => delAccount.mutate()} busy={delAccount.isPending} error={delAccount.isError ? errorMessage(delAccount.error) : null}>
          <p>All of your endpoints and their captured requests will be deleted immediately.</p>
        </ConfirmDialog>
      )}
      {rotated && (
        <Modal title="Your token (shown once)" onClose={() => setRotated(null)} wide>
          <p className="mb-3 text-sm text-muted">Token for <code className="font-mono text-fg">{rotated.slug}</code>. Save it now: we only store a hash and cannot show it again. Older tokens for this endpoint stop working.</p>
          <CodeBlock label="Token" code={rotated.token} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a className="btn btn-primary" href={dashboardLink(rotated.slug, rotated.token, base)} target="_blank" rel="noopener"><ExternalLink size={14} aria-hidden /> Open dashboard</a>
            <CopyButton text={dashboardLink(rotated.slug, rotated.token, base)} label="Copy dashboard link" small={false} />
          </div>
          <div className="mt-3"><CodeBlock label="Tunnel" code={`nanana -t=${rotated.token} -p=3000`} /></div>
        </Modal>
      )}
    </div>
  );
}
