// Container healthcheck: GET /healthz on the loopback port. The Host header is
// the API host because the app routes by Host.
import http from 'node:http';

const port = Number(process.env.PORT ?? 3001);
const host = `api.${process.env.BASE_DOMAIN ?? 'localhost'}`;

const req = http.get(
  { host: '127.0.0.1', port, path: '/healthz', headers: { host }, timeout: 4000 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
