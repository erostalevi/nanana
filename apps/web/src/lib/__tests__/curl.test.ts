import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildCurl, curlHeaders, shellQuote } from '../curl';

/** Round-trips a quoted string through a real shell to prove the escaping is right. */
const hasShell = (sh: string): boolean => spawnSync(sh, ['-c', 'true']).status === 0;

function viaShell(shell: 'bash' | 'zsh', s: string): string {
  return execFileSync(shell, ['-c', `printf '%s' ${shellQuote(s)}`], { encoding: 'utf8' });
}

describe('shellQuote', () => {
  it('uses plain single quotes for printable text', () => {
    expect(shellQuote('hello world')).toBe("'hello world'");
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });
  it('uses $\'...\' for control characters', () => {
    expect(shellQuote('a\nb')).toBe("$'a\\nb'");
    expect(shellQuote("tab\t'q'\\")).toBe("$'tab\\t\\'q\\'\\\\'");
    expect(shellQuote('\x01\x7f')).toBe("$'\\x01\\x7f'");
    expect(shellQuote('\r')).toBe("$'\\r'");
  });
  it('keeps non-ASCII text literal', () => {
    expect(shellQuote('café ✓')).toBe("'café ✓'");
    expect(shellQuote('café\n')).toBe("$'café\\n'");
  });
  it.each(['bash', 'zsh'] as const)('round-trips nasty strings through %s', (sh) => {
    if (!hasShell(sh)) return; // zsh is not installed on every CI runner
    const samples = ["plain", "it's a 'test'", 'line1\nline2\r\n', '\ttab\\back\\slash', '$HOME `id` $(id) "dq"', 'café ✓ \u{1F600}', 'a\x01b\x1fc\x7fd', '!history ! #hash', ''];
    for (const s of samples) expect(viaShell(sh, s)).toBe(s);
  });
});

describe('curlHeaders', () => {
  it('drops hop-by-hop, host and content-length, expands arrays', () => {
    const h = curlHeaders({ Host: 'x', 'Content-Length': '3', Connection: 'close', 'Transfer-Encoding': 'chunked', 'X-A': ['1', '2'], 'content-type': 'text/plain' });
    expect(h).toEqual([['X-A', '1'], ['X-A', '2'], ['content-type', 'text/plain']]);
  });
});

describe('buildCurl', () => {
  it('builds a simple GET without -X', () => {
    expect(buildCurl({ method: 'GET', url: 'https://a.test/x?y=1', headers: { accept: '*/*' }, body: null })).toBe("curl 'https://a.test/x?y=1' \\\n  -H 'accept: */*'");
  });
  it('builds a utf8 POST with --data-binary and escaped quotes', () => {
    const out = buildCurl({ method: 'POST', url: 'https://a.test/hook', headers: { 'content-type': 'application/json', host: 'a.test', 'content-length': '15' }, body: { encoding: 'utf8', data: `{"a":"it's"}` } });
    expect(out).toBe(`curl -X POST 'https://a.test/hook' \\\n  -H 'content-type: application/json' \\\n  --data-binary '{"a":"it'\\''s"}'`);
  });
  it('uses $\'..\' for multi-line utf8 bodies', () => {
    const out = buildCurl({ method: 'PUT', url: 'http://l/x', headers: {}, body: { encoding: 'utf8', data: 'a\nb' } });
    expect(out).toContain("--data-binary $'a\\nb'");
  });
  it('uses the base64 pipe form for binary bodies', () => {
    const out = buildCurl({ method: 'POST', url: 'http://l/x', headers: { 'content-type': 'application/octet-stream' }, body: { encoding: 'base64', data: 'AAEC/w==' } });
    expect(out.startsWith("printf '%s' 'AAEC/w==' | base64 -d | curl -X POST 'http://l/x'")).toBe(true);
    expect(out.endsWith('--data-binary @-')).toBe(true);
  });
  it('falls back to the pipe form when utf8 body holds a NUL', () => {
    const out = buildCurl({ method: 'POST', url: 'http://l/x', headers: {}, body: { encoding: 'utf8', data: 'a\u0000b' } });
    expect(out).toContain("printf '%s' 'YQBi' | base64 -d | curl");
  });
  it('reproduces the exact bytes of a binary body when executed', () => {
    const out = buildCurl({ method: 'POST', url: 'http://l/x', headers: {}, body: { encoding: 'base64', data: 'AAEC/w==' } });
    const pipe = out.split(' | curl')[0]!; // printf ... | base64 -d
    const hex = execFileSync('bash', ['-c', `${pipe} | xxd -p`], { encoding: 'utf8' }).trim();
    expect(hex).toBe('000102ff');
  });
  it('uses -I for HEAD, notes truncation, and handles empty bodies', () => {
    expect(buildCurl({ method: 'HEAD', url: 'http://l/', headers: {}, body: null })).toBe("curl -I 'http://l/'");
    expect(buildCurl({ method: 'POST', url: 'http://l/', headers: {}, body: { encoding: 'utf8', data: '' } })).toBe("curl -X POST 'http://l/'");
    expect(buildCurl({ method: 'POST', url: 'http://l/', headers: {}, body: { encoding: 'utf8', data: 'x', truncated: true } })).toMatch(/^# note: .*truncated/);
  });
});
