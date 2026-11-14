// Polls the production instance through SSM Run Command (uses the caller's AWS credentials).
import { aws, sleep } from './lib.mjs';

const SNAPSHOT = `
echo "cpu $(head -1 /proc/stat | cut -d' ' -f3-)"
echo "load $(cut -d' ' -f1-3 /proc/loadavg)"
free -m | awk '/Mem:/{print "mem "$2" "$7} /Swap:/{print "swap "$3}'
vmstat 1 2 | tail -1 | awk '{print "vm "$7" "$8}'
docker stats --no-stream --format 'ctr {{.Name}} {{.CPUPerc}} {{.MemUsage}}' 2>/dev/null
for c in nanana-api nanana-postgres nanana-caddy; do echo "state $c $(docker inspect -f '{{.RestartCount}} {{.State.Status}} {{.State.OOMKilled}} {{.State.StartedAt}}' $c 2>/dev/null)"; done
echo "oom $(dmesg 2>/dev/null | grep -ci 'out of memory')"
df -P / /var/lib/nanana/pgdata | awk 'NR>1{print "disk "$6" "$5}'
echo "conns $(docker exec nanana-caddy sh -c "awk '\\$4==\"01\"' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l" 2>/dev/null)"
echo "pgconn $(docker exec nanana-postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -Atc "select count(*) from pg_stat_activity"' 2>/dev/null)"
`;

export function parseSnapshot(text) {
  const s = { ctr: {}, state: {}, disk: {} };
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    switch (p[0]) {
      case 'cpu': {
        const n = p.slice(1).map(Number); // user nice system idle iowait irq softirq steal
        s.cpuRaw = { total: n.slice(0, 8).reduce((a, b) => a + b, 0), idle: n[3] + n[4], steal: n[7] || 0 };
        break;
      }
      case 'load': s.load = p.slice(1, 4).map(Number); break;
      case 'mem': s.memTotal = Number(p[1]); s.memAvail = Number(p[2]); break;
      case 'swap': s.swapUsed = Number(p[1]); break;
      case 'vm': s.swapIn = Number(p[1]); s.swapOut = Number(p[2]); break;
      case 'ctr': {
        // ctr <name> <cpu%> <used> / <limit>
        const used = p[3] || '0MiB';
        const num = parseFloat(used);
        const mb = /GiB/.test(used) ? num * 1024 : /KiB/.test(used) ? num / 1024 : num;
        s.ctr[p[1]] = { cpu: parseFloat(p[2]) || 0, memMb: mb };
        break;
      }
      case 'state': s.state[p[1]] = { restarts: Number(p[2]), status: p[3], oom: p[4] === 'true', startedAt: p[5] }; break;
      case 'oom': s.oom = Number(p[1]); break;
      case 'disk': s.disk[p[1]] = p[2]; break;
      case 'conns': s.conns = Number(p[1]); break;
      case 'pgconn': s.pgConns = Number(p[1]); break;
      default:
    }
  }
  return s;
}

export function cpuPercent(a, b) {
  if (!a?.cpuRaw || !b?.cpuRaw) return null;
  const dt = b.cpuRaw.total - a.cpuRaw.total;
  if (dt <= 0) return null;
  const busy = dt - (b.cpuRaw.idle - a.cpuRaw.idle);
  return { busy: (busy / dt) * 100, steal: ((b.cpuRaw.steal - a.cpuRaw.steal) / dt) * 100 };
}

export class Monitor {
  constructor({ instanceId, region }) {
    this.instanceId = instanceId;
    this.region = region;
  }

  /** One SSM round trip (typically 4-8 s). */
  async snapshot() {
    const b64 = Buffer.from(SNAPSHOT).toString('base64');
    const id = await aws(
      ['ssm', 'send-command', '--instance-ids', this.instanceId, '--document-name', 'AWS-RunShellScript', '--parameters', `commands=["echo ${b64} | base64 -d | bash"]`, '--query', 'Command.CommandId'],
      { region: this.region },
    );
    for (let i = 0; i < 40; i++) {
      await sleep(i === 0 ? 1500 : 800);
      let r;
      try {
        r = await aws(['ssm', 'get-command-invocation', '--command-id', id, '--instance-id', this.instanceId, '--query', '[Status,StandardOutputContent]'], { region: this.region, json: true });
      } catch {
        continue; // invocation not registered yet
      }
      if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(r[0])) return { at: Date.now(), ...parseSnapshot(r[1] || '') };
    }
    throw new Error('SSM snapshot timed out');
  }

  async creditBalance() {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 60_000);
    const get = async (metric, stat) => {
      try {
        const r = await aws(
          ['cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/EC2', '--metric-name', metric, '--dimensions', `Name=InstanceId,Value=${this.instanceId}`, '--start-time', start.toISOString(), '--end-time', end.toISOString(), '--period', '300', '--statistics', stat],
          { region: this.region, json: true },
        );
        const pts = (r.Datapoints || []).sort((a, b) => new Date(a.Timestamp) - new Date(b.Timestamp));
        return pts.length ? pts[pts.length - 1][stat] : null;
      } catch {
        return null;
      }
    };
    return { balance: await get('CPUCreditBalance', 'Average'), usage: await get('CPUCreditUsage', 'Sum'), cpu: await get('CPUUtilization', 'Average') };
  }

  async logErrorCounts(sinceIso) {
    const cmd = `for c in nanana-api nanana-caddy nanana-postgres; do echo "$c $(docker logs --since ${sinceIso} $c 2>&1 | grep -ciE 'error|fatal|panic')"; done`;
    const id = await aws(['ssm', 'send-command', '--instance-ids', this.instanceId, '--document-name', 'AWS-RunShellScript', '--parameters', `commands=["${cmd.replace(/"/g, '\\"')}"]`, '--query', 'Command.CommandId'], { region: this.region });
    for (let i = 0; i < 30; i++) {
      await sleep(1200);
      try {
        const r = await aws(['ssm', 'get-command-invocation', '--command-id', id, '--instance-id', this.instanceId, '--query', '[Status,StandardOutputContent]'], { region: this.region, json: true });
        if (['Success', 'Failed'].includes(r[0])) {
          const out = {};
          for (const l of (r[1] || '').split('\n')) {
            const [n, c] = l.trim().split(/\s+/);
            if (n) out[n] = Number(c);
          }
          return out;
        }
      } catch {
        /* retry */
      }
    }
    return {};
  }
}
