import { test, expect } from '../fixtures';
import { billingFor, CHECKOUT_URL, checkoutErrors, meFor, mockBilling, plansBody, PORTAL_URL, sub } from '../lib/billingMock';

const pricing = (page: import('@playwright/test').Page) => page.locator('#pricing');

test.describe('landing: pricing section', () => {
  test('shows Free vs Pro with the real numbers', async ({ page }) => {
    await mockBilling(page, { me: null });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Pricing', exact: true })).toBeVisible();
    await expect(page.getByText('Coming soon.')).toHaveCount(0);
    const free = pricing(page).getByRole('article', { name: 'Free' });
    for (const t of ['$0', '3 endpoints', '1 custom name', 'Idle death at 24 h, 7-day cap', '100 requests / 1 h / 50 MB', '5 MB bodies', '300 requests/min per endpoint']) {
      await expect(free).toContainText(t);
    }
    const pro = pricing(page).getByRole('article', { name: 'Pro' });
    for (const t of ['$8/month', '25 endpoints', '10 reserved names', 'Always-on', '1000 requests / 24 h / 250 MB', '10 MB bodies', '1500 requests/min per endpoint', '5 simultaneous tunnels']) {
      await expect(pro).toContainText(t);
    }
    await expect(pricing(page)).not.toContainText('coming soon');
  });

  test('uses the limits returned by GET /billing/plans', async ({ page }) => {
    await mockBilling(page, { me: null, plans: plansBody({ proLimits: { maxActiveSubdomains: 40 } }) });
    await page.goto('/');
    await expect(pricing(page).getByRole('article', { name: 'Pro' })).toContainText('40 endpoints');
  });

  test('falls back to the static numbers when the plans call fails', async ({ page }) => {
    await mockBilling(page, { me: null, plans: null });
    await page.goto('/');
    await expect(pricing(page).getByRole('article', { name: 'Pro' })).toContainText('25 endpoints');
    await expect(pricing(page).getByRole('button', { name: 'Coming soon' })).toBeDisabled();
  });

  test('monthly / yearly toggle shows the yearly saving', async ({ page }) => {
    await mockBilling(page, { me: null });
    await page.goto('/');
    const month = pricing(page).getByRole('button', { name: 'Monthly' });
    const year = pricing(page).getByRole('button', { name: 'Yearly, save $16' });
    await expect(month).toHaveAttribute('aria-pressed', 'true');
    await year.click();
    await expect(year).toHaveAttribute('aria-pressed', 'true');
    await expect(pricing(page).getByRole('article', { name: 'Pro' })).toContainText('$80/year');
    await expect(pricing(page)).toContainText('$16 less than paying monthly');
    // keyboard: the toggle is reachable and works with Space
    await month.focus();
    await page.keyboard.press('Space');
    await expect(pricing(page).getByRole('article', { name: 'Pro' })).toContainText('$8/month');
  });

  test('enabled=false shows Pro as coming soon with a disabled button', async ({ page }) => {
    await mockBilling(page, { me: null, plans: plansBody({ enabled: false }) });
    await page.goto('/');
    const pro = pricing(page).getByRole('article', { name: 'Pro' });
    await expect(pro.getByRole('button', { name: 'Coming soon' })).toBeDisabled();
    await expect(pro).toContainText('Coming soon. $8/month or $80/year when it launches.');
    await expect(pro.getByRole('link', { name: 'Upgrade to Pro' })).toHaveCount(0);
  });

  test('free CTA: signed out offers sign in and focuses the hero button', async ({ page }) => {
    await mockBilling(page, { me: null });
    await page.goto('/');
    const free = pricing(page).getByRole('article', { name: 'Free' });
    await expect(free.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login?next=/account');
    await free.getByRole('button', { name: 'Try it now' }).click();
    await expect(page.getByRole('button', { name: 'Create an endpoint' })).toBeFocused();
  });

  test('free CTA: signed in links to the account', async ({ page }) => {
    await mockBilling(page);
    await page.goto('/');
    await expect(pricing(page).getByRole('article', { name: 'Free' }).getByRole('link', { name: 'Your endpoints' })).toHaveAttribute('href', '/account');
  });
});

test.describe('upgrade flow', () => {
  test('signed out: Pro CTA goes to login with the chosen interval in next', async ({ page }) => {
    await mockBilling(page, { me: null });
    await page.goto('/');
    const cta = pricing(page).getByRole('link', { name: 'Upgrade to Pro' });
    await expect(cta).toHaveAttribute('href', '/login?next=/account%3Fupgrade%3Dmonth');
    await pricing(page).getByRole('button', { name: /^Yearly/ }).click();
    await expect(cta).toHaveAttribute('href', '/login?next=/account%3Fupgrade%3Dyear');
    await cta.click();
    await expect(page).toHaveURL(/\/login\?next=\/account%3Fupgrade%3Dyear$/);
  });

  test('signed in: checkout is created with the interval and the browser is redirected', async ({ page }) => {
    const m = await mockBilling(page);
    await page.goto('/');
    await pricing(page).getByRole('button', { name: /^Yearly/ }).click();
    await pricing(page).getByRole('button', { name: 'Upgrade to Pro' }).click();
    await expect(page).toHaveURL(CHECKOUT_URL);
    await expect(page.getByRole('heading', { name: 'Fake Stripe Checkout' })).toBeVisible();
    expect(m.calls.filter((c) => c.path === '/billing/checkout')).toEqual([{ method: 'POST', path: '/billing/checkout', body: { interval: 'year' } }]);
  });

  test('signed in: checkout errors are shown and the button recovers', async ({ page }) => {
    const m = await mockBilling(page, { checkout: checkoutErrors.subscribed });
    await page.goto('/');
    await pricing(page).getByRole('button', { name: 'Upgrade to Pro' }).click();
    await expect(pricing(page).getByRole('alert')).toContainText('already have an active subscription');
    await expect(pricing(page).getByRole('button', { name: 'Upgrade to Pro' })).toBeEnabled();
    m.checkout = checkoutErrors.disabled;
    await pricing(page).getByRole('button', { name: 'Upgrade to Pro' }).click();
    await expect(pricing(page).getByRole('alert')).toContainText('not available right now');
  });

  test('signed in as Pro: the Pro card points to billing instead of checkout', async ({ page }) => {
    await mockBilling(page, { me: meFor('pro') });
    await page.goto('/');
    await expect(pricing(page).getByRole('link', { name: /You are on Pro/ })).toHaveAttribute('href', '/account');
  });

  test('after login, /account?upgrade=month starts checkout automatically, once', async ({ page }) => {
    const m = await mockBilling(page);
    await page.goto('/account?upgrade=month');
    await expect(page).toHaveURL(CHECKOUT_URL);
    expect(m.count('POST', '/billing/checkout')).toBe(1);
    expect(m.calls.find((c) => c.path === '/billing/checkout')!.body).toEqual({ interval: 'month' });
  });

  test('/account?upgrade=year with a failing checkout shows the error and strips the parameter', async ({ page }) => {
    const m = await mockBilling(page, { checkout: checkoutErrors.disabled });
    await page.goto('/account?upgrade=year');
    await expect(page.getByTestId('plan-card').getByRole('alert')).toContainText('not available right now');
    await expect(page).toHaveURL(/\/account$/);
    await page.reload();
    expect(m.count('POST', '/billing/checkout')).toBe(1);
  });

  test('/account?upgrade=month does not start checkout for a Pro account', async ({ page }) => {
    const m = await mockBilling(page, { me: meFor('pro') });
    await page.goto('/account?upgrade=month');
    await expect(page.getByTestId('plan-card')).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
    expect(m.count('POST', '/billing/checkout')).toBe(0);
  });
});

test.describe('account: plan card states', () => {
  test('free: usage vs limits and the two upgrade buttons', async ({ page }) => {
    const m = await mockBilling(page, { subdomains: [sub('aaaa1111'), sub('bbbb2222', { isCustom: true })] });
    await page.goto('/account');
    const card = page.getByTestId('plan-card');
    await expect(page.getByRole('heading', { name: 'Plan and limits' })).toBeVisible();
    await expect(card.getByText('Free', { exact: true })).toBeVisible();
    await expect(card).toContainText('No subscription');
    await expect(card.getByText('2 of 3')).toBeVisible();
    await expect(card.getByText('1 of 1')).toBeVisible();
    await expect(card).toContainText('100 requests / 1 h / 50 MB');
    await expect(card.getByRole('button', { name: /Manage billing/ })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await card.getByRole('button', { name: /Upgrade, \$80\/year/ }).click();
    await expect(page).toHaveURL(CHECKOUT_URL);
    expect(m.calls.find((c) => c.path === '/billing/checkout')!.body).toEqual({ interval: 'year' });
  });

  test('pro: renewal date, reserved names, badges on endpoints, portal redirect', async ({ page }) => {
    const m = await mockBilling(page, {
      me: meFor('pro'),
      subdomains: [sub('proalways', { alwaysOn: true }), sub('myreserved', { isCustom: true, reserved: true, alwaysOn: true }), sub('plainone')],
    });
    await page.goto('/account');
    const card = page.getByTestId('plan-card');
    await expect(card.getByText('Pro', { exact: true })).toBeVisible();
    await expect(card).toContainText('Active');
    await expect(card.getByText('Renews on')).toBeVisible();
    await expect(card.getByText('Reserved names')).toBeVisible();
    await expect(card.getByText('1 of 10')).toBeVisible();
    await expect(card.getByText('3 of 25')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const list = page.getByRole('region', { name: 'Endpoints' });
    const reserved = list.getByRole('listitem').filter({ hasText: 'myreserved' });
    await expect(reserved.getByText('reserved', { exact: true })).toBeVisible();
    await expect(reserved.getByText('always-on')).toBeVisible();
    await expect(reserved.getByText(/gone in/)).toHaveCount(0);
    await expect(reserved.getByRole('button', { name: 'Renew +7 days' })).toHaveCount(0);
    await expect(list.getByRole('listitem').filter({ hasText: 'plainone' }).getByText(/gone in/)).toBeVisible();
    await card.getByRole('button', { name: 'Manage billing' }).click();
    await expect(page).toHaveURL(PORTAL_URL);
    expect(m.count('POST', '/billing/portal')).toBe(1);
  });

  test('pro with a pending cancellation shows the end date', async ({ page }) => {
    await mockBilling(page, { me: meFor('pro', billingFor('pro', { cancelAtPeriodEnd: true })) });
    await page.goto('/account');
    const card = page.getByTestId('plan-card');
    await expect(card.getByText('Ends on')).toBeVisible();
    await expect(card).toContainText('Active, cancels at period end');
  });

  test('pro_grace: warning banner with the deadline, still Pro limits, manage billing', async ({ page }) => {
    const m = await mockBilling(page, { me: meFor('pro_grace') });
    await page.goto('/account');
    const banner = page.getByTestId('banner-pro_grace');
    await expect(banner).toContainText('Payment failed');
    await expect(banner).toContainText(/Update your card by \w{3} \d{1,2}, \d{4} or your endpoints go read-only/);
    const card = page.getByTestId('plan-card');
    await expect(card.getByText('Pro (payment failed)')).toBeVisible();
    await expect(card.getByText('Update payment by')).toBeVisible();
    await expect(card.getByText('3 of 25')).toHaveCount(0);
    await expect(card.getByRole('button', { name: /Upgrade/ })).toHaveCount(0);
    await banner.getByRole('button', { name: 'Update payment method' }).click();
    await expect(page).toHaveURL(PORTAL_URL);
    expect(m.count('POST', '/billing/portal')).toBe(1);
  });

  test('lapsed: read-only banner, resubscribe starts checkout, endpoint badge', async ({ page }) => {
    const m = await mockBilling(page, { me: meFor('lapsed'), subdomains: [sub('frozen11', { readOnly: true, alwaysOn: true, isCustom: true, reserved: true })] });
    await page.goto('/account');
    const banner = page.getByTestId('banner-lapsed');
    await expect(banner).toContainText('Your Pro plan has ended');
    await expect(banner).toContainText(/Your endpoints are read-only until \w{3} \d{1,2}, \d{4}\. Resubscribe to keep them\./);
    const card = page.getByTestId('plan-card');
    await expect(card.getByText('Lapsed', { exact: true })).toBeVisible();
    await expect(card.getByText('Read-only until')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Endpoints' }).getByText('read-only', { exact: true })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Manage billing' })).toBeVisible();
    await banner.getByRole('button', { name: 'Resubscribe' }).click();
    await expect(page).toHaveURL(CHECKOUT_URL);
    expect(m.calls.find((c) => c.path === '/billing/checkout')!.body).toEqual({ interval: 'month' });
  });

  test('billing disabled: upgrade buttons are disabled', async ({ page }) => {
    await mockBilling(page, { me: meFor('free', billingFor('free', { enabled: false })), plans: plansBody({ enabled: false }) });
    await page.goto('/account');
    const card = page.getByTestId('plan-card');
    await expect(card).toContainText('Pro is coming soon');
    await expect(card.getByRole('button', { name: 'Upgrade, $8/month' })).toBeDisabled();
  });

  test('server without billing endpoints (404) still renders the account', async ({ page }) => {
    const free = meFor('free');
    delete (free as { billing?: unknown }).billing;
    await mockBilling(page, { me: free, billing: null, plans: null });
    await page.goto('/account');
    const card = page.getByTestId('plan-card');
    await expect(card.getByText('Free', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Upgrade, $8/month' })).toBeDisabled();
  });

  test('portal errors: no_customer', async ({ page }) => {
    await mockBilling(page, { me: meFor('pro'), portal: checkoutErrors.noCustomer });
    await page.goto('/account');
    await page.getByTestId('plan-card').getByRole('button', { name: 'Manage billing' }).click();
    await expect(page.getByTestId('plan-card').getByRole('alert')).toContainText('no billing profile');
  });

  test('checkout network error', async ({ page }) => {
    await mockBilling(page);
    await page.goto('/account');
    await page.route((u) => u.pathname === '/billing/checkout', (r) => r.abort('failed'));
    await page.getByRole('button', { name: 'Upgrade, $8/month' }).click();
    await expect(page.getByTestId('plan-card').getByRole('alert')).toContainText('Could not reach');
    await expect(page.getByRole('button', { name: 'Upgrade, $8/month' })).toBeEnabled();
  });
});

test.describe('account: checkout return', () => {
  test('?billing=success waits until /me reports Pro', async ({ page }) => {
    let polls = 0;
    const m = await mockBilling(page);
    m.me = () => (++polls >= 3 ? meFor('pro') : meFor('free'));
    await page.goto('/account?billing=success');
    await expect(page.getByText('Activating your Pro plan')).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText('Your account is on Pro now')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('plan-card').getByText('Pro', { exact: true })).toBeVisible();
  });

  test('?billing=success on an account that is already Pro confirms immediately', async ({ page }) => {
    await mockBilling(page, { me: meFor('pro') });
    await page.goto('/account?billing=success');
    await expect(page.getByText('Your account is on Pro now')).toBeVisible();
  });

  test('?billing=cancelled says nothing was charged', async ({ page }) => {
    await mockBilling(page);
    await page.goto('/account?billing=cancelled');
    await expect(page.getByText('Checkout was cancelled. You have not been charged.')).toBeVisible();
  });
});

test.describe('dashboard and docs', () => {
  async function dashboard(page: import('@playwright/test').Page, over: Record<string, unknown>) {
    const slug = 'bill0001';
    await page.route((u) => u.origin === 'http://localhost:3201' && u.pathname.startsWith(`/subdomains/${slug}`), (r) => {
      const h = { 'access-control-allow-credentials': 'true', 'access-control-allow-origin': r.request().headers().origin ?? '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      const p = new URL(r.request().url()).pathname;
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
      if (p.endsWith('/stream')) return r.abort('failed');
      if (p.endsWith('/requests')) return r.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify({ requests: [] }) });
      return r.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(sub(slug, over)) });
    });
    await page.goto(`http://${slug}.tools.localhost:5173/#t=nnt_fake`);
    await expect(page.getByRole('heading', { name: `Webhook inspector for ${slug}`, includeHidden: true })).toBeAttached();
  }

  test('read-only endpoint shows the lapsed banner', async ({ page }) => {
    await dashboard(page, { alwaysOn: true, readOnly: true });
    await expect(page.getByTestId('read-only-banner')).toContainText("New requests are not being captured because the owner's Pro plan lapsed");
    await expect(page.getByText('read-only', { exact: true })).toBeVisible();
  });

  test('always-on endpoint hides the countdown and shows the Pro badges', async ({ page }) => {
    await dashboard(page, { alwaysOn: true, reserved: true, isCustom: true });
    await expect(page.getByText('always-on', { exact: true })).toBeVisible();
    await expect(page.getByText('Pro', { exact: true })).toBeVisible();
    await expect(page.getByText(/gone in/)).toHaveCount(0);
    await expect(page.getByText(/sleeps in/)).toHaveCount(0);
    await expect(page.getByTestId('read-only-banner')).toHaveCount(0);
  });

  test('free endpoint keeps the countdown', async ({ page }) => {
    await dashboard(page, {});
    await expect(page.getByText(/gone in/)).toBeVisible();
    await expect(page.getByText('always-on', { exact: true })).toHaveCount(0);
  });

  test('docs: limits table has a Pro column and the billing section explains lapse', async ({ page }) => {
    await page.goto('/docs#billing');
    const table = page.getByRole('table', { name: 'Limits per plan' });
    await expect(table.getByRole('columnheader', { name: 'Pro' })).toBeVisible();
    await expect(table.getByRole('row', { name: /Active endpoints/ })).toContainText('25 active');
    const sec = page.getByRole('heading', { name: 'Plans and billing' });
    await expect(sec).toBeVisible();
    const article = page.getByRole('article');
    await expect(article).toContainText('7-day grace period');
    await expect(article).toContainText('read-only for 30 days');
    await expect(article).toContainText('Cancel any time');
  });
});
