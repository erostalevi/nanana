import { test, expect, requestRow } from '../fixtures';
import { sendHook } from '../lib/api';

const clipboard = (page: import('@playwright/test').Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe('landing: create an endpoint from the hero', () => {
  test('creates an endpoint and shows URL, token once, dashboard link and curl', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Catch webhooks.');
    await page.getByRole('button', { name: 'Create an endpoint' }).click();

    const urlCode = page.locator('code', { hasText: /^http:\/\/[a-z0-9]+\.localhost:3201$/ });
    await expect(urlCode).toBeVisible();
    const url = (await urlCode.textContent())!;
    const slug = new URL(url).hostname.split('.')[0]!;

    const tokenCode = page.locator('code', { hasText: /^nnt_[A-Za-z0-9_-]+$/ });
    const token = (await tokenCode.textContent())!;
    expect(token.length).toBeGreaterThan(20);
    await expect(page.getByText('Token (shown once, keep it)')).toBeVisible();

    const open = page.getByRole('link', { name: 'Open dashboard' });
    await expect(open).toHaveAttribute('href', `http://${slug}.tools.localhost:5173/#t=${token}`);
    await expect(page.getByText('The dashboard link contains your token after the #')).toBeVisible();

    const curlBlock = page.locator('pre', { hasText: `curl -X POST ${url}/test` });
    await expect(curlBlock).toContainText(`-H 'content-type: application/json' -d '{"hello":"nanana"}'`);
    await expect(page.locator('pre', { hasText: `nanana -t=${token} -p=3000` })).toBeVisible();

    // The dashboard link really opens a working dashboard (in a new tab) and the URL fragment is consumed.
    const [dash] = await Promise.all([context.waitForEvent('page'), open.click()]);
    await expect(dash.getByRole('status', { name: 'Live stream open' })).toBeVisible();
    expect(dash.url()).not.toContain('#');
    expect(dash.url()).not.toContain(token);
    // ...and the demo curl from the landing page shows up live there.
    const hook = await sendHook(slug, { path: '/test', body: { hello: 'nanana' } });
    expect(hook.status).toBe(200);
    await expect(requestRow(dash, 'POST', '/test')).toBeVisible();
    await dash.close();

    // Token is shown once: "Create another" resets, and a reload never shows the old token again.
    await page.getByRole('button', { name: 'Create another' }).click();
    await expect(page.getByRole('button', { name: 'Create an endpoint' })).toBeVisible();
    await expect(page.getByText(token)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(token)).toHaveCount(0);
    await expect(page.getByText(url)).toHaveCount(0);
  });

  test('copy buttons put the right text on the clipboard', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an endpoint' }).click();
    const urlCode = page.locator('code', { hasText: /^http:\/\/[a-z0-9]+\.localhost:3201$/ });
    const url = (await urlCode.textContent())!;
    const token = (await page.locator('code', { hasText: /^nnt_/ }).textContent())!;
    const slug = new URL(url).hostname.split('.')[0]!;

    await urlCode.locator('xpath=following-sibling::button').click();
    await expect(urlCode.locator('xpath=following-sibling::button')).toContainText('Copied');
    expect(await clipboard(page)).toBe(url);

    await page.locator('code', { hasText: /^nnt_/ }).locator('xpath=following-sibling::button').click();
    expect(await clipboard(page)).toBe(token);

    await page.getByRole('button', { name: 'Copy dashboard link' }).click();
    await expect.poll(() => clipboard(page)).toBe(`http://${slug}.tools.localhost:5173/#t=${token}`);

    // Code blocks: "Send a test webhook" and "Tunnel it to localhost:3000"
    const hero = page.locator('div.card', { hasText: 'Your endpoint URL' });
    const testBlock = hero.locator('div.rounded-lg', { hasText: 'Send a test webhook' });
    await testBlock.getByRole('button', { name: /Copy/ }).click();
    expect(await clipboard(page)).toBe(`curl -X POST ${url}/test -H 'content-type: application/json' -d '{"hello":"nanana"}'`);
    const cliBlock = hero.locator('div.rounded-lg', { hasText: 'Tunnel it to localhost:3000' });
    await cliBlock.getByRole('button', { name: /Copy/ }).click();
    expect(await clipboard(page)).toBe(`nanana -t=${token} -p=3000`);
  });

  test('the copied curl command works against the ingress', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an endpoint' }).click();
    const url = (await page.locator('code', { hasText: /^http:\/\/[a-z0-9]+\.localhost:3201$/ }).textContent())!;
    const slug = new URL(url).hostname.split('.')[0]!;
    const r = await sendHook(slug, { path: '/test', body: { hello: 'nanana' } });
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"ok":true}');
  });

  test('landing sections render and the FAQ expands', async ({ page }) => {
    await page.goto('/');
    for (const h of ['How it works', 'Tunnel to your machine', 'Everything you need to debug a webhook', 'Ephemeral by design', 'Pricing', 'FAQ']) {
      await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible();
    }
    const q = page.getByText('Is it free?');
    await q.click();
    await expect(page.getByText('Anonymous endpoints and free accounts cost nothing')).toBeVisible();
  });
});
