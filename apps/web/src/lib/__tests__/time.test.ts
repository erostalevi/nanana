import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MIN, SEC, expiryInfo, formatBytes, formatCountdown, relativeTime } from '../time';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('relativeTime', () => {
  it('formats ranges', () => {
    expect(relativeTime(ago(1000), NOW)).toBe('just now');
    expect(relativeTime(ago(42 * SEC), NOW)).toBe('42s ago');
    expect(relativeTime(ago(5 * MIN + 10 * SEC), NOW)).toBe('5m ago');
    expect(relativeTime(ago(3 * HOUR), NOW)).toBe('3h ago');
    expect(relativeTime(ago(2 * DAY), NOW)).toBe('2d ago');
  });
  it('never goes negative (clock skew)', () => expect(relativeTime(new Date(NOW + 5000).toISOString(), NOW)).toBe('just now'));
});

describe('formatCountdown', () => {
  it('formats compactly', () => {
    expect(formatCountdown(6 * DAY + 23 * HOUR + 5 * MIN)).toBe('6d 23h');
    expect(formatCountdown(3 * HOUR + 12 * MIN)).toBe('3h 12m');
    expect(formatCountdown(4 * MIN + 5 * SEC)).toBe('4m 05s');
    expect(formatCountdown(42 * SEC)).toBe('42s');
    expect(formatCountdown(0)).toBe('now');
    expect(formatCountdown(-5)).toBe('now');
  });
});

describe('expiryInfo', () => {
  it('computes sleep, idle death and hard expiry', () => {
    const e = expiryInfo({ state: 'active', lastActivityAt: ago(20 * MIN), hardExpiresAt: new Date(NOW + 3 * DAY).toISOString() }, NOW);
    expect(e.sleepsInMs).toBe(40 * MIN);
    expect(e.idleDeathMs).toBe(23 * HOUR + 40 * MIN);
    expect(e.hardMs).toBe(3 * DAY);
    expect(e.limitedBy).toBe('idle');
    expect(e.goneInMs).toBe(e.idleDeathMs);
  });
  it('cold has no sleep timer; hard limit can win', () => {
    const e = expiryInfo({ state: 'cold', lastActivityAt: ago(2 * HOUR), hardExpiresAt: new Date(NOW + 3 * HOUR).toISOString() }, NOW);
    expect(e.sleepsInMs).toBeNull();
    expect(e.limitedBy).toBe('hard');
    expect(e.goneInMs).toBe(3 * HOUR);
  });
});

describe('formatBytes', () => {
  it('formats', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024)).toBe('50 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
