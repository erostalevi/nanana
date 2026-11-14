import type { ReactNode } from 'react';

/*
 * Drafted for the owner to review. Plain-language summary of the service rules; NOT legal advice and
 * not reviewed by a lawyer. Last updated 2026-11-14.
 */
export const LEGAL_UPDATED = '2026-11-14';

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-faint">Last updated {LEGAL_UPDATED}</p>
      <div className="prose-doc mt-6">{children}</div>
    </div>
  );
}

export function Terms() {
  return (
    <LegalPage title="Terms of Service">
      <p>nanana.lat ("nanana", "the service") is a webhook inspector, replayer and tunnel run by an individual based in Chile. By using the website, the API or the CLI you agree to these terms. If you do not agree, please do not use the service.</p>
      <h2>What the service is</h2>
      <p>The service gives you temporary public URLs that capture the HTTP requests sent to them, show them to you, let you replay them, and optionally forward them to your own machine through a tunnel. It is a developer tool for testing and debugging, provided as is and without any guarantee of availability.</p>
      <h2>Acceptable use</h2>
      <ul>
        <li>Use it only for lawful testing and development of software.</li>
        <li>Do not use endpoints to host or relay phishing pages, malware, spam, harassment or any illegal content, and do not use the service to attack other systems (including through replay).</li>
        <li>Do not send data you are not allowed to process, such as production secrets, payment card numbers or other people's personal data. Requests are stored exactly as received, without masking.</li>
        <li>Do not resell the service, or its endpoints, or use it as the public front of a production service.</li>
        <li>Do not try to evade rate limits, lifetimes or other limits, or to probe other users' endpoints.</li>
      </ul>
      <h2>Ephemeral by design</h2>
      <p>Endpoints expire. They go cold after 1 hour without activity, are deleted after 24 hours without activity, and free endpoints are deleted at most 7 days after creation. Captured requests are kept for at most 1 hour (and at most 100 requests or 50 MB per endpoint). Do not rely on the service to keep anything. Limits can change.</p>
      <h2>Accounts and tokens</h2>
      <p>Anyone holding an endpoint's token or dashboard link can view and manage that endpoint, so keep them private. You are responsible for activity under your account and tokens. You may delete your account at any time from the account page.</p>
      <h2>Removal and suspension</h2>
      <p>I may disable endpoints or accounts, and remove content, at any time and without notice, in particular to deal with abuse. See the <a href="/abuse">abuse policy</a>.</p>
      <h2>No warranty and limited liability</h2>
      <p>The service is provided "as is". To the extent the law allows, I am not liable for lost data, lost webhooks, downtime, or indirect damages arising from your use of the service. Nothing in these terms limits rights you have under mandatory law, including Chilean consumer protection law where it applies.</p>
      <h2>Changes</h2>
      <p>I may update these terms; the date above shows the latest version. Continued use means you accept the update.</p>
      <h2>Governing law and contact</h2>
      <p>These terms are governed by the laws of Chile, and disputes belong to the competent courts of Chile, subject to any mandatory rules that apply to you. Questions: <a href="mailto:support@nanana.lat">support@nanana.lat</a>.</p>
    </LegalPage>
  );
}

export function Privacy() {
  return (
    <LegalPage title="Privacy">
      <p>This page explains in plain language what nanana.lat stores about you and the traffic you send through it. The service is operated by an individual in Chile.</p>
      <h2>Webhook data (captured requests)</h2>
      <ul>
        <li>For every request sent to an endpoint we store the method, path and query, headers, body, the sender's IP address, timestamps, and the response that was returned. Replays and mock rules are stored with the endpoint.</li>
        <li>This data is deleted within 1 hour of capture, and always together with the endpoint, which is deleted within 24 hours of its last activity (7 days at most).</li>
        <li>Captured requests live in database tables that are excluded from backups and replicas, so they are not copied anywhere else. They may be lost if the database crashes.</li>
        <li>Payloads are shown to you exactly as received. We never render them as web pages, and we do not log bodies.</li>
        <li>Anyone can send data to a public endpoint URL. Only holders of the token (or the signed-in owner) can read captures.</li>
      </ul>
      <h2>Account data</h2>
      <p>If you create an account we store your email address, display name (if your sign-in provider gives one), the sign-in method used, session records, CLI tokens (stored as hashes) and the endpoints you own. Magic-link and device codes are stored as hashes and expire in minutes. Deleting your account removes all of this immediately.</p>
      <h2>Technical data</h2>
      <p>To limit abuse we keep a keyed hash of the IP address that created an endpoint, and in-memory rate limit counters. Server logs record operational metadata (path, status, timing) but never request bodies. The website uses no analytics, no advertising trackers and no third-party cookies. A single first-party session cookie is set only if you sign in; your theme choice is kept in your browser's local storage, and an endpoint token is kept in session storage for that tab only.</p>
      <h2>Who processes data</h2>
      <p>The service runs on Amazon Web Services (region us-east-1, United States). Transactional email for sign-in links is sent through Amazon SES. Sign-in with GitHub or Google, when enabled, shares your email with us under their terms. We do not sell data and do not share it with anyone else, except where the law requires it.</p>
      <h2>Your rights</h2>
      <p>You can delete your account yourself on the <a href="/account">account page</a>. For access, correction or any other request under Chilean data protection law, write to <a href="mailto:support@nanana.lat">support@nanana.lat</a>.</p>
      <h2>Changes</h2>
      <p>If this notice changes, the date above changes. Governing law is that of Chile.</p>
    </LegalPage>
  );
}

export function Abuse() {
  return (
    <LegalPage title="Abuse and takedown">
      <p>nanana endpoints are public URLs that anyone can send to, and that anyone with the right token can read. That makes them attractive for misuse, so we take abuse reports seriously.</p>
      <h2>What counts as abuse</h2>
      <ul>
        <li>Phishing, fraud or impersonation using an endpoint (including deliberately crafted offline responses).</li>
        <li>Malware delivery or command-and-control traffic.</li>
        <li>Spam, harassment, or content that is illegal in Chile or in the reporter's country.</li>
        <li>Attacks on third parties, including abusing replay or the tunnel to reach systems you do not own.</li>
        <li>Attempts to defeat limits, enumerate other people's endpoints, or access data that is not yours.</li>
      </ul>
      <h2>How to report</h2>
      <p>Email <a href="mailto:abuse@nanana.lat">abuse@nanana.lat</a> with the endpoint URL (for example <code>https://abcd1234.nanana.lat</code>), a description of the problem and, if possible, evidence such as a screenshot or the request that shows it. Reports are read by a person; for urgent security issues put "URGENT" in the subject. For anything else write to <a href="mailto:support@nanana.lat">support@nanana.lat</a>.</p>
      <h2>What happens next</h2>
      <ol>
        <li>I review the report and, if it is plausible, disable the endpoint right away. The endpoint and its captured data are then deleted.</li>
        <li>Repeat or serious abuse leads to the account being disabled and the sending address being blocked.</li>
        <li>Where required by law, or to stop serious harm, I may share relevant information with the competent authorities.</li>
        <li>If you think an endpoint was disabled by mistake, write to <a href="mailto:support@nanana.lat">support@nanana.lat</a>.</li>
      </ol>
      <p>Because endpoints are ephemeral (24 hours idle, 7 days at most) and we keep no long-term copy of captured payloads, evidence may disappear quickly. Please report promptly and keep your own copy.</p>
    </LegalPage>
  );
}
