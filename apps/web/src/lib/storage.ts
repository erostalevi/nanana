/** Safe localStorage wrappers (can throw or be empty in private modes). */
export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export const replayUrlKey = (slug: string) => `nanana:replay-url:${slug}`;

export function validateHttpUrl(v: string): string | null {
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL must start with http:// or https://';
    return null;
  } catch {
    return 'Enter a full URL, e.g. https://staging.example.com/hook';
  }
}
