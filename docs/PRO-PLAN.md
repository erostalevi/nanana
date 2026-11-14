# Pro plan (decisions, ready to build)

Status: designed, not built. Billing through **Stripe** (US entity via Atlas). Start in Stripe **test mode**; nothing depends on the Atlas account existing yet.

## Plans

| | Free | Pro |
|---|---|---|
| Price | $0 | **$8/month or $80/year** (no trial: the free tier is the trial) |
| Endpoints | 3 | 25 |
| Reserved names (never expire, never released while subscribed) | 0 (1 custom name that idles out) | 10 |
| Lifetime | idle death at 24 h, 7-day cap | always-on (no idle death, no 7-day cap) |
| Retention per endpoint | 100 requests / 1 h / 50 MB | 1000 requests / 24 h / 250 MB |
| Max body | 5 MB | 10 MB |
| Rate per endpoint | 300 req/min | 1500 req/min |
| Simultaneous tunnels | 1 per endpoint | 5 per account |

All numbers live in one config object (`PlanLimits` in `apps/api/src/config/plan-limits.ts`), so changing them is a one-line edit.

## Lapse policy

1. Payment fails: Stripe retries; account keeps Pro for a **7-day grace period**.
2. After grace: endpoints become **read-only for 30 days** (existing data visible, no new captures, reserved names stay reserved).
3. After 30 days: free rules apply (idle death, 7-day cap), reserved names are released (with the normal 7-day tombstone for the previous owner), endpoints beyond the free limit are archived then deleted by the normal lifecycle.
4. Re-subscribing during the read-only window restores everything.

## Tax

Launch with Stripe Tax parameters wired in but switched off; enable Stripe Tax (0.5% per transaction) once registration thresholds are reached. Prices are shown tax-exclusive until then.

## Build plan

1. Data model: `subscription` (account_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, grace_until, canceled_at), `account.plan` stays the source of truth for limits (`free` | `pro`), set only by the billing webhook or the admin CLI.
2. `PlanLimits`: add `pro`, plus new fields (`reservedNames`, `alwaysOn`, `tunnelsPerAccount`, retention and rate per plan).
3. Ingress and lifecycle read the **owner's real plan** (today owned endpoints assume `free`): join `account.plan` when loading the subdomain; skip idle death and the 7-day cap for always-on endpoints; read-only mode for lapsed accounts.
4. Reserved names: `subdomain.reserved_until` (exists) managed by plan, with a dashboard toggle to mark which endpoints use the 10 reserved slots.
5. Billing endpoints: `POST /billing/checkout` (Stripe Checkout session), `POST /billing/portal` (customer portal link), `POST /billing/webhook` (signature verified with the existing HMAC helper; idempotent by Stripe event id; handles `checkout.session.completed`, `customer.subscription.updated|deleted`, `invoice.payment_failed|paid`).
6. Web: pricing section on the landing page and docs, `/account` plan card with upgrade/manage buttons, limits shown from `GET /me`.
7. Tests: webhook signature and idempotency, plan transitions (grace, read-only, release), limits per plan; Stripe test-mode end to end with the Stripe CLI.
8. Secrets (SSM): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`.

## Unit economics (rough)

Fixed infra today about $15/month; a `t3.small` (about +$7.6) roughly doubles sustained capacity. At $8/month the Stripe fee is about $0.53, so about $7.47 net per subscriber. Atlas costs about $500 once plus about $500/year for the entity and agent, so break-even is roughly 12 subscribers.
