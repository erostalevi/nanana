import { Check } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { billingErrorMessage, formatMB, formatRetention, formatUsd, normalizePlan, yearlySavingCents } from '../lib/billing';
import type { Interval, Limits } from '../lib/types';
import { useCheckout, usePlans } from '../lib/useBilling';
import { useMe } from '../lib/useMe';
import { Notice } from './ui';

function features(l: Limits, free: boolean): string[] {
  const out = [
    `${l.maxActiveSubdomains} endpoints`,
    l.reservedNames ? `${l.maxCustomNames} reserved names (never expire while subscribed)` : `${l.maxCustomNames} custom name (idles out like the rest)`,
    l.alwaysOn ? 'Always-on: no idle death, no 7-day cap' : 'Idle death at 24 h, 7-day cap',
    `${formatRetention(l)} kept per endpoint`,
    `${formatMB(l.maxBodyBytes)} bodies`,
    `${l.ratePerMinute} requests/min per endpoint`,
    free ? '1 tunnel per endpoint' : `${l.tunnelsPerAccount} simultaneous tunnels`,
  ];
  return out;
}

function Features({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 space-y-2 text-sm text-muted">
      {items.map((t) => (
        <li key={t} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden /><span>{t}</span></li>
      ))}
    </ul>
  );
}

function scrollToCreate() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const hero = document.getElementById('create-endpoint');
  hero?.focus({ preventScroll: true });
}

/** Free vs Pro comparison with the real numbers (GET /billing/plans, static fallback). */
export function Pricing() {
  const plansQ = usePlans();
  const view = plansQ.data!;
  const me = useMe();
  const checkout = useCheckout();
  const [interval, setInterval] = useState<Interval>('month');
  const { free, pro } = view;
  const yearly = pro.priceYearlyCents != null;
  const iv: Interval = yearly ? interval : 'month';
  const saving = yearlySavingCents(pro);
  const signedIn = !!me.data;
  const plan = me.data ? normalizePlan(me.data.account.plan) : null;
  const onPro = plan === 'pro' || plan === 'pro_grace';
  const price = iv === 'year' && pro.priceYearlyCents != null ? pro.priceYearlyCents : pro.priceMonthlyCents;
  const busy = checkout.isPending || checkout.isSuccess;

  return (
    <div className="mx-auto max-w-6xl px-4 py-16">
      <h2 id="pricing-h" className="mb-3 text-2xl font-semibold tracking-tight">Pricing</h2>
      <p className="mb-8 max-w-2xl text-muted">Start free, no card. Go Pro when an endpoint has to stay up: reserved names, always-on and more room per endpoint.</p>
      <div className="grid gap-4 md:grid-cols-2">
        <article className="card flex flex-col p-6" aria-labelledby="plan-free">
          <h3 id="plan-free" className="text-lg font-semibold">Free</h3>
          <p className="mt-2 font-mono text-3xl font-semibold">$0</p>
          <p className="text-sm text-faint">Anonymous or with an account.</p>
          <Features items={features(free.limits, true)} />
          <div className="mt-auto flex flex-wrap items-center gap-3 pt-6">
            {signedIn ? (
              <Link to="/account" className="btn">Your endpoints</Link>
            ) : (
              <>
                <button type="button" className="btn" onClick={scrollToCreate}>Try it now</button>
                <Link to="/login?next=/account" className="link text-sm">Log in</Link>
              </>
            )}
          </div>
        </article>

        <article className="card flex flex-col border-accent/60 p-6" aria-labelledby="plan-pro">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="plan-pro" className="text-lg font-semibold">Pro</h3>
            {yearly && view.enabled && (
              <div role="group" aria-label="Billing interval" className="inline-flex rounded-lg border border-line p-0.5 text-xs">
                {(['month', 'year'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={iv === v}
                    onClick={() => setInterval(v)}
                    className={`rounded-md px-2.5 py-1 font-medium ${iv === v ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}`}
                  >
                    {v === 'month' ? 'Monthly' : saving > 0 ? `Yearly, save ${formatUsd(saving)}` : 'Yearly'}
                  </button>
                ))}
              </div>
            )}
          </div>
          {view.enabled ? (
            <>
              <p className="mt-2 font-mono text-3xl font-semibold">{formatUsd(price)}<span className="text-base font-normal text-muted">/{iv === 'year' ? 'year' : 'month'}</span></p>
              <p className="text-sm text-faint">{iv === 'year' && saving > 0 ? `That is ${formatUsd(Math.round(price / 12))}/month, ${formatUsd(saving)} less than paying monthly.` : 'Cancel any time. Prices exclude tax.'}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">Coming soon. {formatUsd(pro.priceMonthlyCents)}/month{yearly ? ` or ${formatUsd(pro.priceYearlyCents!)}/year` : ''} when it launches.</p>
          )}
          <Features items={features(pro.limits, false)} />
          <div className="mt-auto space-y-3 pt-6">
            {!view.enabled ? (
              <button type="button" className="btn btn-primary" disabled>Coming soon</button>
            ) : onPro ? (
              <Link to="/account" className="btn btn-primary">You are on Pro: manage billing</Link>
            ) : signedIn ? (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => checkout.mutate(iv)}>
                {busy ? 'Redirecting to checkout...' : 'Upgrade to Pro'}
              </button>
            ) : (
              <Link to={`/login?next=/account%3Fupgrade%3D${iv}`} className="btn btn-primary">Upgrade to Pro</Link>
            )}
            {checkout.isError && <Notice tone="error">{billingErrorMessage(checkout.error)}</Notice>}
            <p className="text-xs text-faint">If a payment fails you keep Pro for 7 days, then endpoints are read-only for 30 days before free rules apply. See <Link to="/docs#billing" className="link">Plans and billing</Link>.</p>
          </div>
        </article>
      </div>
    </div>
  );
}
