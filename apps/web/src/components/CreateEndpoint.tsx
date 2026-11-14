import { useMutation } from '@tanstack/react-query';
import { ExternalLink, Wand2 } from 'lucide-react';
import { ApiError, api, errorMessage } from '../lib/api';
import { currentMode } from '../lib/host';
import type { CreatedSubdomain } from '../lib/types';
import { CodeBlock, CopyButton, Notice } from './ui';

export function dashboardLink(slug: string, token: string, base: string, loc: Pick<Location, 'protocol' | 'port'> = window.location): string {
  return `${loc.protocol}//${slug}.tools.${base}${loc.port ? `:${loc.port}` : ''}/#t=${token}`;
}

function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return `Slow down: anonymous endpoints are limited per day from one address${e.retryAfter ? ` (try again in about ${Math.ceil(e.retryAfter / 60)} min)` : ''}. Sign in for more.`;
    if (e.code === 'limit_reached') return 'You have reached the endpoint limit for your plan.';
  }
  return errorMessage(e);
}

export function CreateEndpoint() {
  const base = currentMode().base;
  const m = useMutation<CreatedSubdomain, unknown>({ mutationFn: () => api<CreatedSubdomain>('/subdomains', { method: 'POST', body: {} }) });
  const r = m.data;

  if (!r) {
    return (
      <div className="space-y-3">
        <button id="create-endpoint" type="button" className="btn btn-primary px-5 py-2.5 text-base" disabled={m.isPending} onClick={() => m.mutate()}>
          <Wand2 size={18} aria-hidden /> {m.isPending ? 'Creating...' : 'Create an endpoint'}
        </button>
        <p className="text-xs text-faint">No sign-up. A fresh URL in one click, gone after 24 h idle (7 days max).</p>
        {m.isError && <Notice tone="error">{explain(m.error)}</Notice>}
      </div>
    );
  }
  const slug = r.subdomain.slug;
  const link = dashboardLink(slug, r.token, base);
  const url = r.subdomain.url;
  const curl = `curl -X POST ${url}/test -H 'content-type: application/json' -d '{"hello":"nanana"}'`;
  const cli = `nanana -t=${r.token} -p=3000`;
  return (
    <div className="card space-y-4 p-4 text-left" aria-label="Your new endpoint">
      <div>
        <p className="label">Your endpoint URL</p>
        <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-bg px-3 py-2 text-sm">{url}</code><CopyButton text={url} /></div>
      </div>
      <div>
        <p className="label">Token (shown once, keep it)</p>
        <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-bg px-3 py-2 text-sm">{r.token}</code><CopyButton text={r.token} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a className="btn btn-primary" href={link} target="_blank" rel="noopener"><ExternalLink size={14} aria-hidden /> Open dashboard</a>
        <CopyButton text={link} label="Copy dashboard link" small={false} />
      </div>
      <Notice tone="warn">The dashboard link contains your token after the #. Anyone with it can view and manage this endpoint. We cannot show it again.</Notice>
      <CodeBlock label="Send a test webhook" code={curl} />
      <CodeBlock label="Tunnel it to localhost:3000" code={cli} />
      <button type="button" className="text-xs text-muted underline" onClick={() => m.reset()}>Create another</button>
    </div>
  );
}
