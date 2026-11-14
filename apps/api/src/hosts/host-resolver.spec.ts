import { resolveHost, isValidSlug } from './host-resolver.js';

describe('resolveHost', () => {
  const r = (h?: string, b = 'nanana.lat') => resolveHost(h, b);

  it('routes apex and www to web', () => {
    expect(r('nanana.lat')).toEqual({ kind: 'web' });
    expect(r('WWW.nanana.lat:443')).toEqual({ kind: 'web' });
  });
  it('routes api', () => expect(r('api.nanana.lat')).toEqual({ kind: 'api' }));
  it('routes ingress and dashboard', () => {
    expect(r('k7x2m9qa.nanana.lat')).toEqual({ kind: 'ingress', slug: 'k7x2m9qa' });
    expect(r('k7x2m9qa.tools.nanana.lat')).toEqual({ kind: 'dashboard', slug: 'k7x2m9qa' });
  });
  it('rejects reserved, nested, foreign and missing hosts', () => {
    expect(r('admin.nanana.lat')).toEqual({ kind: 'unknown' });
    expect(r('a.b.c.nanana.lat')).toEqual({ kind: 'unknown' });
    expect(r('tools.k7x2m9qa.nanana.lat')).toEqual({ kind: 'unknown' });
    expect(r('evilnanana.lat')).toEqual({ kind: 'unknown' });
    expect(r('abc.example.com')).toEqual({ kind: 'unknown' });
    expect(r(undefined)).toEqual({ kind: 'unknown' });
  });
  it('works with localhost base for dev', () => {
    expect(r('abc.localhost:3001', 'localhost')).toEqual({ kind: 'ingress', slug: 'abc' });
    expect(r('abc.tools.localhost:3001', 'localhost')).toEqual({ kind: 'dashboard', slug: 'abc' });
  });
});

describe('isValidSlug', () => {
  it('validates custom names', () => {
    expect(isValidSlug('stripe-test')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('-abc')).toBe(false);
    expect(isValidSlug('abc-')).toBe(false);
    expect(isValidSlug('xn--abc')).toBe(false);
    expect(isValidSlug('Abc')).toBe(false);
    expect(isValidSlug('a'.repeat(33))).toBe(false);
    expect(isValidSlug('a'.repeat(32))).toBe(true);
  });
});
