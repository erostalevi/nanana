import { describe, expect, it } from 'vitest';
import { parseQuery, renderBody, toHex } from '../body';

describe('renderBody', () => {
  it('handles empty', () => {
    expect(renderBody(null).kind).toBe('empty');
    expect(renderBody({ encoding: 'utf8', data: '' }).kind).toBe('empty');
  });
  it('parses JSON by content-type', () => {
    const v = renderBody({ encoding: 'utf8', data: '{"a":[1,2],"b":null}' }, 'application/json; charset=utf-8');
    expect(v.kind).toBe('json');
    if (v.kind === 'json') {
      expect(v.value).toEqual({ a: [1, 2], b: null });
      expect(v.pretty).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": null\n}');
      expect(v.raw).toBe('{"a":[1,2],"b":null}');
    }
  });
  it('sniffs JSON without a content-type, but falls back to text on invalid JSON', () => {
    expect(renderBody({ encoding: 'utf8', data: '[1,2]' }).kind).toBe('json');
    expect(renderBody({ encoding: 'utf8', data: '{not json' }, 'application/json').kind).toBe('text');
    expect(renderBody({ encoding: 'utf8', data: '42' }, 'application/json').kind).toBe('text');
  });
  it('parses form-urlencoded into pairs, decoding values and keeping duplicates', () => {
    const v = renderBody({ encoding: 'utf8', data: 'a=1&b=hello+world&c=%C3%A9&a=2' }, 'application/x-www-form-urlencoded');
    expect(v.kind).toBe('form');
    if (v.kind === 'form') expect(v.pairs).toEqual([['a', '1'], ['b', 'hello world'], ['c', 'é'], ['a', '2']]);
  });
  it('treats base64 as binary and decodes bytes', () => {
    const v = renderBody({ encoding: 'base64', data: 'AAEC/w==', truncated: true }, 'application/octet-stream');
    expect(v.kind).toBe('binary');
    if (v.kind === 'binary') {
      expect(Array.from(v.bytes)).toEqual([0, 1, 2, 255]);
      expect(v.base64).toBe('AAEC/w==');
      expect(v.truncated).toBe(true);
    }
  });
  it('keeps plain text and never interprets HTML', () => {
    const v = renderBody({ encoding: 'utf8', data: '<script>alert(1)</script>' }, 'text/html');
    expect(v).toEqual({ kind: 'text', text: '<script>alert(1)</script>', truncated: false });
  });
});

describe('toHex', () => {
  it('formats a hexdump with offset and ascii gutter', () => {
    const out = toHex(new Uint8Array([0x68, 0x69, 0x00, 0xff]));
    expect(out).toBe(`00000000  68 69 00 ff${' '.repeat(47 - 11)}  hi..`);
  });
  it('wraps at 16 bytes', () => {
    expect(toHex(new Uint8Array(17)).split('\n')).toHaveLength(2);
  });
});

describe('parseQuery', () => {
  it('splits path and query', () => {
    expect(parseQuery('/pay?x=1&y=a%20b')).toEqual({ pathname: '/pay', pairs: [['x', '1'], ['y', 'a b']] });
    expect(parseQuery('/plain')).toEqual({ pathname: '/plain', pairs: [] });
  });
});
