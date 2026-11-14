import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/** Thin wrapper over the Stripe SDK so tests can replace the network calls. */
@Injectable()
export class StripeGateway {
  private client?: Stripe;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  get enabled(): boolean {
    return !!(this.cfg.stripeSecretKey && this.cfg.stripePriceMonthly && this.cfg.stripePriceYearly);
  }

  private stripe(): Stripe {
    this.client ??= new Stripe(this.cfg.stripeSecretKey || 'sk_test_unconfigured');
    return this.client;
  }

  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe().webhooks.constructEvent(rawBody, signature, this.cfg.stripeWebhookSecret);
  }

  async createCustomer(email: string, accountId: string): Promise<string> {
    const c = await this.stripe().customers.create({ email, metadata: { accountId } });
    return c.id;
  }

  async createCheckoutUrl(args: { customer: string; priceId: string; accountId: string }): Promise<string> {
    const s = await this.stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: args.customer,
      client_reference_id: args.accountId,
      line_items: [{ price: args.priceId, quantity: 1 }],
      subscription_data: { metadata: { accountId: args.accountId } },
      allow_promotion_codes: true,
      success_url: `${this.cfg.webOrigin}/account?billing=success`,
      cancel_url: `${this.cfg.webOrigin}/account?billing=cancelled`,
      ...(this.cfg.stripeTax ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto' as const, name: 'auto' as const } } : {}),
    });
    if (!s.url) throw new Error('Stripe returned no checkout url');
    return s.url;
  }

  async createPortalUrl(customer: string): Promise<string> {
    const s = await this.stripe().billingPortal.sessions.create({ customer, return_url: `${this.cfg.webOrigin}/account` });
    return s.url;
  }

  async retrieveSubscription(id: string): Promise<Stripe.Subscription> {
    return this.stripe().subscriptions.retrieve(id);
  }
}
