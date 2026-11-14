// Types mirror docs/API.md (v1 contract).
export type Headers = Record<string, string | string[]>;

export type Subdomain = {
  slug: string;
  url: string;
  dashboardUrl: string;
  isCustom: boolean;
  ownerId: string | null;
  state: 'active' | 'cold';
  lastActivityAt: string;
  hardExpiresAt: string;
  offlineStatus: number;
  offlineBody: string;
  hmac: { header: string; algo: 'sha256' | 'sha1' | 'sha512'; configured: boolean } | null;
  tunnelOnline: boolean;
  mock: { status: number; remaining: number } | null;
};

export type Signature = 'pass' | 'fail' | 'header_missing' | 'not_configured';
export type AnsweredBy = 'tunnel' | 'mock' | 'offline' | 'preflight';

export type RequestSummary = {
  id: string;
  method: string;
  path: string;
  receivedAt: string;
  bodySize: number;
  contentType: string | null;
  sourceIp: string;
  answeredBy: AnsweredBy;
  responseStatus: number | null;
  latencyMs: number | null;
  isPreflight: boolean;
  mocked: boolean;
  forwardError: string | null;
  signature: Signature;
  bodyPreview: string;
};

export type Body = { encoding: 'utf8' | 'base64'; data: string; truncated?: boolean };

export type Replay = {
  id: string;
  requestId: string;
  targetType: 'tunnel' | 'url';
  targetUrl: string | null;
  status: number | null;
  responseHeaders: Headers | null;
  responseBody: Body | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
};

export type RequestDetail = RequestSummary & {
  headers: Headers;
  body: Body;
  responseHeaders: Headers | null;
  responseBody: Body | null;
  signatureDetail: { state: Signature; header: string | null; received: string | null; expected: string | null };
  replays: Replay[];
};

export type Account = { id: string; email: string; displayName: string | null; plan: string };
export type MeResponse = {
  account: Account;
  limits: Record<string, number | string | boolean | null>;
  providers: { github: boolean; google: boolean; magic: true };
};
export type Providers = { github: boolean; google: boolean; magic: true };
export type CliToken = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

export type AdminStats = {
  accounts: number;
  subdomains: { total: number; active: number; cold: number; anonymous: number; custom: number };
  tunnelsOnline: number;
  capturedRequests: number;
  requestsLastHour: number;
  uptimeSeconds: number;
  version: string;
};

export type CreatedSubdomain = { subdomain: Subdomain; token: string; dashboardUrlWithToken: string };

export type StreamEvent =
  | { type: 'hello'; data: Subdomain }
  | { type: 'request.created'; data: RequestSummary }
  | { type: 'request.updated'; data: RequestSummary }
  | { type: 'request.deleted'; data: { id: string } }
  | { type: 'tunnel.status'; data: { online: boolean; target: string | null } }
  | { type: 'mock.updated'; data: { status: number; remaining: number } | null }
  | { type: 'subdomain.state'; data: { state: 'active' | 'cold'; hardExpiresAt: string } }
  | { type: 'subdomain.deleted'; data: Record<string, never> };
