import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiBase } from '../../lib/api';
import { buildPlansView, FREE_LIMITS, nav, PRO_LIMITS } from '../../lib/billing';
import type { Billing, MeResponse, Subdomain } from '../../lib/types';
import { BillingBanners, PlanCard } from '../PlanCard';

const billing = (over: Partial<Billing> = {}): Billing => ({ enabled: true, status: 'none', interval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null, lapsedUntil: null, ...over });
const me = (plan: string, over: Partial<MeResponse> = {}): MeResponse => ({
  account: { id: 'a1', email: 'a@b.c', displayName: null, plan },
  limits: plan === 'free' ? FREE_LIMITS : PRO_LIMITS,
  providers: { github: false, google: false, magic: true },
  ...over,
});
const sub = (slug: string, over: Partial<Subdomain> = {}): Subdomain => ({
  slug, url: `https://${slug}.nanana.lat`, dashboardUrl: '', isCustom: false, ownerId: 'a1', state: 'active', lastActivityAt: '', hardExpiresAt: '', offlineStatus: 200, offlineBody: '', hmac: null, tunnelOnline: false, mock: null, ...over,
});

function mount(ui: React.ReactElement, url = '/account') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter></QueryClientProvider>);
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('PlanCard', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let go: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    setApiBase('http://api.test');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    go = vi.spyOn(nav, 'go').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    go.mockRestore();
    setApiBase(null);
  });

  it('free: shows usage and starts a monthly checkout then redirects', async () => {
    fetchMock.mockResolvedValue(json(200, { url: 'https://checkout.stripe.test/s/1' }));
    mount(<PlanCard me={me('free')} billing={billing()} subdomains={[sub('a'), sub('b', { isCustom: true })]} />);
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('No subscription')).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Manage billing/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Upgrade, \$80\/year/ })).toHaveTextContent('save $16');
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade, $8/month' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://checkout.stripe.test/s/1'));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/billing/checkout');
    expect(JSON.parse(init.body)).toEqual({ interval: 'month' });
  });

  it('pro: shows renewal date, reserved names and the portal button', async () => {
    fetchMock.mockResolvedValue(json(200, { url: 'https://billing.stripe.test/p/1' }));
    mount(<PlanCard me={me('pro')} billing={billing({ status: 'active', interval: 'month', currentPeriodEnd: '2027-01-10T12:00:00Z' })} subdomains={[sub('a', { alwaysOn: true })]} />);
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('Renews on')).toBeInTheDocument();
    expect(screen.getByText('Reserved names')).toBeInTheDocument();
    expect(screen.getByText('1 of 25')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upgrade/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Manage billing/ }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://billing.stripe.test/p/1'));
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/billing/portal');
  });

  it('pro with a pending cancellation says when it ends', () => {
    mount(<PlanCard me={me('pro')} billing={billing({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2027-01-10T12:00:00Z' })} />);
    expect(screen.getByText('Ends on')).toBeInTheDocument();
    expect(screen.getByText('Active, cancels at period end')).toBeInTheDocument();
  });

  it('pro_grace: shows the failed state and the payment deadline', () => {
    mount(<PlanCard me={me('pro_grace')} billing={billing({ status: 'past_due', graceUntil: '2026-12-14T12:00:00Z' })} />);
    expect(screen.getByText('Pro (payment failed)')).toBeInTheDocument();
    expect(screen.getByText('Payment failed')).toBeInTheDocument();
    expect(screen.getByText('Update payment by')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Manage billing/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Upgrade/ })).toBeNull();
  });

  it('lapsed: offers resubscribe and the read-only deadline', () => {
    mount(<PlanCard me={me('lapsed', { limits: FREE_LIMITS })} billing={billing({ status: 'canceled', lapsedUntil: '2027-01-13T12:00:00Z' })} />);
    expect(screen.getByText('Lapsed')).toBeInTheDocument();
    expect(screen.getByText('Read-only until')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resubscribe, $8/month' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Manage billing/ })).toBeInTheDocument();
  });

  it('billing disabled: upgrade buttons are disabled with an explanation', () => {
    mount(<PlanCard me={me('free')} billing={billing({ enabled: false })} />);
    expect(screen.getByText(/Pro is coming soon/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade, $8/month' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Upgrade, \$80\/year/ })).toBeDisabled();
  });

  it('plans API 404 (enabled false) also disables upgrades', () => {
    mount(<PlanCard me={me('free')} plans={buildPlansView(null, false)} />);
    expect(screen.getByRole('button', { name: 'Upgrade, $8/month' })).toBeDisabled();
  });

  it.each([
    [404, 'billing_disabled', /not available right now/],
    [409, 'already_subscribed', /already have an active subscription/],
  ])('checkout error %s %s is explained and the button recovers', async (status, code, text) => {
    fetchMock.mockResolvedValue(json(status, { error: { code, message: 'x' } }));
    mount(<PlanCard me={me('free')} billing={billing()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade, $8/month' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Upgrade, $8/month' })).toBeEnabled();
    expect(go).not.toHaveBeenCalled();
  });

  it('checkout network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    mount(<PlanCard me={me('free')} billing={billing()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade, $8/month' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach/);
  });

  it('portal no_customer error', async () => {
    fetchMock.mockResolvedValue(json(409, { error: { code: 'no_customer', message: 'x' } }));
    mount(<PlanCard me={me('pro')} billing={billing({ status: 'active' })} />);
    await userEvent.click(screen.getByRole('button', { name: /Manage billing/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no billing profile/);
  });

  it('rejects a non-http redirect URL', async () => {
    fetchMock.mockResolvedValue(json(200, { url: 'javascript:alert(1)' }));
    mount(<PlanCard me={me('free')} billing={billing()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade, $8/month' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unexpected response/);
    expect(go).not.toHaveBeenCalled();
  });

  it('?upgrade=year starts the yearly checkout once', async () => {
    fetchMock.mockResolvedValue(json(200, { url: 'https://checkout.stripe.test/s/2' }));
    mount(<PlanCard me={me('free')} billing={billing()} />, '/account?upgrade=year');
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://checkout.stripe.test/s/2'));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ interval: 'year' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('?upgrade does nothing for an account that is already Pro', async () => {
    mount(<PlanCard me={me('pro')} billing={billing({ status: 'active' })} />, '/account?upgrade=month');
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('BillingBanners', () => {
  beforeEach(() => {
    setApiBase('http://api.test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {})));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiBase(null);
  });

  it('shows nothing for a plain free account', () => {
    const { container } = mount(<BillingBanners me={me('free')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('pro_grace banner names the deadline and offers the portal', () => {
    mount(<BillingBanners me={me('pro_grace')} billing={billing({ graceUntil: '2026-12-14T12:00:00Z' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Update your card by .* or your endpoints go read-only/);
    expect(screen.getByRole('button', { name: 'Update payment method' })).toBeInTheDocument();
  });

  it('lapsed banner offers resubscribe and manage billing', () => {
    mount(<BillingBanners me={me('lapsed')} billing={billing({ lapsedUntil: '2027-01-13T12:00:00Z' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/read-only until .*Resubscribe to keep them/);
    expect(screen.getByRole('button', { name: 'Resubscribe' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage billing' })).toBeInTheDocument();
  });

  it('success while still free waits, then times out with a message', async () => {
    mount(<BillingBanners me={me('free')} pollMs={10} timeoutMs={60} />, '/account?billing=success');
    expect(screen.getByText(/Activating your Pro plan/)).toBeInTheDocument();
    expect(await screen.findByText(/still being confirmed/)).toBeInTheDocument();
  });

  it('success on Pro shows the confirmation; cancelled says nothing was charged', () => {
    const a = mount(<BillingBanners me={me('pro')} />, '/account?billing=success');
    expect(screen.getByText(/Your account is on Pro now/)).toBeInTheDocument();
    a.unmount();
    mount(<BillingBanners me={me('free')} />, '/account?billing=cancelled');
    expect(screen.getByText(/You have not been charged/)).toBeInTheDocument();
  });
});
