import { test, expect, openDashboard, requestRow } from '../fixtures';
import { sendHook } from '../lib/api';

test.describe('replay', () => {
  test('replay to a public URL (local stub) and see it in the Replays tab', async ({ page, endpoint, stub }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { path: '/orders?id=7', headers: { 'x-origin': 'e2e' }, body: { amount: 1234 } });
    await requestRow(page, 'POST', '/orders?id=7').click();

    // No tunnel: the tunnel option is disabled and "Public URL" is selected.
    await expect(page.getByRole('radio', { name: 'My tunnel' })).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Public URL' })).toBeChecked();

    // validation first
    const url = page.getByLabel('Replay target URL');
    await url.fill('not a url');
    await url.blur();
    await expect(page.getByText('Enter a full URL')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeDisabled();

    await url.fill(`${stub.url}/hook`);
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(page.getByText('Replay result:')).toContainText('201');

    // switches to the Replays tab and lists the replay
    await expect(page.getByRole('tab', { name: /Replays/ })).toHaveAttribute('aria-selected', 'true');
    const item = page.getByRole('tabpanel').getByRole('button', { name: /201/ });
    await expect(item).toContainText(`${stub.url}/hook`);
    await item.click();
    await expect(page.getByRole('tabpanel')).toContainText('x-stub');
    await expect(page.getByRole('tabpanel').getByTestId('body-view')).toContainText('"stub"');

    // the stub really received the original request
    expect(stub.hits).toHaveLength(1);
    const hit = stub.hits[0]!;
    expect(hit.method).toBe('POST');
    expect(hit.url).toBe('/hook');
    expect(JSON.parse(hit.body)).toEqual({ amount: 1234 });
    expect(hit.headers['x-origin']).toBe('e2e');

    // the replay count badge on the tab, and the URL is remembered for this endpoint
    await expect(page.getByRole('tab', { name: /Replays/ })).toContainText('1');
    expect(await page.evaluate((s) => localStorage.getItem(`nanana:replay-url:${s}`), endpoint.slug)).toBe(`${stub.url}/hook`);
  });

  test('replay with a header override and a failing target', async ({ page, endpoint, stub }) => {
    await openDashboard(page, endpoint);
    await sendHook(endpoint.slug, { path: '/ovr', body: 'hello', headers: { 'content-type': 'text/plain' } });
    await requestRow(page, 'POST', '/ovr').click();
    await page.getByRole('button', { name: 'Headers', exact: true }).click();
    await page.getByRole('button', { name: 'Add header' }).click();
    await page.getByLabel('Override header name 1').fill('x-e2e-override');
    await page.getByLabel('Override header value 1').fill('e2e-suite');
    stub.status = 500;
    stub.responseBody = 'boom';
    await page.getByLabel('Replay target URL').fill(`${stub.url}/fail`);
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(page.getByText('Replay result:')).toContainText('500');
    expect(stub.hits[0]!.headers['x-e2e-override']).toBe('e2e-suite');
    expect(stub.hits[0]!.headers['x-replayed-by']).toBe('nanana');
    expect(stub.hits[0]!.headers['x-replay-of']).toBeTruthy();
    expect(stub.hits[0]!.body).toBe('hello');

    // unreachable target: error is reported, not thrown
    await page.getByRole('tab', { name: 'Request' }).click();
    await page.getByLabel('Replay target URL').fill('http://127.0.0.1:9/nowhere');
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(page.getByText('Replay failed to reach the target')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Replays/ })).toContainText('2');
  });

  test('tunnel: disabled when offline, then a fake CLI connects and replay-through-tunnel works', async ({ page, endpoint, tunnels }) => {
    await openDashboard(page, endpoint);
    await expect(page.getByRole('button', { name: 'Tunnel not connected' })).toBeVisible();
    await sendHook(endpoint.slug, { path: '/before-tunnel', body: { n: 1 } });
    await requestRow(page, 'POST', '/before-tunnel').click();
    await expect(page.getByRole('radio', { name: 'My tunnel' })).toBeDisabled();
    // the offline hint tells the user how to connect
    await expect(page.getByText('My tunnel is disabled:')).toContainText(`nanana -t=${endpoint.token} -p=3000`);

    // Tunnel indicator popover documents the command
    await page.getByRole('button', { name: 'Tunnel not connected' }).click();
    await expect(page.getByText('Connect a tunnel')).toBeVisible();
    await page.getByRole('button', { name: 'Tunnel not connected' }).click();

    const tunnel = await tunnels.open(endpoint);
    expect(tunnel.hello).toMatchObject({ t: 'hello', protocol: 1, sub: endpoint.slug });
    // indicator turns on live, no reload
    await expect(page.getByRole('button', { name: /Tunnel connected/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'My tunnel' })).toBeEnabled();

    // New webhooks are answered by the tunnel (the "local app" says 202)
    const live = await sendHook(endpoint.slug, { path: '/through', body: { via: 'tunnel' } });
    expect(live.status).toBe(202);
    expect(live.text).toBe('{"tunnel":"ok"}');
    expect(live.headers['x-from']).toBe('fake-tunnel');
    await expect(requestRow(page, 'POST', '/through')).toContainText('202');
    expect(tunnel.received).toHaveLength(1);
    expect(tunnel.received[0]).toMatchObject({ method: 'POST', path: '/through', replay: false });
    expect(JSON.parse(tunnel.received[0]!.body.toString())).toEqual({ via: 'tunnel' });

    // Replay the earlier request through the tunnel
    await requestRow(page, 'POST', '/before-tunnel').click();
    await page.getByRole('radio', { name: 'My tunnel' }).check();
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(page.getByText('Replay result:')).toContainText('202');
    await expect(page.getByRole('tab', { name: /Replays/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel').getByRole('button', { name: /202/ })).toContainText('tunnel');
    expect(tunnel.received).toHaveLength(2);
    expect(tunnel.received[1]).toMatchObject({ method: 'POST', path: '/before-tunnel', replay: true });
    expect(JSON.parse(tunnel.received[1]!.body.toString())).toEqual({ n: 1 });

    // Disconnect: indicator goes off, option disabled again, and the offline response returns
    await tunnel.close();
    await expect(page.getByRole('button', { name: 'Tunnel not connected' })).toBeVisible();
    await requestRow(page, 'POST', '/before-tunnel').click();
    await expect(page.getByRole('radio', { name: 'My tunnel' })).toBeDisabled();
    expect((await sendHook(endpoint.slug, { path: '/after' })).status).toBe(200);
  });

  test('a tunnel that is already online when the dashboard opens is the default replay target', async ({ page, endpoint, tunnels }) => {
    await sendHook(endpoint.slug, { path: '/pre' });
    const tunnel = await tunnels.open(endpoint);
    await openDashboard(page, endpoint);
    await expect(page.getByRole('button', { name: /Tunnel connected/ })).toBeVisible();
    await requestRow(page, 'POST', '/pre').click();
    await expect(page.getByRole('radio', { name: 'My tunnel' })).toBeChecked();
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(page.getByText('Replay result:')).toContainText('202');
    expect(tunnel.received.at(-1)).toMatchObject({ path: '/pre', replay: true });
  });

  test('tunnel answers large binary bodies byte-exact (multi-frame)', async ({ page, endpoint, tunnels }) => {
    const tunnel = await tunnels.open(endpoint);
    tunnel.respond = (r) => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: `got ${r.body.length}` });
    await openDashboard(page, endpoint);
    const big = Buffer.alloc(150 * 1024, 7);
    const res = await sendHook(endpoint.slug, { path: '/big', headers: { 'content-type': 'application/octet-stream' }, body: big });
    expect(res.text).toBe(`got ${big.length}`);
    expect(Buffer.compare(tunnel.received[0]!.body, big)).toBe(0);
    await expect(requestRow(page, 'POST', '/big')).toBeVisible();
  });
});
