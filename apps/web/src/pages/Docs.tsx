import { Link } from 'react-router-dom';
import { CodeBlock } from '../components/ui';

const TOC = [
  ['quickstart', 'Quick start'],
  ['cli', 'CLI install and commands'],
  ['tunnel', 'How the tunnel works'],
  ['hmac', 'HMAC signature check'],
  ['mocking', 'Response mocking'],
  ['replay', 'Replay'],
  ['limits', 'Limits and lifecycle'],
  ['recipes', 'Provider recipes'],
  ['accounts', 'Accounts'],
];

export function Docs() {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 lg:grid-cols-[14rem_1fr]">
      <nav aria-label="On this page" className="hidden lg:block">
        <ul className="sticky top-20 space-y-2 text-sm">
          {TOC.map(([id, label]) => <li key={id}><a href={`#${id}`} className="text-muted hover:text-fg">{label}</a></li>)}
        </ul>
      </nav>
      <article className="prose-doc min-w-0 max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight">Docs</h1>
        <p>nanana gives you throwaway public URLs that capture any HTTP request, show it live, and (optionally) forward it to your machine.</p>

        <h2 id="quickstart">Quick start</h2>
        <ol>
          <li>Press <strong>Create an endpoint</strong> on the <Link to="/">home page</Link>. You get a URL such as <code>https://k7x2m9qa.nanana.lat</code>, a token (<code>nnt_...</code>) and a dashboard link.</li>
          <li>Send something to it. Every method and path works:</li>
        </ol>
        <CodeBlock code={`curl -X POST https://k7x2m9qa.nanana.lat/test -H 'content-type: application/json' -d '{"hello":"nanana"}'`} />
        <ol start={3}>
          <li>Open the dashboard link. The request is already there. The fragment (<code>#t=...</code>) holds your token; the page moves it into session storage and removes it from the address bar. It is never sent to any server.</li>
        </ol>
        <p>With no tunnel connected, senders get the <em>offline response</em> (status 200 and <code>{'{"ok":true}'}</code> by default). You can change both in Settings, for example to <code>503</code> to make a sender retry.</p>

        <h2 id="cli">CLI install and commands</h2>
        <CodeBlock label="Install (macOS, Linux)" code="curl -fsSL https://nanana.lat/install.sh | sh" />
        <p>The <code>nanana</code> binary is a single static executable for macOS, Linux and Windows (amd64 and arm64).</p>
        <CodeBlock label="Tunnel to localhost" code={`nanana -t=nnt_yourtoken -p=3000\nnanana -t=nnt_yourtoken -p=8080 -h=192.168.1.20   # another host on your network`} />
        <ul>
          <li><code>-t</code> subdomain token (or set <code>NANANA_TOKEN</code>), <code>-p</code> target port (required), <code>-h</code> target host (default <code>127.0.0.1</code>; use <code>--help</code> for help).</li>
          <li><code>nanana tunnel -t TOKEN -p 3000 [--scheme http|https] [--preserve-host] [--no-tail]</code> is the long form.</li>
          <li><code>nanana login</code> / <code>logout</code> / <code>whoami</code>: sign in through your browser (device code flow, see <Link to="/device">/device</Link>).</li>
          <li><code>nanana list</code>, <code>create [name]</code>, <code>delete SLUG</code>, <code>claim -t TOKEN</code> manage the endpoints of your account.</li>
          <li><code>nanana tunnel SLUG -p 3000</code> when logged in: no token needed for endpoints you own.</li>
        </ul>
        <p>The CLI prints one line per request with status, latency and signature result, and reconnects automatically with backoff.</p>

        <h2 id="tunnel">How the tunnel works</h2>
        <p>The CLI opens one outbound WebSocket to <code>api.nanana.lat</code>; nothing needs to be opened on your router. When a webhook arrives, nanana stores it, pushes it down the socket, your CLI calls your local app, and the <strong>real response</strong> (status, headers, body) goes back to the sender.</p>
        <ul>
          <li>HTTP and HTTPS targets only. The CLI sets <code>Host</code> to the local target unless you pass <code>--preserve-host</code>, and adds <code>X-Forwarded-For/Proto/Host</code>.</li>
          <li>Your app has 25 seconds to answer. On timeout, refusal or a dropped tunnel, the sender gets the offline response and the capture is marked with the error.</li>
          <li>One live tunnel per endpoint: a new connection replaces the old one. At most 20 requests are in flight at once.</li>
          <li>Replays marked from the dashboard are tagged <code>[replay]</code> in the CLI.</li>
        </ul>

        <h2 id="hmac">HMAC signature check</h2>
        <p>In <strong>Settings</strong>, enter the header that carries the signature, the algorithm (sha256, sha1 or sha512) and the shared secret. nanana computes the HMAC of the <strong>raw body</strong> and compares in constant time. It accepts plain hex, <code>sha256=&lt;hex&gt;</code>, base64 and Stripe-style <code>t=...,v1=...</code> (which signs <code>t.body</code>).</p>
        <p>Each request shows a dot: green pass, red fail, amber header missing. The Signature tab shows received vs expected. Changing the secret re-evaluates existing captures. The secret is encrypted at rest and never shown again after saving.</p>

        <h2 id="mocking">Response mocking</h2>
        <p>Open <strong>Mock</strong> to answer the next N requests (1 to 50) with a status, headers and body of your choice. Mocked requests are captured but not forwarded; when the count runs out, normal behavior resumes. The remaining count updates live. A classic use: answer <code>500</code> twice, then let the sender's retry reach your real handler to test idempotency.</p>

        <h2 id="replay">Replay</h2>
        <p>Pick a captured request and press <strong>Replay</strong>:</p>
        <ul>
          <li><strong>My tunnel</strong>: sends the original method, path, headers and raw body through the connected CLI, so it reaches <code>localhost</code> and LAN hosts. Disabled while no tunnel is connected.</li>
          <li><strong>Public URL</strong>: nanana sends it from the server to any public http(s) host. Private, loopback and link-local addresses are blocked, redirects are not followed, and replays are limited to 10 per minute per endpoint. Requests carry <code>x-replayed-by: nanana</code>.</li>
          <li>You can override or add headers per replay. Results (status, duration, response, errors) are kept in the Replays tab.</li>
          <li><strong>Copy as curl</strong> produces a byte-exact command; binary bodies use <code>printf ... | base64 -d | curl --data-binary @-</code>.</li>
        </ul>

        <h2 id="limits">Limits and lifecycle</h2>
        <div className="not-prose overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-raised text-xs uppercase tracking-wider text-faint"><tr><th className="px-3 py-2">What</th><th className="px-3 py-2">Anonymous</th><th className="px-3 py-2">Free account</th></tr></thead>
            <tbody className="divide-y divide-line text-muted">
              {[
                ['Active endpoints', '3 new per address per day', '3 active, 1 custom name'],
                ['Body size', '1 MB', '5 MB'],
                ['Request rate', '60 per minute per endpoint', '300 per minute per endpoint'],
                ['Retention', 'newest 100 requests, 1 hour, 50 MB', 'same'],
                ['Active to cold', 'after 1 hour without activity', 'same'],
                ['Cold to gone', 'after 24 hours without activity', 'same'],
                ['Maximum life', '7 days', '7 days, renewable once (+7)'],
                ['Stored response', 'first 1 MB (the sender gets up to 10 MB)', 'same'],
              ].map(([a, b, c]) => <tr key={a}><th scope="row" className="px-3 py-2 font-medium text-fg">{a}</th><td className="px-3 py-2">{b}</td><td className="px-3 py-2">{c}</td></tr>)}
            </tbody>
          </table>
        </div>
        <p>A <strong>cold</strong> endpoint still captures; any activity (a request, a tunnel connection, opening the dashboard) wakes it up. A connected tunnel keeps it active. Over the limit you get <code>429</code> with a <code>Retry-After</code> header; bodies over the cap get <code>413</code>. Expired custom names answer <code>410</code> for 7 days and can only be re-created by their previous owner.</p>

        <h2 id="recipes">Provider recipes</h2>
        <h3>Stripe</h3>
        <ol>
          <li>Create an endpoint and copy its URL, for example <code>https://k7x2m9qa.nanana.lat/stripe</code>.</li>
          <li>In the Stripe dashboard, go to Developers, Webhooks, Add endpoint, paste the URL and choose events.</li>
          <li>Copy the signing secret (<code>whsec_...</code>). In nanana Settings set header <code>Stripe-Signature</code>, algorithm <code>sha256</code> and paste the secret.</li>
          <li>Send a test event from Stripe: the request appears with a green signature dot. The timestamp tolerance is 5 minutes.</li>
          <li>Run <code>nanana -t=TOKEN -p=3000</code> so Stripe's retries reach your handler; use a mock (<code>500</code> x2) to rehearse failures.</li>
        </ol>
        <h3>Transbank Webpay Plus (Chile)</h3>
        <p>Webpay Plus does not send a signed server-to-server webhook. After payment the customer's <em>browser</em> is sent to your <code>return_url</code> with <code>token_ws</code>, or with <code>TBK_TOKEN</code>, <code>TBK_ORDEN_COMPRA</code> and <code>TBK_ID_SESION</code> when the buyer cancels or times out. You then confirm the transaction with the SDK (<code>commit</code>).</p>
        <ol>
          <li>Create an endpoint and use <code>https://k7x2m9qa.nanana.lat/webpay/return</code> as the <code>return_url</code> when creating the transaction.</li>
          <li>Complete a payment in the integration environment. The return request (a GET or form POST) shows up in the dashboard with its parameters in the Query or form table.</li>
          <li>Tunnel it with <code>nanana -t=TOKEN -p=3000</code> so your local app receives the redirect and commits the transaction; the page your app renders is shown to the buyer.</li>
          <li>Replay the same <code>token_ws</code> request to debug your handler. Note that a token can only be committed once on Transbank's side.</li>
        </ol>

        <h2 id="accounts">Accounts</h2>
        <p>Sign in with a magic link (and GitHub or Google when enabled) at <Link to="/login">/login</Link>. Accounts get custom names, a list of their endpoints with renew and token rotation, CLI login and the ability to <em>claim</em> an anonymous endpoint using its token. Manage everything at <Link to="/account">/account</Link>.</p>
      </article>
    </div>
  );
}
