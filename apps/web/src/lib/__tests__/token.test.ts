import { describe, expect, it, vi } from 'vitest';
import { clearStoredToken, consumeFragmentToken, getStoredToken } from '../token';

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe('consumeFragmentToken', () => {
  it('moves #t=nnt_ into storage keyed by slug and strips the fragment', () => {
    const storage = mem();
    const hist = { state: { x: 1 }, replaceState: vi.fn() };
    const t = consumeFragmentToken('abc', { hash: '#t=nnt_AbC-123_x', pathname: '/', search: '?q=1' }, hist, storage);
    expect(t).toBe('nnt_AbC-123_x');
    expect(storage.m.get('nanana:token:abc')).toBe('nnt_AbC-123_x');
    expect(hist.replaceState).toHaveBeenCalledWith({ x: 1 }, '', '/?q=1');
  });
  it('falls back to the stored token when there is no fragment', () => {
    const storage = mem();
    storage.setItem('nanana:token:abc', 'nnt_stored');
    const hist = { state: null, replaceState: vi.fn() };
    expect(consumeFragmentToken('abc', { hash: '', pathname: '/', search: '' }, hist, storage)).toBe('nnt_stored');
    expect(hist.replaceState).not.toHaveBeenCalled();
    expect(consumeFragmentToken('other', { hash: '', pathname: '/', search: '' }, hist, storage)).toBeNull();
  });
  it('ignores malformed tokens and unrelated fragments', () => {
    const storage = mem();
    const hist = { state: null, replaceState: vi.fn() };
    expect(consumeFragmentToken('abc', { hash: '#t=evil<script>', pathname: '/', search: '' }, hist, storage)).toBeNull();
    expect(consumeFragmentToken('abc', { hash: '#other=1', pathname: '/', search: '' }, hist, storage)).toBeNull();
    expect(hist.replaceState).not.toHaveBeenCalled();
    expect(storage.m.size).toBe(0);
  });
  it('still returns the token when storage throws', () => {
    const storage = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => undefined };
    const hist = { state: null, replaceState: vi.fn() };
    expect(consumeFragmentToken('abc', { hash: '#t=nnt_ok', pathname: '/p', search: '' }, hist, storage)).toBe('nnt_ok');
    expect(hist.replaceState).toHaveBeenCalledWith(null, '', '/p');
  });
  it('get/clear helpers work', () => {
    const storage = mem();
    storage.setItem('nanana:token:z', 'nnt_z');
    expect(getStoredToken('z', storage)).toBe('nnt_z');
    clearStoredToken('z', storage);
    expect(getStoredToken('z', storage)).toBeNull();
  });
  it('works against the real window.history in jsdom', () => {
    window.history.replaceState(null, '', '/dash#t=nnt_real');
    const t = consumeFragmentToken('real');
    expect(t).toBe('nnt_real');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/dash');
    expect(sessionStorage.getItem('nanana:token:real')).toBe('nnt_real');
  });
});
