import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { randomBase62 } from '../common/crypto.js';
import { AccountsService, type AccountRow } from './accounts.service.js';

export type OAuthProvider = 'github' | 'google';

interface ProviderCfg {
  authorize: string;
  token: string;
  scope: string;
}

const PROVIDERS: Record<OAuthProvider, ProviderCfg> = {
  github: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'read:user user:email' },
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email profile' },
};

@Injectable()
export class OAuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  enabled(p: OAuthProvider): boolean {
    return p === 'github' ? this.cfg.authGithub && !!this.cfg.githubClientId : this.cfg.authGoogle && !!this.cfg.googleClientId;
  }

  private ids(p: OAuthProvider) {
    return p === 'github' ? { id: this.cfg.githubClientId, secret: this.cfg.githubClientSecret } : { id: this.cfg.googleClientId, secret: this.cfg.googleClientSecret };
  }

  redirectUri(p: OAuthProvider): string {
    return `${this.cfg.publicApiUrl}/auth/${p}/callback`;
  }

  begin(p: OAuthProvider): { url: string; state: string } {
    const state = randomBase62(32);
    const params = new URLSearchParams({
      client_id: this.ids(p).id,
      redirect_uri: this.redirectUri(p),
      scope: PROVIDERS[p].scope,
      state,
      ...(p === 'google' ? { response_type: 'code', prompt: 'select_account' } : {}),
    });
    return { url: `${PROVIDERS[p].authorize}?${params}`, state };
  }

  async complete(p: OAuthProvider, code: string): Promise<AccountRow> {
    const { id, secret } = this.ids(p);
    const body = new URLSearchParams({ client_id: id, client_secret: secret, code, redirect_uri: this.redirectUri(p), ...(p === 'google' ? { grant_type: 'authorization_code' } : {}) });
    const tokRes = await fetch(PROVIDERS[p].token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const tok = (await tokRes.json()) as { access_token?: string };
    if (!tokRes.ok || !tok.access_token) throw new ApiError(400, 'oauth_failed', 'Could not complete sign-in with the provider');
    const auth = { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json', 'User-Agent': 'nanana-lat' };

    if (p === 'github') {
      const user = (await (await fetch('https://api.github.com/user', { headers: auth })).json()) as { id?: number; login?: string; name?: string };
      const emails = (await (await fetch('https://api.github.com/user/emails', { headers: auth })).json()) as { email: string; primary: boolean; verified: boolean }[];
      const email = Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified))?.email : undefined;
      if (!user.id || !email) throw new ApiError(400, 'oauth_no_email', 'Your GitHub account has no verified email');
      return this.accounts.findOrCreate('github', String(user.id), email, user.name ?? user.login);
    }
    const info = (await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: auth })).json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!info.sub || !info.email || !info.email_verified) throw new ApiError(400, 'oauth_no_email', 'Your Google account has no verified email');
    return this.accounts.findOrCreate('google', info.sub, info.email, info.name);
  }
}
