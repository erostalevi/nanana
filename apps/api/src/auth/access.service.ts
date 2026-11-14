import { Inject, Injectable, Optional } from '@nestjs/common';
import { q } from '../db/query.js';
import type { Request } from 'express';
import { forbidden, notFound, unauthorized } from '../common/errors.js';
import { sha256 } from '../common/crypto.js';
import { SubdomainsService, type SubRow } from '../subdomains/subdomains.service.js';

export interface AccountPrincipal {
  kind: 'account';
  accountId: string;
  email: string;
  plan: string;
  displayName: string | null;
}
export interface SubPrincipal {
  kind: 'sub';
  subId: string;
}
export type Principal = AccountPrincipal | SubPrincipal | { kind: 'none' };

/** Implemented by the accounts module (sessions, nna_ tokens). */
export const ACCOUNT_RESOLVER = Symbol('ACCOUNT_RESOLVER');
export interface AccountResolver {
  resolve(req: Request): Promise<AccountPrincipal | null>;
}

export function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

@Injectable()
export class AccessService {
  constructor(
    @Inject(SubdomainsService) private readonly subs: SubdomainsService,
    @Optional() @Inject(ACCOUNT_RESOLVER) private readonly accounts?: AccountResolver,
  ) {}

  async principal(req: Request): Promise<Principal> {
    const token = bearer(req);
    if (token?.startsWith('nnt_')) {
      const row = await this.subs.getByTokenHash(sha256(token));
      return row ? { kind: 'sub', subId: row.id } : { kind: 'none' };
    }
    const acct = await this.accounts?.resolve(req);
    return acct ?? { kind: 'none' };
  }

  async requireAccount(req: Request): Promise<AccountPrincipal> {
    const p = await this.principal(req);
    if (p.kind !== 'account') throw unauthorized();
    return p;
  }

  /** Authorizes access to a subdomain by slug via its nnt_ token or its owner account. */
  async authorizeSub(req: Request, slug: string): Promise<SubRow> {
    const row = await this.subs.getBySlug(slug);
    const p = await this.principal(req);
    if (p.kind === 'none') throw unauthorized();
    if (!row) throw notFound('subdomain');
    if (p.kind === 'sub' ? p.subId !== row.id : row.owner_id !== p.accountId) {
      if (p.kind === 'sub') throw forbidden();
      throw notFound('subdomain');
    }
    return row;
  }

  /** Same as authorizeSub but resolves the subdomain from a capture id. */
  async authorizeSubById(req: Request, subId: string): Promise<SubRow> {
    const p = await this.principal(req);
    if (p.kind === 'none') throw unauthorized();
    const rows = await q<SubRow[]>(this.subs['ds'], 'SELECT * FROM subdomain WHERE id = $1', [subId]);
    const row = rows[0];
    if (!row) throw notFound('subdomain');
    if (p.kind === 'sub' ? p.subId !== row.id : row.owner_id !== p.accountId) {
      if (p.kind === 'sub') throw forbidden();
      throw notFound('request');
    }
    return row;
  }
}
