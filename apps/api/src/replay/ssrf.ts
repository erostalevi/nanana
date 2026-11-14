import dns from 'node:dns/promises';
import net from 'node:net';

const blocked = new net.BlockList();
const v4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
for (const [a, p] of v4) blocked.addSubnet(a, p, 'ipv4');
const v6: [string, number][] = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
  ['64:ff9b::', 96], ['100::', 64], ['2002::', 16],
];
for (const [a, p] of v6) blocked.addSubnet(a, p, 'ipv6');

export function isBlockedIp(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isBlockedIp(mapped[1]);
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export class UrlBlockedError extends Error {}

/** Parses the URL and resolves it; returns one vetted IP to connect to (prevents DNS rebinding). */
export async function resolveSafeTarget(raw: string, allowPrivate: boolean): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlBlockedError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlBlockedError('Only http and https URLs are allowed');
  if (url.username || url.password) throw new UrlBlockedError('Credentials in URLs are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host);
  const addrs = literal ? [{ address: host, family: literal }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new UrlBlockedError('Host could not be resolved');
  if (!allowPrivate && addrs.some((a) => isBlockedIp(a.address))) throw new UrlBlockedError('That host resolves to a private or reserved address');
  const pick = addrs[0];
  return { url, address: pick.address, family: pick.family as 4 | 6 };
}
