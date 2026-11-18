import { test, expect } from '../fixtures';
import { A11yRun } from '../lib/a11y';
import { signIn } from '../lib/api';
import { API_URL } from '../lib/env';

const now = Date.now();
const series = Array.from({ length: 60 }, (_, i) => ({
  minute: now - (59 - i) * 60_000,
  captured: i < 20 ? 0 : Math.round(12 + 10 * Math.sin(i / 4)),
  rejected: i % 9 === 0 ? 3 : 0,
  tunneled: i % 3 === 0 ? 4 : 0,
  avgLatencyMs: 40 + (i % 7) * 5,
  maxLatencyMs: 120,
}));
const stats = {
  accounts: 42,
  subdomains: { total: 130, active: 90, cold: 40, anonymous: 100, custom: 9 },
  tunnelsOnline: 6,
  capturedRequests: 5821,
  requestsLastHour: 640,
  uptimeSeconds: 93_000,
  version: '0.1.0',
  generatedAt: new Date().toISOString(),
  traffic: {
    since: new Date(now - 3 * 3600_000).toISOString(),
    series,
    perMinuteNow: 14,
    lastFiveMinutes: 70,
    lastHour: 640,
    rejectedLastHour: 18,
    tunneledLastHour: 212,
    avgLatencyMs: 52,
    topEndpoints: [{ slug: 'k7x2m9qa', requests: 311 }, { slug: 'my-shop', requests: 120 }],
  },
  growth: { signups24h: 3, signups7d: 11, endpointsCreated24h: 27, plans: { free: 38, pro: 3, pro_grace: 1, lapsed: 0 } },
  revenue: { currency: 'usd', mrrCents: 2467, arrCents: 29600, payingSubscribers: 4, monthly: 2, yearly: 2, pastDue: 1, cancelingAtPeriodEnd: 1, billingEnabled: true },
  health: {
    cpus: 2, load1: 0.42, loadPct: 21, memAvailableMb: 380, memTotalMb: 914, apiRssMb: 142, apiHeapMb: 61, eventLoopP99Ms: 11, eventLoopMaxMs: 40,
    db: { pingMs: 3, sizeMb: 310, capturesMb: 120, connections: 7, volumeMb: 10240 },
  },
};

for (const theme of ['light', 'dark'] as const) {
  for (const [vp, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 375, height: 812 }]] as const) {
    test.use({ colorScheme: theme });
    test(`admin dashboard: ${vp} ${theme}`, async ({ page, context }, testInfo) => {
      await page.setViewportSize(viewport);
      await context.addInitScript((t) => localStorage.setItem('nanana:theme', t), theme);
      await signIn(context);
      await page.route(`${API_URL}/admin/stats`, (route) => {
        const origin = route.request().headers().origin ?? '*';
        const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'origin' };
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(stats) });
      });
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
      await expect(page.getByText('$24.67')).toBeVisible(); // MRR
      await expect(page.getByText('Paying subscribers')).toBeVisible();
      await expect(page.getByRole('img', { name: /Requests per minute over the last hour/ })).toBeVisible();
      await expect(page.getByRole('meter', { name: 'Memory available' })).toBeVisible();
      await expect(page.getByText('k7x2m9qa')).toBeVisible();
      const shot = await page.screenshot({ fullPage: true, path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/admin-${vp}-${theme}.png` : undefined });
      await testInfo.attach('admin', { body: shot, contentType: 'image/png' });
      const run = new A11yRun(`admin ${vp} ${theme}`);
      await run.scan(page, 'admin dashboard');
      await run.save(testInfo);
      expect(run.blocking.length, `serious/critical a11y violations:\n${run.describe(run.blocking).join('\n')}`).toBe(0);

    });
  }
}