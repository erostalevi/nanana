import { describe, expect, it, vi } from 'vitest';
import { SseParser, backoffDelay, startStream, toStreamEvent } from '../sse';

describe('SseParser', () => {
  it('parses a simple frame', () => {
    expect(new SseParser().push('event: hello\ndata: {"a":1}\n\n')).toEqual([{ event: 'hello', data: '{"a":1}' }]);
  });
  it('joins multi-line data with newlines', () => {
    expect(new SseParser().push('event: x\ndata: line1\ndata: line2\n\n')).toEqual([{ event: 'x', data: 'line1\nline2' }]);
  });
  it('ignores comments and reports them', () => {
    const c: string[] = [];
    const p = new SseParser((t) => c.push(t));
    expect(p.push(': ping\n\n')).toEqual([]);
    expect(c).toEqual(['ping']);
  });
  it('handles chunk boundaries anywhere, including mid-field and mid-CRLF', () => {
    const full = 'event: request.created\r\ndata: {"id":"1"}\r\n\r\n: ping\r\n\r\nevent: tunnel.status\ndata: {"online":true}\n\n';
    for (let split = 1; split < full.length; split++) {
      const p = new SseParser();
      const out = [...p.push(full.slice(0, split)), ...p.push(full.slice(split))];
      expect(out).toEqual([
        { event: 'request.created', data: '{"id":"1"}' },
        { event: 'tunnel.status', data: '{"online":true}' },
      ]);
    }
  });
  it('handles lone CR line endings and a CR/LF split across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.push('\n\r')).toEqual([{ event: 'message', data: 'a' }]);
    expect(p.push('\n')).toEqual([]);
    expect(new SseParser().push('data: b\r\r')).toEqual([{ event: 'message', data: 'b' }]);
  });
  it('strips exactly one leading space and handles fields without value', () => {
    expect(new SseParser().push('data:  two\n\n')).toEqual([{ event: 'message', data: ' two' }]);
    expect(new SseParser().push('data\n\n')).toEqual([{ event: 'message', data: '' }]);
  });
  it('does not emit a message for blank lines alone', () => {
    expect(new SseParser().push('\n\n\n')).toEqual([]);
  });
});

describe('toStreamEvent', () => {
  it('maps known events, ignores unknown or malformed', () => {
    expect(toStreamEvent({ event: 'request.deleted', data: '{"id":"x"}' })).toEqual({ type: 'request.deleted', data: { id: 'x' } });
    expect(toStreamEvent({ event: 'subdomain.deleted', data: '{}' })).toEqual({ type: 'subdomain.deleted', data: {} });
    expect(toStreamEvent({ event: 'mock.updated', data: 'null' })).toEqual({ type: 'mock.updated', data: null });
    expect(toStreamEvent({ event: 'nope', data: '{}' })).toBeNull();
    expect(toStreamEvent({ event: 'hello', data: '{bad' })).toBeNull();
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and caps near 15s', () => {
    const r = () => 0.5;
    expect(backoffDelay(1, r)).toBe(1000);
    expect(backoffDelay(2, r)).toBe(2000);
    expect(backoffDelay(10, r)).toBe(15000);
  });
});

function sseResponse(chunks: string[], status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

describe('startStream', () => {
  it('sends the Authorization header (never a URL token) and parses events split across chunks', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    const events: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      n++;
      if (n === 1) return sseResponse(['event: hello\ndata: {"slug":"a"}\n\nevent: request.cre', 'ated\ndata: {"id":"1"}\n\n']);
      return new Promise<Response>(() => undefined); // later connections hang
    }) as unknown as typeof fetch;
    const stop = startStream({ url: 'http://api/subdomains/a/stream', token: 'nnt_secret', fetchImpl, sleep: async () => undefined, onEvent: (e) => events.push(e.type) });
    await vi.waitFor(() => expect(events).toEqual(['hello', 'request.created']));
    stop();
    expect(calls[0]!.url).not.toContain('nnt_');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer nnt_secret');
    expect(calls[0]!.init.credentials).toBe('include');
  });

  it('calls onReconnect after a gap and stops on subdomain.deleted', async () => {
    let n = 0;
    const events: string[] = [];
    const statuses: string[] = [];
    const reconnect = vi.fn();
    const fetchImpl = (async () => {
      n++;
      return n === 1 ? sseResponse(['event: hello\ndata: {}\n\n']) : sseResponse(['event: subdomain.deleted\ndata: {}\n\n']);
    }) as unknown as typeof fetch;
    startStream({ url: 'http://x/s', fetchImpl, sleep: async () => undefined, onEvent: (e) => events.push(e.type), onStatus: (s) => statuses.push(s), onReconnect: reconnect });
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('closed'));
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['hello', 'subdomain.deleted']);
    expect(n).toBe(2);
  });

  it('reports fatal auth errors without retrying', async () => {
    const onFatal = vi.fn();
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    startStream({ url: 'http://x/s', fetchImpl, sleep: async () => undefined, onEvent: () => undefined, onFatal });
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith(403));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx with backoff', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n < 3) return new Response('', { status: 502 });
      if (n === 3) return sseResponse(['event: hello\ndata: {}\n\n']);
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const events: string[] = [];
    const stop = startStream({ url: 'http://x/s', fetchImpl, sleep: async () => undefined, onEvent: (e) => events.push(e.type) });
    await vi.waitFor(() => expect(events).toContain('hello'));
    stop();
  });
});
