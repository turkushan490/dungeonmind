import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import * as nodeCrypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

type Argon2 = (algo: string, params: Record<string, unknown>, cb: (err: Error | null, key: Buffer) => void) => void;
/** Node 24.7+ ships argon2 in node:crypto; older Node falls back to scrypt (both verify forever). */
const argon2 = (nodeCrypto as unknown as { argon2?: Argon2 }).argon2;
const ARGON = { parallelism: 1, tagLength: 32, memory: 19456, passes: 2 };

function argon2id(pw: string, nonce: Buffer): Promise<Buffer> {
  return new Promise((ok, fail) => argon2!('argon2id', { message: pw, nonce, ...ARGON }, (err, key) => (err ? fail(err) : ok(key))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  if (argon2) return `argon2id$${salt.toString('base64')}$${(await argon2id(pw, salt)).toString('base64')}`;
  const hash = await scryptAsync(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  let actual: Buffer;
  if (algo === 'argon2id' && argon2) actual = await argon2id(pw, Buffer.from(salt, 'base64'));
  else if (algo === 'scrypt') actual = await scryptAsync(pw, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  else return false;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newId = () => randomBytes(9).toString('base64url');

/** AES-256-GCM; output is iv.tag.ciphertext in base64. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.secretKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', config.secretKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
