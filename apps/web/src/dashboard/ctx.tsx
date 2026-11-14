import { createContext, useContext } from 'react';

export type DashCtx = {
  slug: string;
  /** subdomain token (nnt_...) if the dashboard was opened with one, else null (owner session) */
  token: string | null;
  base: string;
  apex: string;
};

export const DashContext = createContext<DashCtx | null>(null);

export function useDash(): DashCtx {
  const c = useContext(DashContext);
  if (!c) throw new Error('DashContext missing');
  return c;
}

/** The CLI command that connects a tunnel to this endpoint. */
export function tunnelCommand(ctx: Pick<DashCtx, 'slug' | 'token'>, port = 3000): string {
  return ctx.token ? `nanana -t=${ctx.token} -p=${port}` : `nanana tunnel ${ctx.slug} -p ${port}`;
}
