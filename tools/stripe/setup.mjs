#!/usr/bin/env node
// One-shot Stripe setup for nanana. Idempotent: safe to run again.
//
//   node tools/stripe/setup.mjs --key sk_test_xxx                 # create product, prices, webhook; print the values
//   node tools/stripe/setup.mjs --key sk_test_xxx --apply         # ...and write them to SSM (/nanana/prod/*) with your AWS creds
//   node tools/stripe/setup.mjs --key sk_live_xxx --apply --tax   # live mode, with Stripe Tax enabled
//
// Creates (or reuses, matched by lookup_key / url):
//   - product "nanana Pro"
//   - prices: $8.00/month (lookup_key nanana_pro_monthly) and $80.00/year (nanana_pro_yearly), USD
//   - webhook endpoint https://api.nanana.lat/billing/webhook for the subscription events the API handles
//   - customer portal configuration (cancel at period end, update payment method, invoices)
// With --apply it stores STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY and STRIPE_TAX
// in SSM Parameter Store; the next deploy (or `deploy.sh`) renders them into the server's .env and billing turns on.
import { execFileSync } from 'node:child_process';
import Stripe from 'stripe';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : [])).filter((x) => x.length),
);
const key = args.key || process.env.STRIPE_SECRET_KEY;
if (!key || !/^(sk|rk)_(test|live)_/.test(key)) {
  console.error('Pass your Stripe secret key: --key sk_test_... (or sk_live_...)');
  process.exit(1);
}
const live = key.includes('_live_');
const base = args.base || 'https://api.nanana.lat';
const stripe = new Stripe(key);

console.log(`Stripe ${live ? 'LIVE' : 'test'} mode`);

// product
let product = (await stripe.products.search({ query: "metadata['app']:'nanana' AND active:'true'" })).data[0];
if (!product) {
  product = await stripe.products.create({ name: 'nanana Pro', description: 'Always-on endpoints, reserved names, longer retention, more tunnels.', metadata: { app: 'nanana' } });
  console.log('created product', product.id);
} else console.log('product', product.id);

async function price(lookupKey, unitAmount, interval) {
  const found = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true })).data[0];
  if (found) {
    console.log(`price ${lookupKey}`, found.id);
    return found;
  }
  const p = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: unitAmount, recurring: { interval }, lookup_key: lookupKey, tax_behavior: 'exclusive' });
  console.log(`created price ${lookupKey}`, p.id);
  return p;
}
const monthly = await price('nanana_pro_monthly', 800, 'month');
const yearly = await price('nanana_pro_yearly', 8000, 'year');

// webhook
const events = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];
const url = `${base}/billing/webhook`;
let hook = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === url);
let webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
if (!hook && !args.apply) {
  console.log('webhook endpoint: would create', url, '(the signing secret is shown only once, so this only happens with --apply)');
} else if (!hook) {
  hook = await stripe.webhookEndpoints.create({ url, enabled_events: events, description: 'nanana billing' });
  webhookSecret = hook.secret;
  console.log('created webhook endpoint', hook.id);
} else {
  await stripe.webhookEndpoints.update(hook.id, { enabled_events: events });
  console.log('webhook endpoint', hook.id, '(signing secret is only shown at creation; reusing the one in SSM if present)');
}

// customer portal
try {
  const configs = (await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })).data;
  const features = {
    customer_update: { enabled: true, allowed_updates: ['email', 'name', 'address', 'tax_id'] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'unused', 'other'] } },
    subscription_update: { enabled: true, default_allowed_updates: ['price'], products: [{ product: product.id, prices: [monthly.id, yearly.id] }] },
  };
  const businessProfile = { headline: 'Manage your nanana Pro subscription' };
  if (configs[0]) await stripe.billingPortal.configurations.update(configs[0].id, { features, business_profile: businessProfile });
  else await stripe.billingPortal.configurations.create({ features, business_profile: businessProfile });
  console.log('customer portal configured');
} catch (e) {
  console.log('could not configure the customer portal automatically:', e.message, '\n  (set it up once in the Stripe dashboard: Settings > Billing > Customer portal)');
}

const values = {
  STRIPE_SECRET_KEY: [key, 'SecureString'],
  STRIPE_PRICE_MONTHLY: [monthly.id, 'String'],
  STRIPE_PRICE_YEARLY: [yearly.id, 'String'],
  STRIPE_TAX: [args.tax ? 'true' : 'false', 'String'],
};

function ssmGet(name) {
  try {
    return execFileSync('aws', ['ssm', 'get-parameter', '--name', `/nanana/prod/${name}`, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

if (args.apply) {
  if (!webhookSecret) webhookSecret = ssmGet('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) {
    console.error('\nThe webhook endpoint already existed and no signing secret is stored. Reveal it in the Stripe dashboard (Developers > Webhooks > your endpoint > Signing secret) and re-run with STRIPE_WEBHOOK_SECRET=whsec_... in the environment.');
    process.exit(1);
  }
  values.STRIPE_WEBHOOK_SECRET = [webhookSecret, 'SecureString'];
  for (const [name, [value, type]] of Object.entries(values)) {
    execFileSync('aws', ['ssm', 'put-parameter', '--name', `/nanana/prod/${name}`, '--type', type, '--value', value, '--overwrite'], { stdio: 'ignore' });
    console.log(`wrote /nanana/prod/${name}`);
  }
  console.log('\nDone. Redeploy (push to main, or run the Deploy workflow) so the server picks up the new parameters. Billing turns on automatically.');
} else {
  console.log('\nValues (secrets masked). Re-run with --apply to store them in SSM:');
  for (const [name, [value, type]] of Object.entries(values)) console.log(`  ${name} = ${type === 'SecureString' ? value.slice(0, 10) + '...' : value}`);
  if (webhookSecret) console.log(`  STRIPE_WEBHOOK_SECRET = ${webhookSecret.slice(0, 10)}...`);
}
