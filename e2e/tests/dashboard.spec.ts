import { test, expect, openDashboard, requestRow } from '../fixtures';
import { sendHook } from '../lib/api';

const clipboard = (page: import('@playwright/test').Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe('dashboard: opening it', () => {
  test('the #t= token is stripped from the URL and kept for the session', async ({ page, endpoint }) => {
    await page.goto(endpoint.link);
    await expect(page.getByRole('status', { name: 'Live stream open' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    expect(page.url()).not.toContain(endpoint.token);
    expect(page.url()).toBe(`http://${endpoint.slug}.tools.localhost:5173/`);
    // The token moved to sessionStorage (never localStorage) and survives a reload of the clean URL.
    expect(await page.evaluate((s) => sessionStorage.getItem(`nanana:token:${s}`), endpoint.slug)).toBe(endpoint.token);
    expect(await page.evaluate((s) => localStorage.getItem(`nanana:token:${s}`), endpoint.slug)).toBeNull();
    await page.reload();
    await expect(page.getByRole('status', { name: 'Live stream open' })).toBeVisible();
    await expect(page.getByRole('link', { name: endpoint.url })).toBeVisible();
  });

  test('empty state shows the exact curl and CLI commands for this endpoint', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await expect(page.getByRole('heading', { name: 'Waiting for the first webhook' })).toBeVisible();
    await expect(page.locator('pre', { hasText: `curl -X POST ${endpoint.url}/test` })).toBeVisible();
    await expect(page.locator('pre', { hasText: `nanana -t=${endpoint.token} -p=3000` })).toBeVisible();
    await expect(page.getByText('Nothing to inspect yet.')).toBeVisible();
    await expect(page.getByText('Tunnel not connected')).toBeVisible();
    await expect(page.getByText('active', { exact: true }).first()).toBeVisible();
  });

  test('without a token the dashboard asks for access; a wrong token is rejected; unknown slug looks the same', async ({ page, endpoint }) => {
    await page.goto(`http://${endpoint.slug}.tools.localhost:5173/`);
    await expect(page.getByRole('heading', { name: 'You need the dashboard link' })).toBeVisible();
    // pasting the full link into the tab that already shows the dashboard picks the token up (hash-only navigation)
    await page.goto(`http://${endpoint.slug}.tools.localhost:5173/#t=nnt_wrongwrongwrongwrong`);
    await expect(page.getByRole('heading', { name: 'That token was not accepted' })).toBeVisible();
    await page.goto(endpoint.link);
    await expect(page.getByRole('status', { name: 'Live stream open' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await page.goto('about:blank');
    // an unknown slug is indistinguishable from a wrong token (the API answers 401 and never reveals existence)
    await page.goto('http://nosuchendpoint.tools.localhost:5173/#t=nnt_wrongwrongwrongwrong');
    await expect(page.getByRole('heading', { name: 'That token was not accepted' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in as the owner' })).toHaveAttribute('href', 'http://localhost:5173/login');
  });
});

test.describe('dashboard: live requests', () => {
  test('requests appear live, without a reload, and show details', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await page.evaluate(() => ((window as any).__marker = 'same-page'));

    const res = await sendHook(endpoint.slug, { method: 'POST', path: '/pay?x=1&y=two', headers: { 'x-custom': 'hello' }, body: { order: 42, ok: true } });
    expect(res.status).toBe(200);
    const row = requestRow(page, 'POST', '/pay?x=1&y=two');
    await expect(row).toBeVisible();
    await expect(row).toContainText('POST');
    await expect(row).toContainText('200'); // status chip arrives with request.updated
    await expect(row).toContainText('just now');

    // second request, other method
    await sendHook(endpoint.slug, { method: 'GET', path: '/health' });
    await expect(requestRow(page, 'GET', '/health')).toBeVisible();
    // newest first
    const rows = page.getByRole('list', { name: 'Captured requests' }).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('/health');
    await expect(rows.nth(1)).toContainText('/pay?x=1&y=two');
    expect(await page.evaluate(() => (window as any).__marker)).toBe('same-page');

    // first request is auto-selected on desktop and its details render
    await requestRow(page, 'POST', '/pay?x=1&y=two').click();
    await expect(page.getByRole('heading', { level: 2, name: '/pay?x=1&y=two' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Query string' })).toBeVisible();
    const query = page.getByRole('tabpanel');
    await expect(query.getByRole('row', { name: /^x 1$/ })).toBeVisible();
    await expect(query.getByRole('row', { name: /^y two$/ })).toBeVisible();
    await expect(query.getByRole('row', { name: /x-custom hello/ })).toBeVisible();
    await expect(query.getByRole('row', { name: /content-type application\/json/ })).toBeVisible();
  });

  test('Request / Response / Signature / Replays tabs', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { path: '/tabs', body: { hi: 'there' } });
    await requestRow(page, 'POST', '/tabs').click();
    const panel = page.getByRole('tabpanel');

    await expect(page.getByRole('tab', { name: 'Request' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('heading', { name: /^Headers \(\d+\)$/ })).toBeVisible();

    await page.getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByRole('tab', { name: 'Response' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('heading', { name: 'What we sent back' })).toBeVisible();
    await expect(panel.getByText('Answered by')).toBeVisible();
    await expect(panel.locator('dd', { hasText: 'offline' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Response body' })).toBeVisible();
    await expect(panel.getByTestId('body-view')).toContainText('"ok"');

    await page.getByRole('tab', { name: 'Signature' }).click();
    await expect(panel.locator('strong', { hasText: 'No HMAC check configured' })).toBeVisible();
    await expect(panel.getByText('Set an HMAC secret and header name in Settings')).toBeVisible();

    await page.getByRole('tab', { name: 'Replays' }).click();
    await expect(panel.getByText('No replays yet.')).toBeVisible();

    // keyboard navigation between tabs
    await page.getByRole('tab', { name: 'Replays' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Request' })).toHaveAttribute('aria-selected', 'true');
  });

  test('JSON bodies are pretty-printed with a raw toggle', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    const raw = '{"user":{"name":"Ana","tags":["a","b"],"age":30,"admin":false,"x":null}}';
    await sendHook(endpoint.slug, { path: '/json', headers: { 'content-type': 'application/json' }, body: raw });
    await requestRow(page, 'POST', '/json').click();
    const view = page.getByTestId('body-view');
    await expect(view).toHaveAttribute('data-kind', 'json');
    await expect(view).toContainText('"user"');
    await expect(view).toContainText('"Ana"');
    await expect(view).toContainText('30');
    // pretty view collapses: collapse the user node, children disappear
    await view.getByRole('button', { name: /Collapse/ }).first().click(); // root
    await expect(view).not.toContainText('"Ana"');
    await view.getByRole('button', { name: /Expand/ }).first().click();
    await expect(view).toContainText('"Ana"');

    const copyBody = page.getByRole('button', { name: 'Copy body' });
    await copyBody.click();
    expect(await clipboard(page)).toBe(JSON.stringify(JSON.parse(raw), null, 2));

    await page.getByRole('button', { name: 'Raw', exact: true }).click();
    await expect(view).toContainText(raw);
    await copyBody.click();
    expect(await clipboard(page)).toBe(raw);
    await expect(page.getByRole('button', { name: 'Raw', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Pretty', exact: true }).click();
    await expect(view).not.toContainText(raw);
  });

  test('form bodies render as a table and plain text as text', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { path: '/form', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=hello+world' });
    await requestRow(page, 'POST', '/form').click();
    const view = page.getByTestId('body-view');
    await expect(view).toHaveAttribute('data-kind', 'form');
    await expect(view.getByRole('row', { name: 'b hello world' })).toBeVisible();

    await sendHook(endpoint.slug, { path: '/text', headers: { 'content-type': 'text/plain' }, body: 'just some text' });
    await requestRow(page, 'POST', '/text').click();
    await expect(page.getByTestId('body-view')).toHaveAttribute('data-kind', 'text');
    await expect(page.getByTestId('body-view')).toContainText('just some text');
  });

  test('binary bodies can be viewed as hex or base64', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x80, 0x41, 0x42]);
    await sendHook(endpoint.slug, { path: '/bin', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    await requestRow(page, 'POST', '/bin').click();
    const view = page.getByTestId('body-view');
    await expect(view).toHaveAttribute('data-kind', 'binary');
    await expect(page.getByText('Binary body, 8 B.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hex', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(view).toContainText('ff fe 00 01 02 80 41 42');
    await expect(view).toContainText('..');

    await page.getByRole('button', { name: 'Base64', exact: true }).click();
    await expect(view).toContainText(bytes.toString('base64'));
    await expect(view).not.toContainText('ff fe 00');
    await page.getByRole('button', { name: 'Copy body' }).click();
    expect(await clipboard(page)).toBe(bytes.toString('base64'));
    await page.getByRole('button', { name: 'Hex', exact: true }).click();
    await expect(view).toContainText('ff fe 00 01');
  });

  test('search filters by method, path and body', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { method: 'GET', path: '/alpha' });
    await sendHook(endpoint.slug, { method: 'POST', path: '/beta', body: 'plain text' , headers: { 'content-type': 'text/plain' } });
    await sendHook(endpoint.slug, { method: 'PUT', path: '/gamma', body: 'find-the-needle', headers: { 'content-type': 'text/plain' } });
    for (const [m, p] of [['GET', '/alpha'], ['POST', '/beta'], ['PUT', '/gamma']]) await expect(requestRow(page, m!, p!)).toBeVisible();

    const filter = page.getByLabel('Filter requests by method or path');
    await filter.fill('post');
    await expect(requestRow(page, 'POST', '/beta')).toBeVisible();
    await expect(requestRow(page, 'GET', '/alpha')).toHaveCount(0);
    await expect(requestRow(page, 'PUT', '/gamma')).toHaveCount(0);

    await filter.fill('/alp');
    await expect(requestRow(page, 'GET', '/alpha')).toBeVisible();
    await expect(requestRow(page, 'POST', '/beta')).toHaveCount(0);

    await filter.fill('needle');
    await expect(requestRow(page, 'PUT', '/gamma')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Captured requests' }).getByRole('listitem')).toHaveCount(1);

    await filter.fill('does-not-exist');
    await expect(page.getByText('No requests match this filter.')).toBeVisible();

    await filter.fill('');
    await expect(page.getByRole('list', { name: 'Captured requests' }).getByRole('listitem')).toHaveCount(3);

    // new requests that match the active filter appear, others are hidden
    await filter.fill('/delta');
    await sendHook(endpoint.slug, { method: 'GET', path: '/delta' });
    await sendHook(endpoint.slug, { method: 'GET', path: '/other' });
    await expect(requestRow(page, 'GET', '/delta')).toBeVisible();
    await expect(requestRow(page, 'GET', '/other')).toHaveCount(0);
  });

  test('CORS preflights are hidden until the toggle is on', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { method: 'OPTIONS', path: '/cors', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } });
    await sendHook(endpoint.slug, { method: 'POST', path: '/real' });
    await expect(requestRow(page, 'POST', '/real')).toBeVisible();
    await expect(requestRow(page, 'OPTIONS', '/cors')).toHaveCount(0);

    const toggle = page.getByRole('checkbox', { name: /Preflights/ });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText('Preflights (1)')).toBeVisible();
    await toggle.check();
    await expect(requestRow(page, 'OPTIONS', '/cors')).toBeVisible();
    await requestRow(page, 'OPTIONS', '/cors').click();
    await page.getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByText('204').first()).toBeVisible();
    await toggle.uncheck();
    await expect(requestRow(page, 'OPTIONS', '/cors')).toHaveCount(0);
  });

  test('delete a single request', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { path: '/keep' });
    await sendHook(endpoint.slug, { path: '/drop' });
    await expect(requestRow(page, 'POST', '/drop')).toBeVisible();
    await requestRow(page, 'POST', '/drop').click();
    await page.getByRole('button', { name: 'Delete this request' }).click();
    await expect(requestRow(page, 'POST', '/drop')).toHaveCount(0);
    await expect(requestRow(page, 'POST', '/keep')).toBeVisible();
  });

  test('requests that arrived while the page was closed are listed on load', async ({ page, endpoint }) => {
    await sendHook(endpoint.slug, { path: '/early-1' });
    await sendHook(endpoint.slug, { path: '/early-2' });
    await openDashboard(page, endpoint);
    await expect(requestRow(page, 'POST', '/early-1')).toBeVisible();
    await expect(requestRow(page, 'POST', '/early-2')).toBeVisible();
  });
});

test.describe('dashboard: copy as curl', () => {
  test('JSON request', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { path: '/curl?a=1', headers: { 'x-trace': "it's" }, body: { n: 1 } });
    await requestRow(page, 'POST', '/curl?a=1').click();
    await expect(page.getByText(`curl target: ${endpoint.url}/curl?a=1`)).toBeVisible();
    await page.getByRole('button', { name: 'Copy as curl' }).click();
    const curl = await clipboard(page);
    expect(curl).toContain(`curl -X POST '${endpoint.url}/curl?a=1'`);
    expect(curl).toContain(`-H 'content-type: application/json'`);
    expect(curl).toContain(`-H 'x-trace: it'\\''s'`);
    expect(curl).toContain(`--data-binary '{"n":1}'`);
    expect(curl).not.toMatch(/-H 'host:/i);
    expect(curl).not.toMatch(/content-length/i);
  });

  test('GET without a body has no data flag', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { method: 'GET', path: '/plain' });
    await requestRow(page, 'GET', '/plain').click();
    await page.getByRole('button', { name: 'Copy as curl' }).click();
    const curl = await clipboard(page);
    expect(curl.startsWith(`curl '${endpoint.url}/plain'`)).toBe(true);
    expect(curl).not.toContain('--data-binary');
    expect(curl).not.toContain('-X');
  });

  test('binary request is reproduced byte-exact through base64', async ({ page, endpoint }) => {
    await openDashboard(page, endpoint);
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x10]);
    await sendHook(endpoint.slug, { path: '/binary', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    await requestRow(page, 'POST', '/binary').click();
    await page.getByRole('button', { name: 'Copy as curl' }).click();
    const curl = await clipboard(page);
    expect(curl.startsWith(`printf '%s' '${bytes.toString('base64')}' | base64 -d | curl`)).toBe(true);
    expect(curl).toContain('--data-binary @-');
  });
});
