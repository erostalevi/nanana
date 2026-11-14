import { CodeBlock } from '../components/ui';
import { tunnelCommand, useDash } from './ctx';

export function testCurl(url: string): string {
  return `curl -X POST ${url.replace(/\/+$/, '')}/test -H 'content-type: application/json' -d '{"hello":"nanana"}'`;
}

export function EmptyState({ url }: { url: string }) {
  const ctx = useDash();
  return (
    <div className="space-y-5 p-5">
      <div>
        <h2 className="text-base font-semibold">Waiting for the first webhook</h2>
        <p className="mt-1 text-sm text-muted">Point your provider at the URL above, or send a test right now. It will show up here live.</p>
      </div>
      <CodeBlock label="Send a test webhook" code={testCurl(url)} />
      <CodeBlock label="Tunnel to your machine" code={tunnelCommand(ctx)} />
      <p className="text-xs text-faint">Don't have the CLI yet? <code>curl -fsSL https://nanana.lat/install.sh | sh</code></p>
    </div>
  );
}
