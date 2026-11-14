import { createHmac } from 'node:crypto';
import { test, expect, openDashboard, requestRow } from '../fixtures';
import { sendHook } from '../lib/api';

const SECRET = 'whsec_e2e_secret';
const sign = (body: string, algo = 'sha256') => createHmac(algo, SECRET).update(body).digest('hex');

test.describe('HMAC signature check', () => {
  test('pass / fail / missing indicators', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);

    // unsigned requests before configuration: no check
    await sendHook(endpoint.slug, { path: '/before', body: 'x' });
    await expect(requestRow(page, 'POST', '/before')).toContainText('No HMAC check configured');

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Endpoint settings' });
    await dialog.getByLabel('Header name').fill('X-Signature');
    await dialog.getByLabel('Algorithm').selectOption('sha256');
    await dialog.getByLabel('Secret (write-only)').fill(SECRET);
    await dialog.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog).toHaveCount(0);

    const body = '{"event":"paid","id":1}';
    await sendHook(endpoint.slug, { path: '/ok', headers: { 'content-type': 'application/json', 'x-signature': sign(body) }, body });
    await sendHook(endpoint.slug, { path: '/ok-prefixed', headers: { 'content-type': 'application/json', 'x-signature': `sha256=${sign(body)}` }, body });
    await sendHook(endpoint.slug, { path: '/bad', headers: { 'content-type': 'application/json', 'x-signature': sign('tampered') }, body });
    await sendHook(endpoint.slug, { path: '/none', headers: { 'content-type': 'application/json' }, body });

    await expect(requestRow(page, 'POST', '/ok')).toContainText('Signature valid');
    await expect(requestRow(page, 'POST', '/ok-prefixed')).toContainText('Signature valid');
    await expect(requestRow(page, 'POST', '/bad')).toContainText('Signature invalid');
    await expect(requestRow(page, 'POST', '/none')).toContainText('Signature header missing');
    // existing captures are re-evaluated with the new config
    await expect(requestRow(page, 'POST', '/before')).toContainText('Signature header missing');

    // Signature tab: details for the failing one
    await requestRow(page, 'POST', '/bad').click();
    await page.getByRole('tab', { name: /^Signature/ }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel.locator('strong', { hasText: 'Signature invalid' })).toBeVisible();
    await expect(panel.getByText(/^x-signature$/i).first()).toBeVisible();
    await expect(panel.getByText(sign('tampered'))).toBeVisible(); // received
    await expect(panel.getByText(sign(body), { exact: true })).toBeVisible(); // expected

    await requestRow(page, 'POST', '/ok').click();
    await page.getByRole('tab', { name: /^Signature/ }).click();
    await expect(panel.locator('strong', { hasText: 'Signature valid' })).toBeVisible();

    await requestRow(page, 'POST', '/none').click();
    await page.getByRole('tab', { name: /^Signature/ }).click();
    await expect(panel.getByText('The request did not include the configured signature header')).toBeVisible();
  });

  test('settings: header persists, secret is write-only, can be removed, algorithm change', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await page.getByRole('button', { name: 'Settings' }).click();
    let dialog = page.getByRole('dialog', { name: 'Endpoint settings' });
    // secret without header is rejected locally
    await dialog.getByLabel('Secret (write-only)').fill(SECRET);
    await dialog.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Choose the header that carries the signature');
    await dialog.getByLabel('Header name').fill('X-Hub-Signature');
    await dialog.getByLabel('Algorithm').selectOption('sha1');
    await dialog.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog).toHaveCount(0);

    const body = 'raw-body';
    await sendHook(endpoint.slug, { path: '/sha1', headers: { 'content-type': 'text/plain', 'x-hub-signature': `sha1=${sign(body, 'sha1')}` }, body });
    await expect(requestRow(page, 'POST', '/sha1')).toContainText('Signature valid');

    await page.getByRole('button', { name: 'Settings' }).click();
    dialog = page.getByRole('dialog', { name: 'Endpoint settings' });
    await expect(dialog.getByLabel('Header name')).toHaveValue('X-Hub-Signature'.toLowerCase());
    await expect(dialog.getByLabel('Algorithm')).toHaveValue('sha1');
    const secret = dialog.getByLabel('Secret (write-only)');
    await expect(secret).toHaveValue('');
    await expect(secret).toHaveAttribute('placeholder', /A secret is saved/);
    await dialog.getByRole('checkbox', { name: /Remove the saved secret/ }).check();
    await expect(secret).toBeDisabled();
    await dialog.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog).toHaveCount(0);

    await sendHook(endpoint.slug, { path: '/after-remove', body });
    await expect(requestRow(page, 'POST', '/after-remove')).toContainText('No HMAC check configured');
  });
});
