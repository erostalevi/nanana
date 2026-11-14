import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { apiCall, createEndpoint, sendHook, signIn, uniqueEmail } from '../lib/api';
import { dbQuery } from '../lib/db';
import { readMagicLink } from '../lib/mail';

const endpointsList = (page: Page) => page.getByRole('region', { name: 'Endpoints' });

test.describe('auth: magic link', () => {
  test('request a link in the UI, open it from the API log, land signed in', async ({ page }) => {
    const email = uniqueEmail('ui');
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(page.getByText('If that address is valid, a sign-in link is on its way.')).toBeVisible();

    const link = await readMagicLink(email);
    expect(link).toMatch(/^http:\/\/localhost:5173\/auth\/verify\?token=nnm_/);
    await page.goto(link);
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByText(email).first()).toBeVisible();
    expect(page.url()).not.toContain('nnm_');

    // header shows the account menu; sign out returns to the landing page
    await page.getByRole('button', { name: email }).click();
    await expect(page.getByRole('menuitem', { name: 'Your endpoints' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await page.goto('/account');
    await expect(page.getByText('Sign in to see your endpoints')).toBeVisible();
  });

  test('links work once and garbage links show an error', async ({ page, context }) => {
    const email = uniqueEmail('once');
    await apiCall(context.request, 'POST', '/auth/magic', { data: { email } });
    const link = await readMagicLink(email);
    await page.goto(link);
    await expect(page).toHaveURL(/\/account$/);
    // second use (in a fresh, signed-out context state) fails
    await context.clearCookies();
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'That link did not work' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('invalid, expired or was already used');
    await expect(page.getByRole('link', { name: 'Request a new one' })).toHaveAttribute('href', '/login');
    await page.goto('/auth/verify');
    await expect(page.getByText('This sign-in link is missing its token.')).toBeVisible();
  });

  test('invalid email is rejected by the form', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    // native validation keeps the form on screen
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('If that address is valid')).toHaveCount(0);
  });

  test('already signed in users are redirected away from /login (honouring ?next=)', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/account$/);
    await page.goto('/login?next=/docs');
    await expect(page).toHaveURL(/\/docs$/);
    // open redirects are ignored
    await page.goto('/login?next=//evil.example.com');
    await expect(page).toHaveURL(/\/account$/);
  });
});

test.describe('account page', () => {
  test('lists endpoints and shows plan limits', async ({ page, context }) => {
    const { email } = await signIn(context);
    await page.goto('/account');
    await expect(page.getByText('No endpoints yet.')).toBeVisible();
    const a = await createEndpoint(context.request);
    const b = await createEndpoint(context.request);
    await page.reload();
    await expect(endpointsList(page).getByRole('link', { name: a.url })).toBeVisible();
    await expect(endpointsList(page).getByRole('link', { name: b.url })).toBeVisible();
    await expect(page.getByText(`${email} · plan`)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Plan and limits' })).toBeVisible();
    await expect(page.getByText('max active subdomains')).toBeVisible();
    // dashboard link in the list has no token (owner session)
    await expect(endpointsList(page).getByRole('link', { name: 'Dashboard' }).first()).toHaveAttribute('href', /^http:\/\/[a-z0-9]+\.tools\.localhost:5173\/$/);
  });

  test('create a custom-name endpoint; rename rules reject reserved, invalid and a second custom name', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/account');
    const name = page.getByLabel('New endpoint (optional custom name)');

    // reserved
    await name.fill('admin');
    await page.getByRole('button', { name: 'Create endpoint' }).click();
    await expect(page.getByRole('alert')).toContainText('That name is reserved');
    // invalid shape accepted by the browser pattern, rejected by the API
    await name.fill('-bad-name-');
    await page.getByRole('button', { name: 'Create endpoint' }).click();
    await expect(page.getByRole('alert')).toContainText('Use 3-32 chars');
    // too short: blocked by the input pattern before any request
    await name.fill('ab');
    await page.getByRole('button', { name: 'Create endpoint' }).click();
    expect(await name.evaluate((el: HTMLInputElement) => el.validity.patternMismatch)).toBe(true);

    // valid (upper case is normalised)
    await name.fill('My-App-E2E');
    await page.getByRole('button', { name: 'Create endpoint' }).click();
    const modal = page.getByRole('dialog', { name: 'Your token (shown once)' });
    await expect(modal).toBeVisible();
    await expect(modal.locator('code', { hasText: 'my-app-e2e' }).first()).toBeVisible();
    await expect(modal.locator('pre', { hasText: /^nnt_/ })).toBeVisible();
    await expect(modal.getByRole('link', { name: 'Open dashboard' })).toHaveAttribute('href', /^http:\/\/my-app-e2e\.tools\.localhost:5173\/#t=nnt_/);
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await expect(endpointsList(page).getByRole('link', { name: 'http://my-app-e2e.localhost:3201' })).toBeVisible();
    await expect(endpointsList(page).getByText('custom', { exact: true })).toBeVisible();
    expect((await sendHook('my-app-e2e', { path: '/named' })).status).toBe(200);

    // the free plan allows one custom name
    await name.fill('second-name');
    await page.getByRole('button', { name: 'Create endpoint' }).click();
    await expect(page.getByRole('alert')).toContainText('custom name');
    // a random-named one is fine
    await name.fill('');
    await page.getByRole('button', { name: 'Create endpoint' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    await expect(endpointsList(page).getByRole('listitem')).toHaveCount(2);

    // taken name: another account cannot reuse it
    const other = await context.browser()!.newContext();
    await signIn(other);
    const dup = await apiCall(other.request, 'POST', '/subdomains', { data: { name: 'my-app-e2e' } });
    expect(dup.status).toBe(409);
    await other.close();
  });

  test('renew adds 7 days once', async ({ page, context }) => {
    await signIn(context);
    const ep = await createEndpoint(context.request);
    const before = await apiCall<{ hardExpiresAt: string }>(context.request, 'GET', `/subdomains/${ep.slug}`);
    await page.goto('/account');
    const row = endpointsList(page).getByRole('listitem').filter({ hasText: ep.slug });
    await row.getByRole('button', { name: 'Renew +7 days' }).click();
    await expect.poll(async () => (await apiCall<{ hardExpiresAt: string }>(context.request, 'GET', `/subdomains/${ep.slug}`)).body.hardExpiresAt).not.toBe(before.body.hardExpiresAt);
    const after = await apiCall<{ hardExpiresAt: string }>(context.request, 'GET', `/subdomains/${ep.slug}`);
    expect(new Date(after.body.hardExpiresAt).getTime() - new Date(before.body.hardExpiresAt).getTime()).toBe(7 * 24 * 3600 * 1000);
    await row.getByRole('button', { name: 'Renew +7 days' }).click();
    await expect(row.getByText('This endpoint was already renewed once.')).toBeVisible();
  });

  test('rotate token: shown once, old token stops working, new one works', async ({ page, context }) => {
    await signIn(context);
    const ep = await createEndpoint(context.request);
    await page.goto('/account');
    await endpointsList(page).getByRole('listitem').filter({ hasText: ep.slug }).getByRole('button', { name: 'Rotate token' }).click();
    const modal = page.getByRole('dialog', { name: 'Your token (shown once)' });
    const newToken = (await modal.locator('pre').first().textContent())!.trim();
    expect(newToken).toMatch(/^nnt_/);
    expect(newToken).not.toBe(ep.token);
    await expect(modal.getByText('Older tokens for this endpoint stop working.')).toBeVisible();
    await expect(modal.getByRole('link', { name: 'Open dashboard' })).toHaveAttribute('href', `http://${ep.slug}.tools.localhost:5173/#t=${newToken}`);

    const anon = await (await context.browser()!.newContext()).request;
    expect((await apiCall(anon, 'GET', `/subdomains/${ep.slug}`, { token: ep.token })).status).toBeGreaterThanOrEqual(401);
    expect((await apiCall(anon, 'GET', `/subdomains/${ep.slug}`, { token: newToken })).status).toBe(200);

    // close the modal: token is not retrievable anymore
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await expect(page.getByText(newToken)).toHaveCount(0);
  });

  test('delete one endpoint from the list', async ({ page, context }) => {
    await signIn(context);
    const ep = await createEndpoint(context.request);
    await page.goto('/account');
    await endpointsList(page).getByRole('listitem').filter({ hasText: ep.slug }).getByRole('button', { name: 'Delete' }).click();
    const d = page.getByRole('dialog', { name: `Delete ${ep.slug}?` });
    await d.getByRole('button', { name: 'Cancel' }).click();
    await expect(d).toHaveCount(0);
    await endpointsList(page).getByRole('listitem').filter({ hasText: ep.slug }).getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete endpoint' }).click();
    await expect(page.getByText('No endpoints yet.')).toBeVisible();
    expect([404, 410]).toContain((await sendHook(ep.slug)).status);
  });

  test('claim an anonymous endpoint with its token (and by pasting the dashboard link)', async ({ page, context, api }) => {
    await signIn(context);
    const anon1 = await createEndpoint(api);
    const anon2 = await createEndpoint(api);
    await page.goto('/account');
    await expect(page.getByText('No endpoints yet.')).toBeVisible();

    // wrong token
    await page.getByLabel('Name or dashboard link').fill(anon1.slug);
    await page.getByLabel('Token').fill('nnt_wrongwrongwrongwrong');
    await page.getByRole('button', { name: 'Claim', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(endpointsList(page).getByRole('link', { name: anon1.url })).toHaveCount(0);

    // name + token
    await page.getByLabel('Token').fill(anon1.token);
    await page.getByRole('button', { name: 'Claim', exact: true }).click();
    await expect(page.getByText('Claimed. It now appears in your list.')).toBeVisible();
    await expect(endpointsList(page).getByRole('link', { name: anon1.url })).toBeVisible();

    // paste the whole dashboard link: both fields are filled in
    await page.getByLabel('Name or dashboard link').fill(anon2.link);
    await expect(page.getByLabel('Name or dashboard link')).toHaveValue(anon2.slug);
    await expect(page.getByLabel('Token')).toHaveValue(anon2.token);
    await page.getByRole('button', { name: 'Claim', exact: true }).click();
    await expect(endpointsList(page).getByRole('link', { name: anon2.url })).toBeVisible();

    // now owned: visible through the API for the session
    const mine = await apiCall<{ subdomains: { slug: string; ownerId: string }[] }>(context.request, 'GET', '/subdomains');
    expect(mine.body.subdomains.map((s) => s.slug).sort()).toEqual([anon1.slug, anon2.slug].sort());
  });

  test('revoke a CLI token created through the device flow', async ({ page, context, api }) => {
    await signIn(context);
    const dev = await apiCall<{ deviceCode: string; userCode: string }>(api, 'POST', '/auth/device', { data: { clientName: 'e2e-cli' } });
    expect(dev.status).toBe(200);
    const ok = await apiCall(context.request, 'POST', '/auth/device/approve', { data: { userCode: dev.body.userCode } });
    expect(ok.status).toBe(204);
    const tok = await apiCall<{ accessToken: string }>(api, 'POST', '/auth/device/token', { data: { deviceCode: dev.body.deviceCode } });
    expect(tok.status).toBe(200);
    const nna = tok.body.accessToken;
    expect(nna).toMatch(/^nna_/);
    expect((await apiCall(api, 'GET', '/me', { token: nna })).status).toBe(200);

    await page.goto('/account');
    const cli = page.getByRole('region', { name: 'CLI logins' });
    await expect(cli.getByText('e2e-cli')).toBeVisible();
    await expect(cli.getByText(/created .*never used|last used/)).toBeVisible();
    await cli.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('No CLI logins.')).toBeVisible();
    expect((await apiCall(api, 'GET', '/me', { token: nna })).status).toBe(401);
  });

  test('delete account needs the typed email and removes everything', async ({ page, context }) => {
    const { email } = await signIn(context);
    const ep = await createEndpoint(context.request);
    await page.goto('/account');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
    const confirm = dialog.getByRole('button', { name: 'Delete account forever' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/to confirm/).fill('wrong@example.test');
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/to confirm/).fill(email);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page).toHaveURL('http://localhost:5173/');
    await expect.poll(async () => (await dbQuery('SELECT 1 FROM account WHERE email = $1', [email])).length).toBe(0);
    expect([404, 410]).toContain((await sendHook(ep.slug)).status);
    await page.goto('/account');
    await expect(page.getByText('Sign in to see your endpoints')).toBeVisible();
  });
});

test.describe('device flow page', () => {
  test('signed out: asks to sign in and comes back to the code after signing in', async ({ page, api }) => {
    const dev = await apiCall<{ deviceCode: string; userCode: string }>(api, 'POST', '/auth/device', { data: { clientName: 'nanana-cli' } });
    await page.goto(`/device?code=${dev.body.userCode.toLowerCase()}`);
    await expect(page.getByRole('heading', { name: 'Connect the CLI' })).toBeVisible();
    await expect(page.getByText('Sign in first, then approve code')).toContainText(dev.body.userCode);
    await page.getByRole('link', { name: 'Sign in to continue' }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fdevice/);

    const email = uniqueEmail('device');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(page.getByText('If that address is valid')).toBeVisible();
    await page.goto(await readMagicLink(email));
    // back on the device page, code preserved
    await expect(page).toHaveURL(/\/device\?code=/);
    await expect(page.getByLabel('Code from the CLI')).toHaveValue(dev.body.userCode);
    await expect(page.getByText(`Signed in as`)).toContainText(email);
  });

  test('signed in: approve a code created via POST /auth/device', async ({ page, context, api }) => {
    await signIn(context);
    const dev = await apiCall<{ deviceCode: string; userCode: string }>(api, 'POST', '/auth/device', { data: { clientName: 'nanana-cli' } });
    // before approval the CLI is told to wait
    const pending = await apiCall<{ error: { code: string } }>(api, 'POST', '/auth/device/token', { data: { deviceCode: dev.body.deviceCode } });
    expect(pending.status).toBe(400);
    expect(pending.body.error.code).toBe('authorization_pending');

    await page.goto('/device');
    const approve = page.getByRole('button', { name: 'Approve this device' });
    await expect(approve).toBeDisabled();
    await page.getByLabel('Code from the CLI').fill(dev.body.userCode.replace('-', '').toLowerCase());
    await expect(page.getByLabel('Code from the CLI')).toHaveValue(dev.body.userCode); // normalised ABCD-EFGH
    await approve.click();
    await expect(page.getByText('Approved', { exact: true })).toBeVisible();

    const tok = await apiCall<{ accessToken: string }>(api, 'POST', '/auth/device/token', { data: { deviceCode: dev.body.deviceCode } });
    expect(tok.status).toBe(200);
    expect(tok.body.accessToken).toMatch(/^nna_/);
  });

  test('unknown code shows a helpful error', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/device?code=ZZZZ-ZZZZ');
    await page.getByRole('button', { name: 'Approve this device' }).click();
    await expect(page.getByRole('alert')).toContainText('not found or has expired');
  });
});
