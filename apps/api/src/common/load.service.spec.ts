import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetricsService } from '../admin/metrics.service.js';
import type { AppConfig } from '../config/app-config.js';
import { computeScore, LoadService } from './load.service.js';

const make = (shedEnabled = true, p99 = 0) => {
  const metrics = { takeEventLoopP99Ms: vi.fn(() => p99) } as unknown as MetricsService;
  return { svc: new LoadService({ shedEnabled } as AppConfig, metrics), metrics };
};
const rate = (svc: LoadService, plan: string | null, n = 1000) => {
  let shed = 0;
  for (let i = 0; i < n; i++) if (svc.shouldShed(plan, () => (i + 0.5) / n).shed) shed++;
  return shed / n;
};

afterEach(() => vi.useRealTimers());

describe('computeScore', () => {
  it('is 0 below the low thresholds and 1 at the high ones', () => {
    expect(computeScore(100, 100)).toBe(0);
    expect(computeScore(0, 0)).toBe(0);
    expect(computeScore(400, 0)).toBe(1);
    expect(computeScore(0, 500)).toBe(1);
    expect(computeScore(9999, 9999)).toBe(1);
  });
  it('is linear and takes the max of both signals', () => {
    expect(computeScore(250, 0)).toBeCloseTo(0.5);
    expect(computeScore(0, 300)).toBeCloseTo(0.5);
    expect(computeScore(190, 200)).toBeCloseTo(0.3);
  });
});

describe('shouldShed', () => {
  it('free and anonymous shed with probability = score', () => {
    const { svc } = make();
    svc.setScoreForTest(0.3);
    expect(rate(svc, 'free')).toBeCloseTo(0.3, 2);
    expect(rate(svc, null)).toBeCloseTo(0.3, 2);
    expect(rate(svc, 'lapsed')).toBeCloseTo(0.3, 2);
  });
  it('pro is untouched at score <= 0.5 and shed at (score-0.5)*2 above', () => {
    const { svc } = make();
    svc.setScoreForTest(0.5);
    expect(rate(svc, 'pro')).toBe(0);
    svc.setScoreForTest(0.75);
    expect(rate(svc, 'pro')).toBeCloseTo(0.5, 2);
    expect(rate(svc, 'pro_grace')).toBeCloseTo(0.5, 2);
    svc.setScoreForTest(1);
    expect(rate(svc, 'pro')).toBe(1);
  });
  it('never sheds when disabled or healthy', () => {
    const off = make(false).svc;
    off.setScoreForTest(1);
    expect(rate(off, 'free')).toBe(0);
    const ok = make().svc;
    expect(rate(ok, 'free')).toBe(0);
  });
  it('retryAfterSec is an integer in 1..6', () => {
    const { svc } = make();
    for (const s of [0.01, 0.5, 1]) {
      svc.setScoreForTest(s);
      for (let i = 0; i < 200; i++) {
        const d = svc.shouldShed(null, () => 0);
        expect(d.shed).toBe(true);
        expect(Number.isInteger(d.retryAfterSec)).toBe(true);
        expect(d.retryAfterSec).toBeGreaterThanOrEqual(1);
        expect(d.retryAfterSec).toBeLessThanOrEqual(6);
      }
    }
  });
  it('setScoreForTest(null) restores the measured score', () => {
    const { svc } = make();
    svc.tick(400);
    svc.setScoreForTest(0);
    expect(svc.score).toBe(0);
    svc.setScoreForTest(null);
    expect(svc.score).toBe(1);
  });
});

describe('signals', () => {
  it('lag rises immediately and falls ~50% per sample', () => {
    const { svc } = make();
    svc.tick(400);
    expect(svc.signals.lagMs).toBe(400);
    svc.tick(0);
    expect(svc.signals.lagMs).toBe(200);
    svc.tick(0);
    expect(svc.signals.lagMs).toBe(100);
    expect(svc.score).toBe(0);
    svc.tick(300);
    expect(svc.signals.lagMs).toBe(300);
  });
  it('db EWMA follows samples and decays toward 0 when none arrive', () => {
    const { svc } = make();
    for (let i = 0; i < 40; i++) svc.observeDb(600);
    svc.tick(0);
    expect(svc.signals.dbMs).toBeGreaterThan(500);
    expect(svc.score).toBe(1);
    for (let i = 0; i < 60; i++) svc.tick(0);
    expect(svc.signals.dbMs).toBeLessThan(5);
    expect(svc.score).toBe(0);
  });
  it('a window with samples does not decay', () => {
    const { svc } = make();
    svc.observeDb(1000);
    const before = svc.signals.dbMs;
    svc.tick(0);
    expect(svc.signals.dbMs).toBe(before);
  });
});

describe('logging', () => {
  it('logs at most once per 10 s on crossing up and down', () => {
    const { svc } = make();
    const warn = vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
    const log = vi.spyOn((svc as any).logger, 'log').mockImplementation(() => {});
    svc.tick(400, 100_000);
    svc.tick(400, 100_250);
    expect(warn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) svc.tick(0, 100_500 + i * 250); // recovered but within 10 s
    expect(log).not.toHaveBeenCalled();
    svc.tick(0, 111_000);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('timer lifecycle', () => {
  it('samples the metrics histogram on an unref-ed interval and clears it on destroy', () => {
    vi.useFakeTimers();
    const { svc, metrics } = make(true, 400);
    svc.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    expect(metrics.takeEventLoopP99Ms).toHaveBeenCalledTimes(1);
    expect(svc.score).toBe(1);
    svc.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not keep the process alive', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as never);
    const { svc } = make();
    svc.onModuleInit();
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });
});
