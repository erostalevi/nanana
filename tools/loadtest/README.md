# nanana load test and capacity estimator

Two local tools that use your AWS credentials (the `aws` CLI profile you already use).

## `loadtest.mjs`: simulate traffic, watch the box, get a verdict

```bash
pnpm install                                   # once, from the repo root
node tools/loadtest/loadtest.mjs --profile medium       # asks before it starts; add --yes to skip the prompt
node tools/loadtest/loadtest.mjs --profile heavy --yes
node tools/loadtest/loadtest.mjs --profile probe --yes  # keeps raising the load until 50% of requests fail
node tools/loadtest/loadtest.mjs --rps 150 --duration 90 --subs 30 --tunnel-share 40 --body 2048
```

| profile | rps | duration | subdomains | default tunnel share | body |
|---|---|---|---|---|---|
| light | 30 | 60 s | 5 | 20% | 1 KB |
| medium | 100 | 90 s | 20 | 30% | 2 KB |
| heavy | 250 | 120 s | 40 | 30% | 4 KB |
| probe | starts at 20, grows 30% every 20 s, up to 1000 | until 50% fail | 40 | 30% | 2 KB |

**Tunnel share.** Every profile sends a percentage of its requests to endpoints that have a fake CLI tunnel connected (the fake CLI answers instantly), so the tunnel path (WebSocket framing, in-flight tracking) is part of every test. Set it with `--tunnel-share <0-100>`; custom runs without the flag use the default of 30% (`DEFAULT_TUNNEL_SHARE` in the script, the same figure the estimator assumes, there as the fraction 0.3). The number of tunnelled endpoints is derived from the share (at least one, at most 40, and at least one plain endpoint unless the share is 100%); `--tunnels N` overrides that count. The result reports the share actually sent and how many responses really came through a tunnel.

Hard caps for the fixed profiles: 600 rps, 300 s, 100 subdomains, 40 tunnels, 512 KB bodies.

### Probe mode

`--profile probe` finds where the system breaks. It starts at `--probe-start` rps (default 20) and multiplies the rate by `--probe-factor` (default 1.3) every `--step-seconds` (default 20 s), up to `--max-rps` (default 1000, hard maximum 2000). It stops when `--fail-at` percent (default 50) of a step's requests are failing: 5xx responses, network errors, and requests that are still hanging after 4 s (a collapse looks like timeouts). It also stops if the load generator itself cannot keep up (run it from a bigger machine then).

It prints one line per step as it goes and a summary at the end: the highest rate that was **comfortable** (at most 1% failing and p95 under 500 ms), the highest still **usable** (under 5% failing), the rate where it **broke**, and how many seconds the server needed to answer normally again after the load stopped. A probe run is not used to calibrate the estimator, because it ends in a collapse. It deliberately degrades the target: only run it when you can afford that.

What it does:

1. **Preflight**: finds the instance by tag, reads the operator token from SSM (`/nanana/prod/LOADTEST_TOKEN`), checks `/healthz`.
2. **Baseline**: one snapshot of CPU, memory, swap, containers and CPU credits.
3. **Traffic**: creates the subdomains, connects fake CLI tunnels (for the configured share of the traffic) that answer instantly, then sends an open-loop mix of JSON webhooks (80%), GETs, form posts and binary bodies with a 20% ramp-up.
4. **Live tail** (every 5 s): achieved rps, p50/p95 latency, error rate, plus CPU %, load, available memory, swap and per-container memory sampled from the box through SSM Run Command.
5. **Verdict**: `PASS`, `PASS WITH WARNINGS` or `FAIL`, with reasons. FAIL on: unhealthy API afterwards, container restarts, OOM events, over 1% 5xx or network errors, p99 above 3 s, available memory under 50 MB. WARN on: p95 above 500 ms, swap growth, CPU averaging above 85 % at the end, CPU steal (credits exhausted), 30 %+ credit burn, latency degrading over time, noisy logs, or the generator itself saturating.
6. **Cleanup**: deletes every subdomain it created (also on Ctrl+C).

Results are saved in `tools/loadtest/results/` (git-ignored). The newest monitored run (`last-run.json`) is what the estimator calibrates from.

How it avoids the free-tier limits: requests carry the operator header `x-loadtest-token`, which the API accepts only when it matches `LOADTEST_TOKEN` (set in SSM, rendered into the server's `.env`). Without it, the 3-per-IP-per-day creation limit and the 60 requests/minute per-subdomain limit would stop the test.

Notes:

- The generator runs on your machine, so your own network adds latency (the p50 includes the round trip to us-east-1).
- A t3.micro runs on CPU credits. If the balance is low, a long heavy run can throttle the box to its 20% baseline. That is a real finding, and the tool warns when the balance is under 40.
- CloudWatch CPU-credit metrics have 5-minute granularity, so the credit numbers lag the run.
- Local mode for developing the tool: `node loadtest.mjs --base localhost:3301 --scheme http --no-monitor --token <LOADTEST_TOKEN of a local API> --yes`.

## `estimate.mjs`: what can this setup realistically handle?

```bash
node tools/loadtest/estimate.mjs                                    # defaults
node tools/loadtest/estimate.mjs --avg-rps 30 --peak-rps 150 --peak-minutes 45 --tunnel-share 0.4 --body-kb 4
node tools/loadtest/estimate.mjs --instance t3.small --active-subs 500 --tunnels 60 --plan free
```

It models CPU-credit economics (the t3 constraint that matters most), memory, capture storage, database throughput, egress cost and the traffic ceiling implied by the per-plan rate limits, then compares t3.micro/small/medium/large for your scenario. If `results/last-run.json` exists it uses the CPU cost per request measured on the real box; otherwise it assumes 8 ms and says so.

Flags: `--avg-rps`, `--peak-rps`, `--peak-minutes` (per day), `--tunnel-share`, `--body-kb`, `--active-subs`, `--tunnels`, `--dashboards`, `--instance`, `--plan anonymous|free`, `--credits` (starting CPU-credit balance), `--json`.
