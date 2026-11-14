import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Notice, Spinner } from '../components/ui';
import { api, errorMessage, getApiBase } from '../lib/api';
import type { Providers } from '../lib/types';
import { useMe } from '../lib/useMe';

const NEXT_KEY = 'nanana:next';

/** Only same-site absolute paths are allowed as post-login destinations. */
export function safeNext(n: string | null | undefined): string | null {
  if (!n || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\')) return null;
  return n;
}

function rememberNext(n: string | null) {
  try {
    if (n) sessionStorage.setItem(NEXT_KEY, n);
  } catch {
    /* ignore */
  }
}
function takeNext(): string | null {
  try {
    const v = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return safeNext(v);
  } catch {
    return null;
  }
}

export function Login() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const providers = useQuery<Providers>({ queryKey: ['providers'], queryFn: () => api<Providers>('/auth/providers'), retry: false, staleTime: 5 * 60_000 });
  const me = useMe();
  const send = useMutation({ mutationFn: () => api('/auth/magic', { method: 'POST', body: { email: email.trim() } }) });

  useEffect(() => {
    if (me.data) nav(next ?? '/account', { replace: true });
  }, [me.data, next, nav]);
  const p = providers.data;
  const oauth = (name: 'github' | 'google') => {
    rememberNext(next);
    window.location.href = `${getApiBase()}/auth/${name}`;
  };

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="mb-2 text-3xl font-semibold tracking-tight">Sign in</h1>
      <p className="mb-8 text-sm text-muted">No password. We email you a one-time link that works for 15 minutes.</p>
      {send.isSuccess ? (
        <Notice tone="ok">If that address is valid, a sign-in link is on its way. Open it on this device. You can close this tab.</Notice>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            rememberNext(next);
            send.mutate();
          }}
        >
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" type="email" required autoComplete="email" className="input" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary w-full py-2" disabled={send.isPending}><Mail size={16} aria-hidden /> {send.isPending ? 'Sending...' : 'Email me a link'}</button>
          {send.isError && <Notice tone="error">{errorMessage(send.error)}</Notice>}
        </form>
      )}
      {providers.isLoading && <div className="mt-6"><Spinner label="Checking sign-in options" /></div>}
      {(p?.github || p?.google) && (
        <div className="mt-8 space-y-2">
          <p className="text-center text-xs text-faint">or continue with</p>
          {p.github && <button type="button" className="btn w-full py-2" onClick={() => oauth('github')}>GitHub</button>}
          {p.google && <button type="button" className="btn w-full py-2" onClick={() => oauth('google')}>Google</button>}
        </div>
      )}
      <p className="mt-10 text-xs text-faint">By signing in you agree to the <Link to="/terms" className="link">Terms</Link> and <Link to="/privacy" className="link">Privacy</Link> notice.</p>
    </div>
  );
}

const verifying = new Map<string, Promise<unknown>>();

export function AuthVerify() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const nav = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(token ? null : 'This sign-in link is missing its token.');

  useEffect(() => {
    if (!token) return;
    // The link is single-use: keep the secret out of the address bar and never verify twice (StrictMode).
    window.history.replaceState(window.history.state, '', window.location.pathname);
    let p = verifying.get(token);
    if (!p) {
      p = api<{ account: unknown }>('/auth/magic/verify', { method: 'POST', body: { token } });
      verifying.set(token, p);
    }
    p.then(
      () => {
        void qc.invalidateQueries({ queryKey: ['me'] });
        nav(takeNext() ?? '/account', { replace: true });
      },
      (e) => setError(errorMessage(e)),
    );
  }, [token, nav, qc]);

  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      {error ? (
        <>
          <h1 className="mb-3 text-2xl font-semibold">That link did not work</h1>
          <Notice tone="error">{error}</Notice>
          <p className="mt-4 text-sm text-muted">Links expire after 15 minutes and work once. <Link to="/login" className="link">Request a new one</Link>.</p>
        </>
      ) : (
        <Spinner label="Signing you in" />
      )}
    </div>
  );
}
