import { Injectable } from '@nestjs/common';
import type { HeaderMap } from '../common/http.js';

export interface ForwardRequest {
  id: string;
  method: string;
  path: string;
  headers: HeaderMap;
  body: Buffer;
  replay: boolean;
}
export interface ForwardResponse {
  status: number;
  headers: HeaderMap;
  body: Buffer;
}
export class TunnelError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

@Injectable()
export class TunnelService {
  isOnline(_subId: string): boolean {
    return false;
  }
  target(_subId: string): string | null {
    return null;
  }
  forward(_subId: string, _req: ForwardRequest): Promise<ForwardResponse> {
    return Promise.reject(new TunnelError('OFFLINE', 'tunnel offline'));
  }
  close(_subId: string, _reason: string): void {
    /* implemented in M2 */
  }
}
