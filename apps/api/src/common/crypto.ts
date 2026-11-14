import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
export const hmacHex = (secret: string, data: string): string =>
  createHmac('sha256', secret).update(data).digest('hex');

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function randomBase62(len: number): string {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248) out += B62[b % 62];
      if (out.length === len) break;
    }
  }
  return out;
}

export function randomSlug(len = 8): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export type TokenPrefix = 'nnt' | 'nna';
export const newToken = (prefix: TokenPrefix): string => `${prefix}_${randomBase62(32)}`;

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(blob: string, key: Buffer): string {
  const [iv, tag, ct] = blob.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export function hashIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}
