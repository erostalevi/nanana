import { test, expect, openDashboard, requestRow } from '../fixtures';
import { sendHook } from '../lib/api';

test.describe('mock rule', () => {
  test('500 twice, then 200; the remaining counter updates live', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    const header = page.getByRole('banner');

    await header.getByRole('button', { name: /^Mock/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Mock the next responses' });
    await expect(dialog.getByText('No mock rule active.')).toBeVisible();
    await dialog.getByLabel('Status').fill('500');
    await dialog.getByLabel('Times (1 to 50)').fill('2');
    await dialog.getByLabel('Body').fill('{"error":"mocked by nanana"}');
    await dialog.getByRole('button', { name: 'Start mock' }).click();
    await expect(dialog).toHaveCount(0);

    const mockBtn = header.getByRole('button', { name: /^Mock/ });
    await expect(mockBtn).toContainText('500 x2');

    const first = await sendHook(endpoint.slug, { path: '/m1' });
    expect(first.status).toBe(500);
    expect(first.text).toBe('{"error":"mocked by nanana"}');
    await expect(mockBtn).toContainText('500 x1');

    const second = await sendHook(endpoint.slug, { path: '/m2' });
    expect(second.status).toBe(500);
    // rule exhausted: chip disappears live
    await expect(mockBtn).not.toContainText('500');

    const third = await sendHook(endpoint.slug, { path: '/m3' });
    expect(third.status).toBe(200);
    expect(third.text).toBe('{"ok":true}');

    await expect(requestRow(page, 'POST', '/m1')).toContainText('500');
    await expect(requestRow(page, 'POST', '/m1')).toContainText('mock');
    await expect(requestRow(page, 'POST', '/m2')).toContainText('500');
    await expect(requestRow(page, 'POST', '/m3')).toContainText('200');
    await expect(requestRow(page, 'POST', '/m3')).not.toContainText('mock');

    // The Response tab says the mock answered
    await requestRow(page, 'POST', '/m1').click();
    await page.getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('(mock rule)');
  });

  test('custom response headers are served, and clear removes the rule', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await page.getByRole('banner').getByRole('button', { name: /^Mock/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Mock the next responses' });
    await dialog.getByLabel('Status').fill('503');
    await dialog.getByLabel('Times (1 to 50)').fill('5');
    await dialog.getByRole('button', { name: 'Add header' }).click();
    await dialog.getByLabel('Header name 2').fill('x-mocked');
    await dialog.getByLabel('Header value 2').fill('yes');
    await dialog.getByRole('button', { name: 'Start mock' }).click();

    const mockBtn = page.getByRole('banner').getByRole('button', { name: /^Mock/ });
    await expect(mockBtn).toContainText('503 x5');
    const r = await sendHook(endpoint.slug, { path: '/h' });
    expect(r.status).toBe(503);
    expect(r.headers['x-mocked']).toBe('yes');
    await expect(mockBtn).toContainText('503 x4');

    // reopen the dialog: shows the live remaining count, then clear
    await mockBtn.click();
    const d2 = page.getByRole('dialog', { name: 'Mock the next responses' });
    await expect(d2.getByText(/Active: respond 503, 4 uses left\./)).toBeVisible();
    await d2.getByRole('button', { name: 'Clear mock' }).click();
    await expect(d2.getByText('No mock rule active.')).toBeVisible();
    await expect(mockBtn).not.toContainText('503');
    // The button that had focus ("Clear mock") is gone, but Escape must still close the dialog.
    await page.keyboard.press('Escape');
    await expect(d2).toHaveCount(0);
    expect((await sendHook(endpoint.slug, { path: '/after-clear' })).status).toBe(200);
  });

  test('validation: status and times ranges', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await page.getByRole('banner').getByRole('button', { name: /^Mock/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Mock the next responses' });
    await dialog.getByLabel('Status').fill('42');
    await dialog.getByRole('button', { name: 'Start mock' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Status must be between 100 and 599');
    await dialog.getByLabel('Status').fill('500');
    await dialog.getByLabel('Times (1 to 50)').fill('51');
    await dialog.getByRole('button', { name: 'Start mock' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Times must be between 1 and 50');
  });

  test('a mock set from outside (API) shows up in the open dashboard live', async ({ page, endpoint, api }) => {
    await openDashboard(page, endpoint);
    const res = await api.post(`http://localhost:3201/subdomains/${endpoint.slug}/mock`, { headers: { authorization: `Bearer ${endpoint.token}` }, data: { status: 418, times: 3 } });
    expect([200, 201]).toContain(res.status());
    await expect(page.getByRole('banner').getByRole('button', { name: /^Mock/ })).toContainText('418 x3');
  });
});
