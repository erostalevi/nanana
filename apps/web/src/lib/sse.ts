import type { StreamEvent } from './types';

export type SseMessage = { event: string; data: string };

/** Incremental Server-Sent-Events parser. Handles CRLF/LF/CR, multi-line data, comments, chunk splits. */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private hasData = false;
  private skipLf = false;
  constructor(private onComment?: (text: string) => void) {}

  push(chunk: string): SseMessage[] {
    if (this.skipLf && chunk.startsWith('\n')) chunk = chunk.slice(1);
    if (chunk.length > 0) this.skipLf = false;
    this.buf += chunk;
    const out: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c !== '\n' && c !== '\r') continue;
      const line = this.buf.slice(start, i);
      if (c === '\r') {
        if (this.buf[i + 1] === '\n') i++;
        else if (i + 1 >= this.buf.length) this.skipLf = true;
      }
      start = i + 1;
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  private line(line: string): SseMessage | null {
    if (line === '') {
      if (!this.hasData && !this.event) return null;
      const msg = { event: this.event || 'message', data: this.data.join('\n') };
      this.event = '';
      this.data = [];
      this.hasData = false;
      return msg;
    }
    if (line.startsWith(':')) {
      this.onComment?.(line.slice(1).trim());
      return null;
    }
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') {
      this.data.push(value);
      this.hasData = true;
    }
    return null;
  }
}

const KNOWN = new Set(['hello', 'request.created', 'request.updated', 'request.deleted', 'tunnel.status', 'mock.updated', 'subdomain.state', 'subdomain.deleted']);

export function toStreamEvent(m: SseMessage): StreamEvent | null {
  if (!KNOWN.has(m.event)) return null;
  try {
    return { type: m.event, data: m.data === '' ? {} : JSON.parse(m.data) } as StreamEvent;
  } catch {
    return null;
  }
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type StreamOptions = {
  url: string;
  token?: string | null;
  onEvent: (e: StreamEvent) => void;
  onStatus?: (s: StreamStatus) => void;
  /** Called when the stream is re-established after a gap: refetch lists. */
  onReconnect?: () => void;
  /** Called for 401/403/404 on connect: no point retrying. */
  onFatal?: (status: number) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** abort and reconnect if nothing (not even a heartbeat) arrives for this long */
  stallMs?: number;
  random?: () => number;
};

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(15000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

/** Streams SSE over fetch (Authorization header, never a token in the URL), with auto-reconnect. Returns stop(). */
export function startStream(opts: StreamOptions): () => void {
  const ctl = new AbortController();
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = opts.sleep ?? defaultSleep;
  const stallMs = opts.stallMs ?? 70_000;
  const rnd = opts.random ?? Math.random;

  void (async () => {
    let attempt = 0;
    let everOpened = false;
    while (!ctl.signal.aborted) {
      opts.onStatus?.(everOpened ? 'reconnecting' : 'connecting');
      const conn = new AbortController();
      const onOuterAbort = () => conn.abort();
      ctl.signal.addEventListener('abort', onOuterAbort, { once: true });
      let stall: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(() => conn.abort(), stallMs);
      };
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
        arm();
        const res = await doFetch(opts.url, { headers, credentials: 'include', signal: conn.signal, cache: 'no-store' });
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          opts.onFatal?.(res.status);
          opts.onStatus?.('closed');
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream http ${res.status}`);
        opts.onStatus?.('open');
        if (everOpened) opts.onReconnect?.();
        everOpened = true;
        attempt = 0;
        const parser = new SseParser(() => arm());
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          for (const m of parser.push(dec.decode(value, { stream: true }))) {
            const ev = toStreamEvent(m);
            if (!ev) continue;
            opts.onEvent(ev);
            if (ev.type === 'subdomain.deleted') {
              opts.onStatus?.('closed');
              return;
            }
          }
        }
      } catch {
        /* network error, stall abort or manual abort: fall through to retry */
      } finally {
        clearTimeout(stall);
        ctl.signal.removeEventListener('abort', onOuterAbort);
      }
      if (ctl.signal.aborted) break;
      attempt++;
      opts.onStatus?.('reconnecting');
      await sleep(backoffDelay(attempt, rnd), ctl.signal);
    }
    opts.onStatus?.('closed');
  })();

  return () => ctl.abort();
}
