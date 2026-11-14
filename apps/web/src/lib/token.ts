const key = (slug: string) => `nanana:token:${slug}`;
const TOKEN_RE = /^nn[ta]_[A-Za-z0-9_-]+$/;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function getStoredToken(slug: string, storage: StorageLike = sessionStorage): string | null {
  try {
    return storage.getItem(key(slug));
  } catch {
    return null;
  }
}

export function clearStoredToken(slug: string, storage: StorageLike = sessionStorage): void {
  try {
    storage.removeItem(key(slug));
  } catch {
    /* ignore */
  }
}

/**
 * Reads `#t=nnt_...` from the URL fragment, moves it to sessionStorage (keyed by slug) and strips the
 * fragment with history.replaceState. Returns the active token (fragment first, then storage) or null.
 * The token never touches a query string and is never logged.
 */
export function consumeFragmentToken(
  slug: string,
  loc: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
  hist: Pick<History, 'replaceState' | 'state'> = window.history,
  storage: StorageLike = sessionStorage,
): string | null {
  const hash = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  if (hash) {
    const t = new URLSearchParams(hash).get('t');
    if (t && TOKEN_RE.test(t)) {
      try {
        storage.setItem(key(slug), t);
      } catch {
        /* storage blocked: token lives for this page load only via return value */
      }
      hist.replaceState(hist.state, '', loc.pathname + loc.search);
      return t;
    }
  }
  return getStoredToken(slug, storage);
}
