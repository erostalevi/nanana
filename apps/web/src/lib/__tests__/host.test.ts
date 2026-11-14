import { describe, expect, it } from 'vitest';
import { apexOrigin, apiBaseUrl, detectMode, isDevBase } from '../host';

describe('detectMode', () => {
  it('detects dashboard mode', () => {
    expect(detectMode('k7x2m9qa.tools.nanana.lat')).toEqual({ mode: 'dashboard', slug: 'k7x2m9qa', base: 'nanana.lat' });
    expect(detectMode('my-app.tools.localhost')).toEqual({ mode: 'dashboard', slug: 'my-app', base: 'localhost' });
    expect(detectMode('A1.TOOLS.Nanana.Lat')).toEqual({ mode: 'dashboard', slug: 'a1', base: 'nanana.lat' });
  });
  it('detects landing mode and strips www', () => {
    expect(detectMode('nanana.lat')).toEqual({ mode: 'landing', base: 'nanana.lat' });
    expect(detectMode('www.nanana.lat')).toEqual({ mode: 'landing', base: 'nanana.lat' });
    expect(detectMode('localhost')).toEqual({ mode: 'landing', base: 'localhost' });
  });
  it('does not treat other subdomains or deeper labels as dashboards', () => {
    expect(detectMode('api.nanana.lat').mode).toBe('landing');
    expect(detectMode('tools.nanana.lat').mode).toBe('landing');
    expect(detectMode('x.y.tools.nanana.lat')).toEqual({ mode: 'landing', base: 'x.y.tools.nanana.lat' });
  });
});

describe('apiBaseUrl', () => {
  it('uses VITE_API_URL when set', () => expect(apiBaseUrl('nanana.lat', { VITE_API_URL: 'http://x:1/' })).toBe('http://x:1'));
  it('defaults to api.<base> in prod', () => expect(apiBaseUrl('nanana.lat', {})).toBe('https://api.nanana.lat'));
  it('uses api.localhost:3001 in dev, port overridable', () => {
    expect(apiBaseUrl('localhost', {})).toBe('http://api.localhost:3001');
    expect(apiBaseUrl('localhost', { VITE_API_PORT: '3101' })).toBe('http://api.localhost:3101');
  });
  it('knows dev bases', () => {
    expect(isDevBase('localhost')).toBe(true);
    expect(isDevBase('nanana.lat')).toBe(false);
  });
});

describe('apexOrigin', () => {
  it('keeps protocol and port', () => {
    expect(apexOrigin('localhost', { protocol: 'http:', port: '5173' })).toBe('http://localhost:5173');
    expect(apexOrigin('nanana.lat', { protocol: 'https:', port: '' })).toBe('https://nanana.lat');
  });
});
