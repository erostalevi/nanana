import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { buildPlansView, isRedirectUrl, nav, STATIC_PLANS_VIEW, type PlansView } from './billing';
import type { Billing, Interval, PlansResponse } from './types';

/**
 * GET /billing/plans with the static numbers as fallback. A 404 means the server has no billing yet
 * (shown as "coming soon"); any other failure keeps the buttons enabled and lets the click report the error.
 */
export function usePlans() {
  return useQuery<PlansView>({
    queryKey: ['billing-plans'],
    queryFn: async () => {
      try {
        return buildPlansView(await api<PlansResponse>('/billing/plans'), true);
      } catch (e) {
        return buildPlansView(null, !(e instanceof ApiError && e.status === 404));
      }
    },
    placeholderData: STATIC_PLANS_VIEW,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** GET /billing for the signed-in account. Resolves to null when unavailable (404, signed out). */
export function useBilling(enabled: boolean) {
  return useQuery<(Billing & { plan?: string }) | null>({
    queryKey: ['billing'],
    enabled,
    queryFn: async () => {
      try {
        return await api<Billing & { plan?: string }>('/billing');
      } catch (e) {
        if (e instanceof ApiError && [401, 404].includes(e.status)) return null;
        throw e;
      }
    },
    retry: false,
    staleTime: 30_000,
  });
}

function go(r: { url?: unknown }) {
  if (!isRedirectUrl(r?.url)) throw new ApiError(502, 'bad_redirect', 'The billing service returned an unexpected response.');
  nav.go(r.url);
}

/** POST /billing/checkout then redirect the browser to Stripe. The mutation stays "pending" after success. */
export function useCheckout() {
  return useMutation<{ url?: unknown }, unknown, Interval>({
    mutationFn: async (interval) => {
      const r = await api<{ url?: unknown }>('/billing/checkout', { method: 'POST', body: { interval } });
      go(r);
      return r;
    },
  });
}

/** POST /billing/portal then redirect. */
export function usePortal() {
  return useMutation<{ url?: unknown }, unknown, void>({
    mutationFn: async () => {
      const r = await api<{ url?: unknown }>('/billing/portal', { method: 'POST' });
      go(r);
      return r;
    },
  });
}
