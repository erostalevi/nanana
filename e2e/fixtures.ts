import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { Stub } from './lib/stub';
import { FakeTunnel } from './lib/tunnel';
import { resetDb } from './lib/db';
import { createEndpoint, type Endpoint } from './lib/api';

type Fixtures = {
  /** Wipes the database before every test (auto). */
  cleanDb: void;
  /** Creates an anonymous endpoint through the API. */
  endpoint: Endpoint;
  stub: Stub;
  tunnels: { open: (e: Endpoint) => Promise<FakeTunnel> };
  api: APIRequestContext;
};

export const test = base.extend<Fixtures>({
  cleanDb: [
    async ({}, use) => {
      await resetDb();
      await use();
    },
    { auto: true },
  ],
  api: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext();
    await use(ctx);
    await ctx.dispose();
  },
  endpoint: async ({ api }, use) => {
    await use(await createEndpoint(api));
  },
  stub: async ({}, use) => {
    const s = await new Stub().start();
    await use(s);
    await s.stop();
  },
  tunnels: async ({}, use) => {
    const open: FakeTunnel[] = [];
    await use({
      open: async (e) => {
        const t = await new FakeTunnel(e.slug, e.token).connect();
        open.push(t);
        return t;
      },
    });
    await Promise.all(open.map((t) => t.close()));
  },
});

export { expect };

/** Opens the dashboard link (with #t=token) and waits until the live stream is connected. */
export async function openDashboard(page: Page, e: Endpoint): Promise<void> {
  await page.goto(e.link);
  await expect(page.getByRole('status', { name: 'Live stream open' })).toBeVisible();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A row in the request list. Its accessible name is built from its visible content ("POST /path 200 ..."),
 * so match the start of it.
 */
export const requestRow = (page: Page, method: string, path: string) => page.getByRole('button', { name: new RegExp(`^${escapeRe(method)}\\s*${escapeRe(path)}(?:\\s|$)`) });
