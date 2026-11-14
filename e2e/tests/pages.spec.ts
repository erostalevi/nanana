import { test, expect, openDashboard, requestRow } from '../fixtures';
import { sendHook } from '../lib/api';

test.describe('static pages', () => {
  const pages: [string, string, RegExp | string][] = [
    ['/docs', 'Docs', 'Quick start'],
    ['/terms', 'Terms of Service', 'Acceptable use'],
    ['/privacy', 'Privacy', 'Your rights'],
    ['/abuse', 'Abuse and takedown', 'How to report'],
  ];
  for (const [path, h1, h2] of pages) {
    test(`${path} renders`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: h2 })).toBeVisible();
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page).toHaveTitle(/.+/);
    });
  }

  test('docs: sections are all present and deep links scroll to them', async ({ page }) => {
    await page.goto('/docs');
    for (const h of ['Quick start', 'CLI install and commands', 'How the tunnel works', 'HMAC signature check', 'Response mocking', 'Replay', 'Limits and lifecycle', 'Provider recipes', 'Accounts']) {
      await expect(page.getByRole('heading', { level: 2, name: h, exact: true })).toBeVisible();
    }
    await page.goto('/docs#recipes');
    await expect(page.getByRole('heading', { level: 2, name: 'Provider recipes' })).toBeInViewport();
  });

  test('unknown routes show the 404 page with a way home', async ({ page }) => {
    await page.goto('/definitely/not/here');
    await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
    await expect(page.getByText('This page does not exist.')).toBeVisible();
    await page.getByRole('link', { name: 'Back home' }).click();
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Catch webhooks.');
  });

  test('footer links work', async ({ page }) => {
    await page.goto('/');
    const footer = page.getByRole('navigation', { name: 'Footer' });
    for (const [name, url, h1] of [['Docs', /\/docs$/, 'Docs'], ['Terms', /\/terms$/, 'Terms of Service'], ['Privacy', /\/privacy$/, 'Privacy'], ['Abuse', /\/abuse$/, 'Abuse and takedown']] as const) {
      await footer.getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
    }
    await expect(footer.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', /^https:\/\/github\.com\//);
    // header nav + logo
    await page.getByRole('link', { name: 'nanana home' }).click();
    await expect(page).toHaveURL('http://localhost:5173/');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pricing' }).click();
    await expect(page.getByRole('heading', { name: 'Pricing' })).toBeInViewport();
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('skip link jumps to the main content', async ({ page }) => {
    await page.goto('/docs');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });
});

test.describe('theme', () => {
  test('toggle switches theme and persists across reloads and pages', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('nanana:theme'))).toBe('light');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(251, 248, 243)');

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.goto('/docs');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(20, 17, 15)');
  });

  test('defaults to the system preference', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('the dashboard has its own working toggle', async ({ page, endpoint }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openDashboard(page, endpoint);
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('mobile (375x812)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  const noOverflow = async (page: import('@playwright/test').Page, where: string) => {
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
    expect(m.sw, `${where}: documentElement scrollWidth ${m.sw} > clientWidth ${m.cw}`).toBeLessThanOrEqual(m.cw);
    expect(m.bw, `${where}: body scrollWidth ${m.bw} > ${m.cw}`).toBeLessThanOrEqual(m.cw);
  };

  test('site pages do not overflow horizontally', async ({ page }) => {
    for (const p of ['/', '/docs', '/login', '/device', '/terms', '/privacy', '/abuse', '/nope']) {
      await page.goto(p);
      await expect(page.getByRole('main')).toBeVisible();
      await noOverflow(page, p);
    }
  });

  test('landing: created endpoint card fits and the mobile menu works', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an endpoint' }).click();
    await expect(page.getByText('Your endpoint URL')).toBeVisible();
    await noOverflow(page, 'landing after create');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
    await page.getByRole('button', { name: 'Toggle menu' }).click();
    const mobileNav = page.getByRole('navigation', { name: 'Mobile' });
    await expect(mobileNav).toBeVisible();
    await mobileNav.getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(mobileNav).toHaveCount(0);
  });

  test('dashboard: list -> detail -> back (master/detail) with no overflow', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await noOverflow(page, 'dashboard empty');
    const longPath = '/a/very/long/path/segment/that/keeps/going/and/going/and/going?with=query&and=more&even=more';
    await sendHook(endpoint.slug, { path: '/short', body: { a: 1 } });
    await sendHook(endpoint.slug, { path: longPath, headers: { 'x-long-header': 'v'.repeat(200) }, body: { text: 'w'.repeat(300) } });
    const list = page.getByRole('region', { name: 'Requests' });
    const detail = page.getByRole('region', { name: 'Request details' });
    await expect(requestRow(page, 'POST', '/short')).toBeVisible();
    await expect(requestRow(page, 'POST', longPath)).toBeVisible();
    // master only: nothing is auto-selected on small screens
    await expect(list).toBeVisible();
    await expect(detail).toBeHidden();
    await noOverflow(page, 'dashboard list');

    await requestRow(page, 'POST', longPath).click();
    await expect(detail).toBeVisible();
    await expect(list).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Request' })).toBeVisible();
    await noOverflow(page, 'dashboard detail');
    for (const tab of ['Response', 'Signature', 'Replays']) {
      await page.getByRole('tab', { name: tab }).click();
      await noOverflow(page, `dashboard ${tab}`);
    }

    await page.getByRole('button', { name: 'Requests', exact: true }).click();
    await expect(list).toBeVisible();
    await expect(detail).toBeHidden();
    await requestRow(page, 'POST', '/short').click();
    await expect(page.getByRole('heading', { level: 2, name: '/short' })).toBeVisible();
  });

  test('dashboard dialogs fit on a phone', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Endpoint settings' })).toBeVisible();
    await noOverflow(page, 'settings dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Mock/ }).click();
    await expect(page.getByRole('dialog', { name: 'Mock the next responses' })).toBeVisible();
    await noOverflow(page, 'mock dialog');
  });
});
