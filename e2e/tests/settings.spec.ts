import { test, expect, openDashboard, requestRow } from '../fixtures';
import { apiCall, sendHook } from '../lib/api';

test.describe('settings dialog', () => {
  test('offline status and body persist and are served', async ({ page, endpoint, api }) => {
    await openDashboard(page, endpoint);
    const settingsBtn = page.getByRole('button', { name: 'Settings' });
    await settingsBtn.click();
    const dialog = page.getByRole('dialog', { name: 'Endpoint settings' });
    await expect(dialog.getByLabel('Status')).toHaveValue('200');
    await expect(dialog.getByLabel(/Body \(max 4096 bytes\)/)).toHaveValue('{"ok":true}');

    await dialog.getByLabel('Status').fill('503');
    await dialog.getByLabel(/Body \(max 4096 bytes\)/).fill('maintenance window');
    await dialog.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog).toHaveCount(0);

    const r = await sendHook(endpoint.slug, { path: '/down' });
    expect(r.status).toBe(503);
    expect(r.text).toBe('maintenance window');
    await expect(requestRow(page, 'POST', '/down')).toContainText('503');

    // persisted server-side and after a full reload
    const sub = await apiCall<{ offlineStatus: number; offlineBody: string }>(api, 'GET', `/subdomains/${endpoint.slug}`, { token: endpoint.token });
    expect(sub.body).toMatchObject({ offlineStatus: 503, offlineBody: 'maintenance window' });
    await page.reload();
    await expect(page.getByRole('status', { name: 'Live stream open' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    const d2 = page.getByRole('dialog', { name: 'Endpoint settings' });
    await expect(d2.getByLabel('Status')).toHaveValue('503');
    await expect(d2.getByLabel(/Body \(max 4096 bytes\)/)).toHaveValue('maintenance window');
  });

  test('validation errors, Escape closes and restores focus', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    const settingsBtn = page.getByRole('button', { name: 'Settings' });
    await settingsBtn.click();
    const dialog = page.getByRole('dialog', { name: 'Endpoint settings' });
    // focus moves into the dialog on open
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);

    await dialog.getByLabel('Status').fill('99');
    await dialog.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog.getByRole('alert')).toContainText('between 100 and 599');
    await dialog.getByLabel('Status').fill('abc');
    await dialog.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog.getByRole('alert')).toContainText('whole number');
    await dialog.getByLabel('Status').fill('200');
    await dialog.getByLabel(/Body \(max 4096 bytes\)/).fill('x'.repeat(4097));
    await dialog.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog.getByRole('alert')).toContainText('4096 bytes or less');

    // focus is trapped inside the dialog
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(settingsBtn).toBeFocused();

    // unchanged form just closes
    await settingsBtn.click();
    await page.getByRole('dialog', { name: 'Endpoint settings' }).getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('delete endpoint', () => {
  test('cancel keeps it, confirm shows the gone screen and the ingress stops answering', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { path: '/before-delete' });
    await expect(requestRow(page, 'POST', '/before-delete')).toBeVisible();

    await page.getByRole('button', { name: 'Delete endpoint' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this endpoint?' });
    await expect(dialog).toContainText(endpoint.slug);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await sendHook(endpoint.slug, { path: '/still-here' })).status).toBe(200);

    await page.getByRole('button', { name: 'Delete endpoint' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete endpoint' }).click();
    await expect(page.getByRole('heading', { name: 'This endpoint was deleted' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create a new endpoint' })).toHaveAttribute('href', 'http://localhost:5173');

    const after = await sendHook(endpoint.slug, { path: '/after-delete' });
    expect([404, 410]).toContain(after.status);

    // a fresh visit to the dashboard of the deleted endpoint says it is gone too
    await page.goto('about:blank');
    await page.goto(endpoint.link);
    await expect(page.getByRole('heading', { name: 'That token was not accepted' })).toBeVisible();
  });

  test('deleting from another client closes an open dashboard live', async ({ page, endpoint, api }) => {
    await openDashboard(page, endpoint);
    const r = await apiCall(api, 'DELETE', `/subdomains/${endpoint.slug}`, { token: endpoint.token });
    expect(r.status).toBe(204);
    await expect(page.getByRole('heading', { name: /This endpoint (expired|was deleted)/ })).toBeVisible();
  });
});
