import { useQueryClient } from '@tanstack/react-query';
import { CreditCard, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  billingErrorMessage,
  billingStatusLabel,
  formatDate,
  formatUsd,
  limitRows,
  normalizePlan,
  parseInterval,
  planLabel,
  selectBanner,
  STATIC_PLANS_VIEW,
  yearlySavingCents,
  type PlansView,
} from '../lib/billing';
import type { Billing, Interval, MeResponse, Subdomain } from '../lib/types';
import { useCheckout, usePortal } from '../lib/useBilling';
import { Notice } from './ui';

type Props = {
  me: MeResponse;
  /** Result of GET /billing (preferred over `me.billing`). */
  billing?: Billing | null;
  subdomains?: Subdomain[];
  plans?: PlansView;
};

function effectiveBilling(me: MeResponse, billing?: Billing | null): Billing | null {
  return billing ?? me.billing ?? null;
}

/** Plan, billing state, limits in use and the upgrade / manage buttons. */
export function PlanCard({ me, billing: b, subdomains, plans = STATIC_PLANS_VIEW }: Props) {
  const billing = effectiveBilling(me, b);
  const plan = normalizePlan(me.account.plan);
  const checkout = useCheckout();
  const portal = usePortal();
  const [params, setParams] = useSearchParams();
  const auto = useRef(false);

  const billingOff = billing?.enabled === false || !plans.enabled;
  const canBuy = plan === 'free' || plan === 'lapsed';
  const hasCustomer = plan !== 'free' || (billing != null && billing.status !== 'none');

  // `?upgrade=month|year` comes from the pricing section through the login: start checkout once.
  const wanted = parseInterval(params.get('upgrade'));
  useEffect(() => {
    if (!wanted || auto.current) return;
    auto.current = true;
    const next = new URLSearchParams(params);
    next.delete('upgrade');
    setParams(next, { replace: true });
    if (canBuy && !billingOff) checkout.mutate(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  const used = subdomains ? { endpoints: subdomains.length, names: subdomains.filter((s) => s.isCustom).length } : undefined;
  const rows = limitRows(me.limits, used);
  const busy = checkout.isPending || checkout.isSuccess || portal.isPending || portal.isSuccess;
  const pro = plans.pro;
  const saving = yearlySavingCents(pro);

  const dates: [string, string][] = [];
  if (billing) {
    if (plan === 'pro' && billing.currentPeriodEnd) dates.push([billing.cancelAtPeriodEnd ? 'Ends on' : 'Renews on', formatDate(billing.currentPeriodEnd)]);
    if (plan === 'pro_grace' && billing.graceUntil) dates.push(['Update payment by', formatDate(billing.graceUntil)]);
    if (plan === 'lapsed' && billing.lapsedUntil) dates.push(['Read-only until', formatDate(billing.lapsedUntil)]);
    if (plan === 'lapsed' && billing.currentPeriodEnd) dates.push(['Ended on', formatDate(billing.currentPeriodEnd)]);
  }
  const error = checkout.isError ? billingErrorMessage(checkout.error) : portal.isError ? billingErrorMessage(portal.error) : null;

  return (
    <div className="card space-y-4 p-4" data-testid="plan-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm text-muted">Current plan</p>
        <span className={`chip text-xs ${plan === 'pro' ? 'bg-accent/15 text-accent' : plan === 'free' ? 'bg-raised text-fg' : 'bg-warn/15 text-warn'}`}>{planLabel(plan)}</span>
        <p className="text-sm text-muted">Billing: <span className="text-fg">{billingStatusLabel(billing)}</span></p>
      </div>

      {dates.length > 0 && (
        <dl className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
          {dates.map(([k, v]) => (
            <div key={k} className="flex gap-2"><dt className="text-muted">{k}</dt><dd className="font-medium">{v}</dd></div>
          ))}
        </dl>
      )}

      {rows.length > 0 && (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.key} className="flex justify-between gap-4 border-b border-line py-1"><dt className="text-muted">{r.label}</dt><dd className="text-right font-mono">{r.value}</dd></div>
          ))}
        </dl>
      )}

      {billingOff && canBuy && <Notice>Pro is coming soon. Billing is not enabled on this server yet.</Notice>}

      <div className="flex flex-wrap items-center gap-2">
        {canBuy && (
          <>
            <button type="button" className="btn btn-primary" disabled={busy || billingOff} onClick={() => checkout.mutate('month')}>
              <Sparkles size={14} aria-hidden /> {checkout.isPending && checkout.variables === 'month' ? 'Redirecting...' : `${plan === 'lapsed' ? 'Resubscribe' : 'Upgrade'}, ${formatUsd(pro.priceMonthlyCents)}/month`}
            </button>
            {pro.priceYearlyCents != null && (
              <button type="button" className="btn" disabled={busy || billingOff} onClick={() => checkout.mutate('year')}>
                {checkout.isPending && checkout.variables === 'year' ? 'Redirecting...' : `${plan === 'lapsed' ? 'Resubscribe' : 'Upgrade'}, ${formatUsd(pro.priceYearlyCents)}/year`}
                {saving > 0 && <span className="chip bg-ok/15 text-ok">save {formatUsd(saving)}</span>}
              </button>
            )}
          </>
        )}
        {hasCustomer && (
          <button type="button" className="btn" disabled={busy} onClick={() => portal.mutate()}>
            <CreditCard size={14} aria-hidden /> {portal.isPending ? 'Opening...' : 'Manage billing'}
          </button>
        )}
      </div>
      {(checkout.isPending || checkout.isSuccess) && <p role="status" className="text-xs text-muted">Taking you to checkout...</p>}
      {(portal.isPending || portal.isSuccess) && <p role="status" className="text-xs text-muted">Opening the billing portal...</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <p className="text-xs text-faint">Cancel any time from the billing portal. Prices are in USD, tax excluded.</p>
    </div>
  );
}

type BannersProps = {
  me: MeResponse;
  billing?: Billing | null;
  /** Polling cadence and give-up time while waiting for the webhook after checkout (overridable in tests). */
  pollMs?: number;
  timeoutMs?: number;
};

/** Checkout result banners (`?billing=success|cancelled`) and the payment-failed / lapsed warnings. */
export function BillingBanners({ me, billing: b, pollMs = 2000, timeoutMs = 30_000 }: BannersProps) {
  const billing = effectiveBilling(me, b);
  const plan = normalizePlan(me.account.plan);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [ret] = useState(() => {
    const v = params.get('billing');
    return v === 'success' || v === 'cancelled' ? v : null;
  });
  const [timedOut, setTimedOut] = useState(false);
  const checkout = useCheckout();
  const portal = usePortal();

  useEffect(() => {
    if (!params.has('billing')) return;
    const next = new URLSearchParams(params);
    next.delete('billing');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const waiting = ret === 'success' && plan !== 'pro' && !timedOut;
  useEffect(() => {
    if (!waiting) return;
    const refetch = () => void Promise.all([qc.refetchQueries({ queryKey: ['me'] }), qc.refetchQueries({ queryKey: ['billing'] })]);
    const poll = setInterval(refetch, pollMs);
    const stop = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [waiting, qc, pollMs, timeoutMs]);

  const banner = selectBanner(plan, billing);
  const busy = checkout.isPending || checkout.isSuccess || portal.isPending || portal.isSuccess;
  const err = checkout.isError ? billingErrorMessage(checkout.error) : portal.isError ? billingErrorMessage(portal.error) : null;

  if (!ret && !banner) return null;
  return (
    <div className="space-y-3">
      {ret === 'success' && plan === 'pro' && <Notice tone="ok">Payment received. Your account is on Pro now: more endpoints, reserved names and always-on endpoints are unlocked.</Notice>}
      {waiting && <Notice tone="info">Payment received. Activating your Pro plan, this usually takes a few seconds...</Notice>}
      {ret === 'success' && plan !== 'pro' && timedOut && (
        <Notice tone="warn">Your payment is still being confirmed. This can take a few minutes. Reload this page shortly; if your plan does not change, contact support and mention the email of this account.</Notice>
      )}
      {ret === 'cancelled' && <Notice>Checkout was cancelled. You have not been charged.</Notice>}
      {banner && (
        <div role="alert" className={`rounded-lg border px-4 py-3 text-sm ${banner.kind === 'lapsed' ? 'border-bad/50 bg-bad/5' : 'border-warn/50 bg-warn/5'}`} data-testid={`banner-${banner.kind}`}>
          <p className={`font-semibold ${banner.kind === 'lapsed' ? 'text-bad' : 'text-warn'}`}>{banner.title}</p>
          <p className="mt-1 text-fg">{banner.message}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => (banner.action === 'portal' ? portal.mutate() : checkout.mutate('month' as Interval))}
            >
              {busy ? 'Redirecting...' : banner.actionLabel}
            </button>
            {banner.action === 'resubscribe' && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => portal.mutate()}>Manage billing</button>
            )}
          </div>
          {err && <p className="mt-2 text-bad">{err}</p>}
        </div>
      )}
    </div>
  );
}
