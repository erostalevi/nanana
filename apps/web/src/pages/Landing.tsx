import { Cable, Eye, FileCode2, Repeat, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CreateEndpoint } from '../components/CreateEndpoint';
import { Pricing } from '../components/Pricing';
import { CodeBlock } from '../components/ui';

const FEATURES = [
  { icon: Eye, title: 'Live inspector', body: 'Requests appear the moment they land: headers, query, pretty JSON, form fields, even raw bytes as hex.' },
  { icon: Repeat, title: 'Replay anywhere', body: 'Fire any captured request again at a public URL, or straight into your laptop through the tunnel.' },
  { icon: Cable, title: 'Tunnel to localhost', body: 'One small CLI forwards webhooks to your port and sends your app\'s real response back to the sender.' },
  { icon: ShieldCheck, title: 'HMAC check', body: 'Paste the signing secret once. Every request shows pass or fail, with received vs expected side by side.' },
  { icon: Sparkles, title: 'Response mocking', body: 'Answer the next N requests with a status of your choice, e.g. two 500s to test the sender\'s retry logic.' },
  { icon: FileCode2, title: 'Copy as curl', body: 'Turn any capture into a copy-pasteable curl command, byte-exact, binary bodies included.' },
];

const STEPS = [
  { n: '1', title: 'Create', body: 'Click the button. You get a URL like https://k7x2m9qa.nanana.lat and a private dashboard link.' },
  { n: '2', title: 'Point', body: 'Give the URL to Stripe, Transbank, GitHub, or anything that sends webhooks. Anything on any path is captured.' },
  { n: '3', title: 'Inspect and replay', body: 'Watch requests arrive live, check signatures, replay them, or tunnel them to the code on your machine.' },
];

const FAQ = [
  ['Is it free?', 'Yes. Anonymous endpoints and free accounts cost nothing. Pro ($8/month or $80/year) adds reserved names, always-on endpoints and higher limits for when you need them.'],
  ['What happens to my data?', 'On the free plan captured requests are deleted within an hour, and everything about an endpoint is gone within 24 hours of the last activity (Pro keeps 24 hours of history and never idles out). Captures are kept in tables that never go into backups.'],
  ['Do I need an account?', 'No. Creating an endpoint gives you a token. Accounts add custom names, a list of your endpoints and CLI login.'],
  ['Can anyone read my webhooks?', 'Only someone with your dashboard link (it holds a secret token after the #) or, for account endpoints, the owner signed in. Sending to your URL is public by nature, so do not treat the URL itself as a secret.'],
  ['Do you mask secrets in payloads?', 'No. Requests are stored and shown exactly as received, so avoid sending production secrets to a throwaway endpoint.'],
  ['What are the limits?', '100 requests, 1 hour of history and 50 MB per endpoint, 1 MB bodies for anonymous endpoints (5 MB with an account), and a 7-day maximum life for free endpoints. Pro raises these to 1000 requests, 24 hours and 250 MB per endpoint, 10 MB bodies, and removes the idle and 7-day limits.'],
];

export function Landing() {
  return (
    <>
      <section className="mx-auto grid max-w-6xl gap-10 px-4 pb-16 pt-14 sm:pt-20 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div className="min-w-0 space-y-6">
          <p className="font-mono text-sm text-accent">nanana.lat</p>
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">Catch webhooks.<br />Poke them.<br /><span className="text-accent">Replay them at localhost.</span></h1>
          <p className="max-w-xl text-lg text-muted">Throwaway endpoints with a live inspector, HMAC checks, response mocking and a tunnel to your machine. No sign-up, nothing to install to start.</p>
          <CreateEndpoint />
        </div>
        <div className="card overflow-hidden font-mono text-[13px]" aria-hidden="true">
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-xs text-faint"><span className="h-2.5 w-2.5 rounded-full bg-bad/70" /><span className="h-2.5 w-2.5 rounded-full bg-warn/70" /><span className="h-2.5 w-2.5 rounded-full bg-ok/70" /><span className="ml-2">k7x2m9qa.tools.nanana.lat</span></div>
          {[
            ['POST', '/stripe/webhook', '200', 'bg-accent/15 text-accent', 'bg-ok'],
            ['POST', '/webpay/return?token=01ab...', '200', 'bg-accent/15 text-accent', 'bg-ok'],
            ['GET', '/health', '200', 'bg-ok/15 text-ok', 'border border-faint'],
            ['POST', '/stripe/webhook', '500', 'bg-accent/15 text-accent', 'bg-bad'],
          ].map(([m, p, s, c, d], i) => (
            <div key={i} className="flex items-center gap-2 border-b border-line px-3 py-2.5 last:border-0">
              <span className={`chip w-14 justify-center ${c}`}>{m}</span>
              <span className="min-w-0 flex-1 truncate">{p}</span>
              <span className={`h-2 w-2 rounded-full ${d}`} />
              <span className={`chip ${s === '500' ? 'bg-bad/15 text-bad' : 'bg-ok/15 text-ok'}`}>{s}</span>
            </div>
          ))}
          <div className="p-4 text-xs leading-6 text-muted"><span className="text-faint">$</span> nanana -t=nnt_... -p=3000<br /><span className="text-ok">connected</span> forwarding to 127.0.0.1:3000<br /><span className="text-faint">12:04:09</span> POST /stripe/webhook <span className="text-ok">200</span> 14ms <span className="text-ok">signature ✓</span></div>
        </div>
      </section>

      <section className="border-y border-line bg-panel/50" aria-labelledby="how">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h2 id="how" className="mb-8 text-2xl font-semibold tracking-tight">How it works</h2>
          <ol className="grid gap-6 sm:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="card p-5">
                <span className="mb-3 grid h-8 w-8 place-items-center rounded-full bg-accent font-mono text-sm font-bold text-accent-fg">{s.n}</span>
                <h3 className="mb-1 font-semibold">{s.title}</h3>
                <p className="text-sm leading-6 text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16" aria-labelledby="cli">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="min-w-0">
            <h2 id="cli" className="mb-3 text-2xl font-semibold tracking-tight">Tunnel to your machine</h2>
            <p className="mb-4 text-muted">The <code className="font-mono text-fg">nanana</code> CLI is one static binary for macOS, Linux and Windows. It proxies real webhooks to your local app and relays the app's response back to the sender.</p>
            <CodeBlock label="Install" code="curl -fsSL https://nanana.lat/install.sh | sh" />
            <p className="mt-4 text-sm text-muted"><Link to="/docs#cli" className="link">CLI reference</Link></p>
          </div>
          <div className="min-w-0 space-y-3">
            <CodeBlock label="Forward to localhost:3000" code="nanana -t=nnt_yourtoken -p=3000" />
            <CodeBlock label="Forward to another host on your network" code="nanana -t=nnt_yourtoken -p=8080 -h=192.168.1.20" />
            <p className="text-xs text-faint"><code>-t</code> token, <code>-p</code> port, <code>-h</code> target host (default 127.0.0.1).</p>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-panel/50" aria-labelledby="features">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h2 id="features" className="mb-8 text-2xl font-semibold tracking-tight">Everything you need to debug a webhook</h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="card p-5">
                <Icon size={20} className="mb-3 text-accent" aria-hidden />
                <h3 className="mb-1 font-semibold">{title}</h3>
                <p className="text-sm leading-6 text-muted">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16" aria-labelledby="lifecycle">
        <h2 id="lifecycle" className="mb-3 text-2xl font-semibold tracking-tight">Ephemeral by design</h2>
        <p className="mb-6 max-w-2xl text-muted">Free endpoints sleep after 1 h idle and are gone after 24 h idle, with a 7 day maximum (Pro endpoints are always-on). Each endpoint keeps at most 100 requests, 1 hour of history and 50 MB.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          {[['active', 'activity in the last hour'], ['cold', '1 h to 24 h idle, still captures'], ['gone', '24 h idle: everything deleted'], ['7 days', 'hard ceiling for free endpoints']].map(([a, b]) => (
            <div key={a} className="card p-4"><p className="font-mono text-lg text-accent">{a}</p><p className="text-sm text-muted">{b}</p></div>
          ))}
        </div>
      </section>

      <section id="pricing" className="border-y border-line bg-panel/50" aria-labelledby="pricing-h">
        <Pricing />
      </section>

      <section className="mx-auto max-w-3xl px-4 py-16" aria-labelledby="faq">
        <h2 id="faq" className="mb-6 text-2xl font-semibold tracking-tight">FAQ</h2>
        <div className="divide-y divide-line rounded-xl border border-line">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group p-4">
              <summary className="cursor-pointer list-none font-medium marker:hidden"><span className="mr-2 font-mono text-accent group-open:hidden">+</span><span className="mr-2 hidden font-mono text-accent group-open:inline">-</span>{q}</summary>
              <p className="mt-2 pl-5 text-sm leading-6 text-muted">{a}</p>
            </details>
          ))}
        </div>
        <div className="mt-10 text-center"><Link to="/docs" className="link">Read the docs</Link></div>
      </section>
    </>
  );
}
