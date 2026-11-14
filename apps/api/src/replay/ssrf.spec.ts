import { isBlockedIp, pinnedLookup, resolveSafeTarget, UrlBlockedError } from './ssrf.js';

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'not-an-ip',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );
});

describe('resolveSafeTarget', () => {
  it('rejects non-http schemes, credentials and private literals', async () => {
    await expect(resolveSafeTarget('file:///etc/passwd', false)).rejects.toBeInstanceOf(UrlBlockedError);
    await expect(resolveSafeTarget('ftp://example.com', false)).rejects.toBeInstanceOf(UrlBlockedError);
    await expect(resolveSafeTarget('http://user:pw@8.8.8.8/', false)).rejects.toBeInstanceOf(UrlBlockedError);
    await expect(resolveSafeTarget('http://169.254.169.254/latest/meta-data', false)).rejects.toBeInstanceOf(UrlBlockedError);
    await expect(resolveSafeTarget('http://[::1]:8080/', false)).rejects.toBeInstanceOf(UrlBlockedError);
    await expect(resolveSafeTarget('http://localhost:3000/', false)).rejects.toBeInstanceOf(UrlBlockedError);
    await expect(resolveSafeTarget('not a url', false)).rejects.toBeInstanceOf(UrlBlockedError);
  });
  it('accepts public literals and the private escape hatch', async () => {
    expect((await resolveSafeTarget('https://8.8.8.8/x', false)).address).toBe('8.8.8.8');
    expect((await resolveSafeTarget('http://127.0.0.1:9/', true)).address).toBe('127.0.0.1');
  });
});

describe('pinnedLookup', () => {
  it('always answers with the vetted address in both callback shapes', () => {
    const l = pinnedLookup('93.184.216.34', 4);
    let single: unknown[] = [];
    l('evil.example', {}, (...a) => (single = a));
    expect(single).toEqual([null, '93.184.216.34', 4]);
    let all: unknown[] = [];
    l('evil.example', { all: true }, (...a) => (all = a));
    expect(all).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
  });
});
