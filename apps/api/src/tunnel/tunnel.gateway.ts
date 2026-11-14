import { Injectable } from '@nestjs/common';
import type { Server } from 'node:http';

/** Replaced in M2 with the real WebSocket gateway. */
@Injectable()
export class TunnelGateway {
  attach(_server: Server): void {
    /* M2 */
  }
}
