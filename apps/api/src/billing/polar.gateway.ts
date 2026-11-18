import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/** The subset of a Polar subscription the plan state machine reads. */
export interface PolarSubscription {
  id: string;
  status: string; // incomplete | incomplete_expired | trialing | active | past_due | canceled | unpaid | paused
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  recurring_interval?: string; // month | year
  customer_id: string;
  customer?: { id?: string; external_id?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

export interface PolarEvent {
  /** Polar's `webhook-id` header: unique per delivery, stable across retries. */
  id: string;
  type: string;
  data: unknown;
}

const TOLERANCE_SECONDS = 300;

/**
 * Thin wrapper over the Polar REST API (https://polar.sh/docs/api-reference) and its Standard Webhooks signatures,
 * so tests can replace the network calls. Plain fetch: no SDK.
 */
@Injectable()
export class PolarGateway {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  get enabled(): boolean {
    return !!(this.cfg.polarAccessToken && this.cfg.polarProductMonthly && this.cfg.polarProductYearly);
  }

  private get base(): string {
    return this.cfg.polarServer === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.polarAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Polar ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** Verifies a Standard Webhooks signature over the raw body and returns the event. Throws if invalid. */
  verifyEvent(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PolarEvent {
    const secret = this.cfg.polarWebhookSecret;
    const one = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const id = one('webhook-id');
    const ts = one('webhook-timestamp');
    const sigs = one('webhook-signature');
    if (!secret || !id || !ts || !sigs) throw new Error('missing signature headers');
    const t = Number(ts);
    if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) throw new Error('timestamp out of tolerance');
    const signed = Buffer.concat([Buffer.from(`${id}.${Math.floor(t)}.`), rawBody]);
    // Polar signs with the secret's UTF-8 bytes; the Standard Webhooks default is the base64-decoded bytes. Accept either.
    const keys = [Buffer.from(secret, 'utf8')];
    const decoded = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    if (decoded.length && !decoded.equals(keys[0])) keys.push(decoded);
    const ok = sigs.split(' ').some((part) => {
      const [version, sig] = part.split(',', 2);
      if (version !== 'v1' || !sig) return false;
      const given = Buffer.from(sig, 'base64');
      return keys.some((k) => {
        const expected = createHmac('sha256', k).update(signed).digest();
        return given.length === expected.length && timingSafeEqual(given, expected);
      });
    });
    if (!ok) throw new Error('signature mismatch');
    const parsed = JSON.parse(rawBody.toString('utf8')) as { type?: string; data?: unknown };
    if (typeof parsed.type !== 'string') throw new Error('no event type');
    return { id, type: parsed.type, data: parsed.data };
  }

  /** Creates a hosted checkout. The account id doubles as Polar's external customer id, so webhooks map back to us. */
  async createCheckoutUrl(args: { productId: string; accountId: string; email: string }): Promise<string> {
    const c = await this.call<{ url?: string }>('/v1/checkouts/', {
      products: [args.productId],
      external_customer_id: args.accountId,
      customer_email: args.email,
      success_url: `${this.cfg.webOrigin}/account?billing=success`,
      return_url: `${this.cfg.webOrigin}/account?billing=cancelled`,
      allow_discount_codes: true,
      currency: 'usd', // prices are USD only; never let the checkout pick another presentment currency
      metadata: { accountId: args.accountId },
    });
    if (!c.url) throw new Error('Polar returned no checkout url');
    return c.url;
  }

  async createPortalUrl(accountId: string): Promise<string> {
    const s = await this.call<{ customer_portal_url?: string }>('/v1/customer-sessions/', {
      external_customer_id: accountId,
      return_url: `${this.cfg.webOrigin}/account`,
    });
    if (!s.customer_portal_url) throw new Error('Polar returned no portal url');
    return s.customer_portal_url;
  }
}
