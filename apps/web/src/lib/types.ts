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
  /** Pro: no idle death and no 7-day cap. Optional so older API versions degrade gracefully. */
  alwaysOn?: boolean;
  /** Owner's Pro plan lapsed: ingress answers 402 and stores nothing. */
  readOnly?: boolean;
  /** Custom name kept reserved while the owner is on Pro. */
  reserved?: boolean;
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

export type PlanId = 'free' | 'pro' | 'pro_grace' | 'lapsed';
export type Interval = 'month' | 'year';

export type Limits = {
  maxActiveSubdomains: number;
  maxCustomNames: number;
  maxBodyBytes: number;
  ratePerMinute: number;
  retentionMaxRequests: number;
  retentionMaxAgeMs: number;
  retentionMaxBytes: number;
  tunnelsPerAccount: number;
  alwaysOn: boolean;
  reservedNames: boolean;
};

export type Billing = {
  enabled: boolean;
  status: 'none' | 'active' | 'past_due' | 'canceled';
  interval: Interval | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: string | null;
  lapsedUntil: string | null;
};

export type PlanInfo = { id: 'free' | 'pro'; name: string; priceMonthlyCents: number; priceYearlyCents: number | null; limits: Limits };
export type PlansResponse = { enabled: boolean; currency: 'usd'; plans: PlanInfo[] };

export type Account = { id: string; email: string; displayName: string | null; plan: string };
export type MeResponse = {
  account: Account;
  limits: Partial<Limits>;
  /** Absent on API versions without billing. */
  billing?: Billing;
  providers: { github: boolean; google: boolean; magic: true };
};
export type Providers = { github: boolean; google: boolean; magic: true };
export type CliToken = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

export type AdminMinute = { minute: number; captured: number; rejected: number; shed: number; tunneled: number; avgLatencyMs: number; maxLatencyMs: number };
export type AdminStats = {
  accounts: number;
  subdomains: { total: number; active: number; cold: number; anonymous: number; custom: number };
  tunnelsOnline: number;
  capturedRequests: number;
  requestsLastHour: number;
  uptimeSeconds: number;
  version: string;
  generatedAt: string;
  traffic: {
    since: string;
    series: AdminMinute[];
    perMinuteNow: number;
    lastFiveMinutes: number;
    lastHour: number;
    rejectedLastHour: number;
    shedLastHour: number;
    tunneledLastHour: number;
    avgLatencyMs: number;
    topEndpoints: { slug: string; requests: number }[];
  };
  growth: { signups24h: number; signups7d: number; endpointsCreated24h: number; plans: Record<string, number> };
  revenue: {
    currency: string;
    mrrCents: number;
    arrCents: number;
    payingSubscribers: number;
    monthly: number;
    yearly: number;
    pastDue: number;
    cancelingAtPeriodEnd: number;
    billingEnabled: boolean;
  };
  health: {
    cpus: number;
    load1: number;
    loadPct: number;
    memAvailableMb: number;
    memTotalMb: number;
    apiRssMb: number;
    apiHeapMb: number;
    eventLoopP99Ms: number;
    eventLoopMaxMs: number;
    db: { pingMs: number; sizeMb: number; capturesMb: number; connections: number; volumeMb: number };
  };
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
