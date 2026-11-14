import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api';
import type { MeResponse } from './types';

/** GET /me. 401 resolves to null (signed out). Other failures surface as errors. */
export function useMe() {
  return useQuery<MeResponse | null, ApiError>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<MeResponse>('/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}
