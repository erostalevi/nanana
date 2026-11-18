# Pro plan (decisions, ready to build)

Status: **built** (API, web UI, tests). Billing is dormant in production until Polar credentials are stored: until then `GET /billing/plans` reports `enabled: false` and the web app shows Pro as "Coming soon". Billing runs on **[Polar](https://polar.sh)** as merchant of record (no upfront cost, a percentage per sale; Polar collects and remits sales tax and VAT). Stripe was dropped because it does not onboard Chilean businesses directly.

## Turning it on

1. In Polar, create the organization and two public subscription products: **nanana Pro (monthly)** at $8.00 USD and **nanana Pro (yearly)** at $80.00 USD. Add a webhook endpoint `https://api.nanana.lat/billing/webhook` (raw format) for the `subscription.*` events. Create an organization access token.
2. `POLAR_ACCESS_TOKEN=polar_oat_xxx node tools/polar/setup.mjs --apply` checks the products and webhook (creating what is missing) and stores `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_MONTHLY`, `POLAR_PRODUCT_YEARLY`, `POLAR_SERVER` in SSM under `/nanana/prod/`. Add `--sandbox` for a sandbox token. Run without `--apply` first to see what it would do.
3. Redeploy (push to `main` or run the Deploy workflow). Billing turns on automatically.
4. Comp an account without paying: `docker compose exec api node dist/admin-cli.js set-plan <email> pro` (or `free`).

How it fits together: checkout passes our account id as Polar's `external_customer_id` and forces USD; the webhook (`subscription.created|active|updated|canceled|uncanceled|revoked|past_due`) carries the full subscription, which maps onto the plan state machine. Deliveries are verified with Standard Webhooks (HMAC-SHA256 over `webhook-id.timestamp.body`, 5-minute tolerance) and de-duplicated by `webhook-id` in the `webhook_event` table. The customer portal needs the customer to exist, so `/billing/portal` answers `409 no_customer` until the first subscription webhook has arrived.

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

1. Payment fails: Polar retries; account keeps Pro for a **7-day grace period**.
2. After grace: endpoints become **read-only for 30 days** (existing data visible, no new captures, reserved names stay reserved).
3. After 30 days: free rules apply (idle death, 7-day cap), reserved names are released (with the normal 7-day tombstone for the previous owner), endpoints beyond the free limit are archived then deleted by the normal lifecycle.
4. Re-subscribing during the read-only window restores everything.

## Tax

Polar is the merchant of record: it calculates, collects and remits sales tax and VAT, so nanana does not register for tax collection. Prices are shown tax-exclusive; the checkout adds tax where it applies.

## Unit economics (rough)

Fixed infra today about $15/month; a `t3.small` (about +$7.6) roughly doubles sustained capacity. Polar charges about 4% + $0.40 per transaction (confirm on their pricing page) plus Stripe Connect payout fees (about 0.25% + $0.25 per payout and $2 per active payout month), so roughly $0.75 to $0.90 on an $8 sale. There is no upfront cost, so break-even is the infra bill: about 2 subscribers.
