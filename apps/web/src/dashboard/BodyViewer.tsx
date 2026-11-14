import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CopyButton, Notice } from '../components/ui';
import { renderBody, toHex } from '../lib/body';
import { formatBytes } from '../lib/time';
import type { Body, Headers } from '../lib/types';

export function headerValue(h: Headers | null | undefined, name: string): string | null {
  if (!h) return null;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(', ') : v;
  return null;
}

export function KvTable({ rows, empty = 'Nothing here.', label = 'Table' }: { rows: [string, string][]; empty?: string; label?: string }) {
  if (!rows.length) return <p className="text-sm text-faint">{empty}</p>;
  return (
    <div tabIndex={0} role="region" aria-label={label} className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left font-mono text-[12.5px]">
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i} className="border-b border-line last:border-0 align-top">
              <th scope="row" className="w-px whitespace-nowrap px-3 py-1.5 font-medium text-muted">{k}</th>
              <td className="break-all px-3 py-1.5 text-fg">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function headerRows(h: Headers | null | undefined): [string, string][] {
  if (!h) return [];
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(h)) for (const val of Array.isArray(v) ? v : [v]) rows.push([k, val]);
  return rows;
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const key = name !== undefined ? <span className="text-patch">{JSON.stringify(name)}<span className="text-muted">: </span></span> : null;
  if (value !== null && typeof value === 'object') {
    const isArr = Array.isArray(value);
    const entries: [string, unknown][] = isArr ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as object);
    const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return <div>{key}<span className="text-muted">{o}{c}</span></div>;
    return (
      <div>
        <button type="button" className="-ml-4 inline-flex items-center text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} className="w-4 text-faint" aria-hidden /> : <ChevronRight size={12} className="w-4 text-faint" aria-hidden />}
          <span className="sr-only">{open ? 'Collapse' : 'Expand'}</span>
          {key}
          <span className="text-muted">{o}{!open && ` ${entries.length} ${isArr ? 'items' : 'keys'} ${c}`}</span>
        </button>
        {open && (
          <div className="ml-4 border-l border-line pl-3">
            {entries.map(([k, v], i) => (
              <div key={k}>
                <JsonNode name={isArr ? undefined : k} value={v} depth={depth + 1} />
                {i < entries.length - 1 && null}
              </div>
            ))}
          </div>
        )}
        {open && <span className="text-muted">{c}</span>}
      </div>
    );
  }
  let cls = 'text-ok';
  if (typeof value === 'number') cls = 'text-put';
  else if (typeof value === 'boolean') cls = 'text-accent';
  else if (value === null) cls = 'text-faint';
  return <div>{key}<span className={cls}>{JSON.stringify(value)}</span></div>;
}

const HEX_LIMIT = 64 * 1024;

export function BodyViewer({ body, contentType, emptyLabel = 'No body.' }: { body: Body | null | undefined; contentType?: string | null; emptyLabel?: string }) {
  const view = useMemo(() => renderBody(body, contentType), [body, contentType]);
  const [mode, setMode] = useState<'pretty' | 'raw'>('pretty');
  const [bin, setBin] = useState<'hex' | 'base64'>('hex');

  if (view.kind === 'empty') return <p className="text-sm text-faint">{emptyLabel}</p>;

  const toggle = (opts: [string, string][], val: string, set: (v: never) => void, label: string) => (
    <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-line text-xs">
      {opts.map(([id, l]) => (
        <button key={id} type="button" aria-pressed={val === id} onClick={() => set(id as never)} className={`px-2 py-1 ${val === id ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}>{l}</button>
      ))}
    </div>
  );

  let content: React.ReactNode;
  let copy = '';
  let controls: React.ReactNode = null;
  let size = '';
  switch (view.kind) {
    case 'json':
      copy = mode === 'pretty' ? view.pretty : view.raw;
      size = formatBytes(view.raw.length);
      controls = toggle([['pretty', 'Pretty'], ['raw', 'Raw']], mode, setMode, 'JSON view');
      content = mode === 'pretty' ? <div className="font-mono text-[12.5px] leading-6 pl-4"><JsonNode value={view.value} depth={0} /></div> : <pre className="whitespace-pre-wrap break-all font-mono text-[12.5px] leading-6">{view.raw}</pre>;
      break;
    case 'form':
      copy = view.raw;
      content = <KvTable rows={view.pairs} empty="Empty form body." />;
      break;
    case 'text':
      copy = view.text;
      size = formatBytes(new TextEncoder().encode(view.text).length);
      content = <pre className="whitespace-pre-wrap break-all font-mono text-[12.5px] leading-6">{view.text}</pre>;
      break;
    case 'binary': {
      size = formatBytes(view.bytes.length);
      controls = toggle([['hex', 'Hex'], ['base64', 'Base64']], bin, setBin, 'Binary view');
      copy = bin === 'hex' ? toHex(view.bytes) : view.base64;
      content = (
        <>
          <p className="mb-2 text-xs text-faint">Binary body, {size}.</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-5">{bin === 'hex' ? toHex(view.bytes.subarray(0, HEX_LIMIT)) : view.base64}</pre>
          {bin === 'hex' && view.bytes.length > HEX_LIMIT && <p className="mt-2 text-xs text-faint">Showing the first 64 KB.</p>}
        </>
      );
      break;
    }
  }
  return (
    <div>
      {view.truncated && <Notice tone="warn" className="mb-2">This body was truncated when it was stored (only the first part was kept).</Notice>}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-faint">{controls}{size && <span>{size}</span>}</div>
        <CopyButton text={copy} label="Copy body" />
      </div>
      <div tabIndex={0} role="region" aria-label="Body content" className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-bg p-3" data-testid="body-view" data-kind={view.kind}>{content}</div>
    </div>
  );
}
