import { test, expect, openDashboard, requestRow } from '../fixtures';
import { createHmac } from 'node:crypto';
import { A11yRun } from '../lib/a11y';
import { apiCall, createEndpoint, sendHook, signIn, uniqueEmail } from '../lib/api';
import { readMagicLink } from '../lib/mail';

const SECRET = 'a11y-secret';
const sign = (b: string) => createHmac('sha256', SECRET).update(b).digest('hex');

const viewports = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 375, height: 812 },
} as const;

for (const [vpName, viewport] of Object.entries(viewports)) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`a11y audit: ${vpName} ${theme}`, () => {
      test.use({ viewport, reducedMotion: 'reduce', colorScheme: theme });

      test('public site and signed-in pages', async ({ page, context, api }, testInfo) => {
        test.setTimeout(150_000);
        const run = new A11yRun(`site ${vpName} ${theme}`);
        await context.addInitScript((t) => localStorage.setItem('nanana:theme', t), theme);

        await page.goto('/');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await run.scan(page, 'landing');
        await page.getByText('Is it free?').click();
        await run.scan(page, 'landing (faq open)');
        await page.getByRole('button', { name: 'Create an endpoint' }).click();
        await expect(page.getByText('Your endpoint URL')).toBeVisible();
        await run.scan(page, 'landing (endpoint created)');
        if (vpName === 'mobile') {
          await page.getByRole('button', { name: 'Toggle menu' }).click();
          await run.scan(page, 'landing (mobile menu open)');
        }

        for (const [p, name] of [['/docs', 'docs'], ['/login', 'login'], ['/device?code=ABCD-EFGH', 'device (signed out)'], ['/terms', 'terms'], ['/privacy', 'privacy'], ['/abuse', 'abuse'], ['/no/such/page', '404'], ['/auth/verify', 'auth verify (error)'], ['/account', 'account (signed out)'], ['/admin', 'admin (signed out)']] as const) {
          await page.goto(p);
          await expect(page.getByRole('main')).toBeVisible();
          await expect(page.getByRole('status')).toHaveCount(0).catch(() => undefined);
          await run.scan(page, name);
        }

        // login: filled + after sending
        await page.goto('/login');
        const email = uniqueEmail('a11y');
        await page.getByLabel('Email').fill(email);
        await page.getByRole('button', { name: 'Email me a link' }).click();
        await expect(page.getByText('If that address is valid')).toBeVisible();
        await run.scan(page, 'login (link sent)');

        // signed in
        await page.goto(await readMagicLink(email));
        await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
        await run.scan(page, 'account (empty)');
        const a = await createEndpoint(context.request, { name: 'a11y-named' });
        await createEndpoint(context.request);
        const anon = await createEndpoint(api);
        const dev = await apiCall<{ deviceCode: string; userCode: string }>(api, 'POST', '/auth/device', { data: { clientName: 'a11y-cli' } });
        await apiCall(context.request, 'POST', '/auth/device/approve', { data: { userCode: dev.body.userCode } });
        await apiCall(api, 'POST', '/auth/device/token', { data: { deviceCode: dev.body.deviceCode } });
        await apiCall(context.request, 'POST', `/subdomains/${a.slug}/renew`);
        await page.goto('/account');
        await expect(page.getByRole('region', { name: 'Endpoints' }).getByRole('listitem')).toHaveCount(2);
        await run.scan(page, 'account (endpoints, cli logins)');
        const renew = page.getByRole('region', { name: 'Endpoints' }).getByRole('button', { name: 'Renew +7 days' }).first();
        await renew.click();
        await renew.click();
        await expect(page.getByText('already renewed once')).toBeVisible();
        await run.scan(page, 'account (renew warning)');
        await page.getByLabel('Name or dashboard link').fill(anon.slug);
        await page.getByLabel('Token').fill('nnt_bad');
        await page.getByRole('button', { name: 'Claim', exact: true }).click();
        await expect(page.getByRole('alert')).toBeVisible();
        await run.scan(page, 'account (claim error)');
        await page.getByRole('region', { name: 'Endpoints' }).getByRole('button', { name: 'Rotate token' }).first().click();
        await expect(page.getByRole('dialog', { name: 'Your token (shown once)' })).toBeVisible();
        await run.scan(page, 'account (rotate token dialog)');
        await page.keyboard.press('Escape');
        await page.getByRole('region', { name: 'Endpoints' }).getByRole('button', { name: 'Delete' }).first().click();
        await run.scan(page, 'account (delete endpoint dialog)');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Delete my account' }).click();
        await run.scan(page, 'account (delete account dialog)');
        await page.keyboard.press('Escape');
        await page.goto('/device');
        await expect(page.getByLabel('Code from the CLI')).toBeVisible();
        await run.scan(page, 'device (signed in)');
        await page.getByLabel('Code from the CLI').fill('ZZZZ-ZZZZ');
        await page.getByRole('button', { name: 'Approve this device' }).click();
        await expect(page.getByRole('alert')).toBeVisible();
        await run.scan(page, 'device (error)');
        await page.goto('/admin');
        await expect(page.getByText('Forbidden')).toBeVisible();
        await run.scan(page, 'admin (forbidden)');
        await page.goto('/account');
        await page.getByRole('button', { name: /@example\.test$/ }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await run.scan(page, 'account menu open');

        await run.save(testInfo);
        expect(run.blocking.length, `serious/critical a11y violations:\n${run.describe(run.blocking).join('\n')}`).toBe(0);
      });

      test('dashboard states', async ({ page, api, stub, tunnels }, testInfo) => {
        test.setTimeout(150_000);
        const run = new A11yRun(`dashboard ${vpName} ${theme}`);
        const e = await createEndpoint(api, { data: { hmacHeader: 'x-signature', hmacSecret: SECRET } });
        await page.context().addInitScript((t) => localStorage.setItem('nanana:theme', t), theme);
        const mobile = vpName === 'mobile';

        await openDashboard(page, e);
        await run.scan(page, 'dashboard (empty)');

        // requests of every kind
        const json = '{"event":"paid","amount":1200,"items":[{"sku":"a","qty":2}],"ok":true,"note":null}';
        await sendHook(e.slug, { path: '/pay?x=1', headers: { 'content-type': 'application/json', 'x-signature': sign(json) }, body: json });
        await sendHook(e.slug, { method: 'GET', path: '/health' });
        await sendHook(e.slug, { method: 'PUT', path: '/put', headers: { 'content-type': 'text/plain', 'x-signature': 'sha256=deadbeef' }, body: 'plain text body' });
        await sendHook(e.slug, { method: 'PATCH', path: '/patch', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=two' });
        await sendHook(e.slug, { method: 'DELETE', path: '/delete' });
        await sendHook(e.slug, { path: '/bin', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([0xff, 0x00, 0x41, 0x42]) });
        await sendHook(e.slug, { method: 'OPTIONS', path: '/cors', headers: { origin: 'https://x.test', 'access-control-request-method': 'POST' } });
        await apiCall(api, 'POST', `/subdomains/${e.slug}/mock`, { token: e.token, data: { status: 500, times: 40 } });
        await sendHook(e.slug, { path: '/mocked' });
        await expect(requestRow(page, 'POST', '/mocked')).toContainText('500');
        for (const [m, p] of [['POST', '/pay?x=1'], ['GET', '/health'], ['PUT', '/put'], ['PATCH', '/patch'], ['DELETE', '/delete'], ['POST', '/bin']] as const) await expect(requestRow(page, m, p)).toBeVisible();

        await run.scan(page, mobile ? 'dashboard (request list)' : 'dashboard (list + auto-selected detail)');
        await page.getByRole('checkbox', { name: /Preflights/ }).check();
        await expect(requestRow(page, 'OPTIONS', '/cors')).toBeVisible();
        await run.scan(page, 'dashboard (preflights shown)');
        await page.getByRole('checkbox', { name: /Preflights/ }).uncheck();
        await page.getByLabel('Filter requests by method or path').fill('nothing-matches-this');
        await run.scan(page, 'dashboard (empty filter result)');
        await page.getByLabel('Filter requests by method or path').fill('');

        const tabs = async (name: string) => {
          for (const t of ['Request', 'Response', 'Signature', 'Replays']) {
            await page.getByRole('tab', { name: new RegExp(`^${t}`) }).click();
            await run.scan(page, `${name} / ${t} tab`);
          }
          await page.getByRole('tab', { name: /^Request/ }).click();
        };

        await requestRow(page, 'POST', '/pay?x=1').click();
        await expect(page.getByTestId('body-view')).toHaveAttribute('data-kind', 'json');
        await tabs('detail json (signature valid)');
        await page.getByRole('button', { name: 'Raw', exact: true }).click();
        await run.scan(page, 'detail json raw');
        if (mobile) await page.getByRole('button', { name: 'Requests', exact: true }).click();

        for (const [m, p, kind, name] of [['PUT', '/put', 'text', 'text (signature invalid)'], ['PATCH', '/patch', 'form', 'form'], ['POST', '/bin', 'binary', 'binary'], ['DELETE', '/delete', '', 'no body (header missing)']] as const) {
          await requestRow(page, m, p).click();
          if (kind) await expect(page.getByTestId('body-view')).toHaveAttribute('data-kind', kind);
          await run.scan(page, `detail ${name}`);
          if (kind === 'binary') {
            await page.getByRole('button', { name: 'Base64', exact: true }).click();
            await run.scan(page, 'detail binary base64');
          }
          if (m === 'PUT') {
            await page.getByRole('tab', { name: /^Signature/ }).click();
            await run.scan(page, 'detail text / signature invalid tab');
          }
          if (mobile) await page.getByRole('button', { name: 'Requests', exact: true }).click();
        }

        await requestRow(page, 'POST', '/mocked').click();
        await page.getByRole('tab', { name: 'Response' }).click();
        await run.scan(page, 'detail mocked response');

        // replays: success, failure, error text
        await page.getByRole('tab', { name: 'Request' }).click();
        await page.getByLabel('Replay target URL').fill('not a url');
        await page.getByLabel('Replay target URL').blur();
        await run.scan(page, 'replay bar (invalid url)');
        await page.getByRole('button', { name: 'Headers', exact: true }).click();
        await page.getByRole('button', { name: 'Add header' }).click();
        await run.scan(page, 'replay bar (header overrides)');
        await page.getByLabel('Replay target URL').fill(`${stub.url}/ok`);
        await page.getByRole('button', { name: 'Replay', exact: true }).click();
        await expect(page.getByText('Replay result:')).toContainText('201');
        await run.scan(page, 'replays tab (one replay)');
        await page.getByRole('tabpanel').getByRole('button', { name: /201/ }).click();
        await run.scan(page, 'replays tab (expanded)');
        await page.getByLabel('Replay target URL').fill('http://127.0.0.1:9/x');
        await page.getByRole('button', { name: 'Replay', exact: true }).click();
        await expect(page.getByText('Replay failed to reach the target').or(page.getByText(/Replay result/))).toBeVisible();
        await run.scan(page, 'replay (failed to reach target)');

        // header popovers and dialogs
        const header = page.getByRole('banner');
        await header.getByRole('button', { name: 'Tunnel not connected' }).click();
        await run.scan(page, 'tunnel popover (offline)');
        await header.getByRole('button', { name: 'Tunnel not connected' }).click();
        await tunnels.open(e);
        await expect(header.getByRole('button', { name: /Tunnel connected/ })).toBeVisible();
        await sendHook(e.slug, { path: '/via-tunnel', body: { a: 1 } });
        await run.scan(page, 'dashboard (tunnel connected)');
        await header.getByRole('button', { name: /Tunnel connected/ }).click();
        await run.scan(page, 'tunnel popover (online)');
        await header.getByRole('button', { name: /Tunnel connected/ }).click();

        await header.getByRole('button', { name: 'Settings' }).click();
        await expect(page.getByRole('dialog', { name: 'Endpoint settings' })).toBeVisible();
        await run.scan(page, 'settings dialog');
        await page.getByLabel('Status').fill('9');
        await page.getByRole('button', { name: 'Save settings' }).click();
        await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
        await run.scan(page, 'settings dialog (validation error)');
        await page.keyboard.press('Escape');

        await header.getByRole('button', { name: /^Mock/ }).click();
        await expect(page.getByRole('dialog', { name: 'Mock the next responses' })).toBeVisible();
        await run.scan(page, 'mock dialog (active rule)');
        await page.getByLabel('Status').fill('1');
        await page.getByRole('button', { name: /(Replace|Start) mock/ }).click();
        await run.scan(page, 'mock dialog (validation error)');
        await page.getByRole('button', { name: 'Clear mock' }).click();
        await run.scan(page, 'mock dialog (no rule)');
        await page.keyboard.press('Escape');

        await header.getByRole('button', { name: 'Delete endpoint' }).click();
        await run.scan(page, 'delete endpoint dialog');
        await page.keyboard.press('Escape');

        // access screens (the token lives in sessionStorage per origin: drop it first)
        await page.evaluate(() => sessionStorage.clear());
        await page.goto('about:blank');
        await page.goto(`http://${e.slug}.tools.localhost:5173/`);
        await expect(page.getByRole('heading', { name: 'You need the dashboard link' })).toBeVisible();
        await run.scan(page, 'dashboard (no token screen)');
        await page.goto('about:blank');
        await page.goto(`http://${e.slug}.tools.localhost:5173/#t=nnt_wrongwrongwrongwrong`);
        await expect(page.getByRole('heading', { name: 'That token was not accepted' })).toBeVisible();
        await run.scan(page, 'dashboard (bad token screen)');

        await run.save(testInfo);
        expect(run.blocking.length, `serious/critical a11y violations:\n${run.describe(run.blocking).join('\n')}`).toBe(0);
      });
    });
  }
}

test.describe('keyboard access', () => {
  test('landing flow is operable with the keyboard only', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    const btn = page.getByRole('button', { name: 'Create an endpoint' });
    await btn.focus();
    // visible focus indicator
    expect(await btn.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Your endpoint URL')).toBeVisible();
    // Copy buttons are reachable by Tab and trigger with Space
    const copy = page.locator('code', { hasText: /^http:\/\// }).locator('xpath=following-sibling::button');
    await copy.focus();
    await page.keyboard.press('Space');
    await expect(copy).toContainText('Copied');
    // FAQ summaries toggle with the keyboard
    const summary = page.getByText('Is it free?');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Anonymous endpoints and free accounts cost nothing')).toBeVisible();
  });

  test('dashboard: rows, tabs and dialogs work with the keyboard; live region announces new requests', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { path: '/kb-1' });
    await expect(page.getByText('Latest request: POST /kb-1')).toBeAttached();
    await sendHook(endpoint.slug, { path: '/kb-2' });
    await expect(page.getByText('Latest request: POST /kb-2')).toBeAttached();
    const live = page.locator('[aria-live="polite"].sr-only');
    await expect(live).toHaveText('Latest request: POST /kb-2');

    await requestRow(page, 'POST', '/kb-1').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: '/kb-1' })).toBeVisible();
    await expect(requestRow(page, 'POST', '/kb-1')).toHaveAttribute('aria-current', 'true');
    await page.getByRole('tab', { name: 'Request' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Response' })).toHaveAttribute('aria-selected', 'true');
    // the tabpanel is wired to its tab
    await expect(page.getByRole('tabpanel', { name: 'Response' })).toBeVisible();

    // dialog opens from keyboard, traps focus, Escape returns focus to the opener
    const mock = page.getByRole('banner').getByRole('button', { name: /^Mock/ });
    await mock.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Mock the next responses' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(mock).toBeFocused();
  });
});
