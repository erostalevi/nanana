import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Node >= 25 ships an experimental global localStorage that shadows jsdom's and is unusable without a file.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => Array.from(m.keys())[i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  try {
    void window[name].getItem('x');
  } catch {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
  }
  if (!window[name] || typeof window[name].getItem !== 'function') {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
  }
}

afterEach(() => {
  cleanup();
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
