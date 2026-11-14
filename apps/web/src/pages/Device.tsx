import { useMutation } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Notice, Spinner } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import { useMe } from '../lib/useMe';

export function normalizeUserCode(v: string): string {
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4, 8)}` : s;
}

export function Device() {
  const [params] = useSearchParams();
  const me = useMe();
  const [code, setCode] = useState(() => normalizeUserCode(params.get('code') ?? ''));
  const approve = useMutation({ mutationFn: () => api('/auth/device/approve', { method: 'POST', body: { userCode: code } }) });
  const here = `/device${code ? `?code=${encodeURIComponent(code)}` : ''}`;

  if (me.isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="mb-2 text-3xl font-semibold tracking-tight">Connect the CLI</h1>
      {approve.isSuccess ? (
        <div className="mt-6 space-y-3 text-center">
          <CheckCircle2 size={40} className="mx-auto text-ok" aria-hidden />
          <p className="text-lg font-medium">Approved</p>
          <p className="text-sm text-muted">You can go back to your terminal. The CLI will pick up the login in a few seconds.</p>
        </div>
      ) : !me.data ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">Sign in first, then approve code <code className="font-mono text-fg">{code || '...'}</code>.</p>
          <Link to={`/login?next=${encodeURIComponent(here)}`} className="btn btn-primary">Sign in to continue</Link>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); approve.mutate(); }}>
          <p className="text-sm text-muted">Signed in as <strong className="text-fg">{me.data.account.email}</strong>. Check that this code matches the one in your terminal, then approve.</p>
          <div>
            <label className="label" htmlFor="code">Code from the CLI</label>
            <input id="code" className="input text-center font-mono text-xl tracking-widest" value={code} onChange={(e) => setCode(normalizeUserCode(e.target.value))} placeholder="ABCD-EFGH" maxLength={9} autoComplete="off" spellCheck={false} />
          </div>
          {approve.isError && <Notice tone="error">{approve.error instanceof ApiError && approve.error.status === 404 ? 'That code was not found or has expired. Run `nanana login` again for a fresh one.' : errorMessage(approve.error)}</Notice>}
          <button type="submit" className="btn btn-primary w-full py-2" disabled={code.length < 9 || approve.isPending}>{approve.isPending ? 'Approving...' : 'Approve this device'}</button>
          <p className="text-xs text-faint">Only approve codes you just requested yourself. Approving gives the CLI access to your endpoints; you can revoke it from your account.</p>
        </form>
      )}
    </div>
  );
}
