#!/usr/bin/env node
// One-shot Polar setup for nanana. Idempotent: safe to run again. No dependencies (plain fetch).
//
//   POLAR_ACCESS_TOKEN=polar_oat_xxx node tools/polar/setup.mjs            # check products + webhook, print what it would store
//   POLAR_ACCESS_TOKEN=polar_oat_xxx node tools/polar/setup.mjs --apply    # ...and write the values to SSM (/nanana/prod/*) with your AWS creds
//   add --sandbox when the token is a sandbox token (also stores POLAR_SERVER=sandbox)
//
// Expects two public recurring products named "nanana Pro (monthly)" ($8.00 USD) and "nanana Pro (yearly)" ($80.00 USD);
// it creates them if they do not exist, and fails loudly if they exist with a different USD price.
// It also makes sure the webhook endpoint https://api.nanana.lat/billing/webhook exists for the subscription events the API handles.
// With --apply it stores POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET, POLAR_PRODUCT_MONTHLY, POLAR_PRODUCT_YEARLY and POLAR_SERVER in SSM;
// the next deploy (or deploy.sh) renders them into the server's .env and billing turns on.
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : [])).filter((x) => x.length),
);
const token = process.env.POLAR_ACCESS_TOKEN || args.token;
if (!token || !token.startsWith('polar_')) {
  console.error('Set POLAR_ACCESS_TOKEN to your Polar organization access token (polar_oat_...).');
  process.exit(1);
}
const sandbox = !!args.sandbox;
const api = sandbox ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
const hookUrl = `${args.base || 'https://api.nanana.lat'}/billing/webhook`;
const EVENTS = ['subscription.created', 'subscription.active', 'subscription.updated', 'subscription.canceled', 'subscription.uncanceled', 'subscription.revoked', 'subscription.past_due'];

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

console.log(`Polar ${sandbox ? 'SANDBOX' : 'PRODUCTION'}`);
const org = (await call('GET', '/v1/organizations/?limit=1')).items?.[0];
if (!org) throw new Error('This token cannot see an organization.');
console.log(`organization ${org.slug} (${org.id}), status: ${org.status}`);

const products = (await call('GET', '/v1/products/?limit=100&is_archived=false')).items;
async function product(name, usdCents, interval) {
  const found = products.find((p) => p.name === name);
  if (found) {
    const usd = found.prices.find((p) => p.price_currency === 'usd' && !p.is_archived);
    if (found.recurring_interval !== interval || usd?.price_amount !== usdCents) {
      throw new Error(`Product "${name}" exists but is ${found.recurring_interval}/${usd?.price_amount} USD cents; expected ${interval}/${usdCents}. Fix it in the Polar dashboard.`);
    }
    const stray = found.prices.filter((p) => p.price_currency !== 'usd' && !p.is_archived);
    for (const p of stray) console.log(`  WARNING: "${name}" also has a ${p.price_currency.toUpperCase()} price of ${p.price_amount}. Checkout is forced to USD, but remove it in the dashboard.`);
    console.log(`product "${name}"`, found.id);
    return found.id;
  }
  const created = await call('POST', '/v1/products/', {
    name,
    description: 'Always-on endpoints, reserved names, longer request history, bigger payloads and more tunnels.',
    recurring_interval: interval,
    prices: [{ amount_type: 'fixed', price_currency: 'usd', price_amount: usdCents }],
    visibility: 'public',
  });
  console.log(`created product "${name}"`, created.id);
  return created.id;
}
const monthly = await product('nanana Pro (monthly)', 800, 'month');
const yearly = await product('nanana Pro (yearly)', 8000, 'year');

// webhook endpoint (its signing secret is returned by the API, so re-runs can read it back)
const endpoints = (await call('GET', '/v1/webhooks/endpoints?limit=100')).items;
let hook = endpoints.find((e) => e.url === hookUrl);
if (!hook && !args.apply) {
  console.log('webhook endpoint: would create', hookUrl);
} else if (!hook) {
  hook = await call('POST', '/v1/webhooks/endpoints', { url: hookUrl, format: 'raw', events: EVENTS, organization_id: org.id });
  console.log('created webhook endpoint', hook.id);
} else {
  const missing = EVENTS.filter((e) => !hook.events.includes(e));
  if (missing.length) {
    hook = await call('PATCH', `/v1/webhooks/endpoints/${hook.id}`, { events: [...new Set([...hook.events, ...EVENTS])] });
    console.log('webhook endpoint', hook.id, 'updated with events:', missing.join(', '));
  } else console.log('webhook endpoint', hook.id);
}

const values = {
  POLAR_ACCESS_TOKEN: [token, 'SecureString'],
  POLAR_PRODUCT_MONTHLY: [monthly, 'String'],
  POLAR_PRODUCT_YEARLY: [yearly, 'String'],
  POLAR_SERVER: [sandbox ? 'sandbox' : 'production', 'String'],
};
if (hook?.secret) values.POLAR_WEBHOOK_SECRET = [hook.secret, 'SecureString'];

if (args.apply) {
  if (!values.POLAR_WEBHOOK_SECRET) throw new Error('No webhook signing secret available.');
  for (const [name, [value, type]] of Object.entries(values)) {
    execFileSync('aws', ['ssm', 'put-parameter', '--name', `/nanana/prod/${name}`, '--type', type, '--value', value, '--overwrite'], { stdio: 'ignore' });
    console.log(`wrote /nanana/prod/${name}`);
  }
  console.log('\nDone. Redeploy (push to main, or run the Deploy workflow) so the server picks up the new parameters. Billing turns on automatically.');
} else {
  console.log('\nValues (secrets masked). Re-run with --apply to store them in SSM:');
  for (const [name, [value, type]] of Object.entries(values)) console.log(`  ${name} = ${type === 'SecureString' ? value.slice(0, 10) + '...' : value}`);
}
