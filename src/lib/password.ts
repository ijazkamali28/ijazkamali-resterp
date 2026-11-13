import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const N = 2 ** 15, r = 8, p = 1, KEYLEN = 64;
const MAXMEM = 128 * N * r * 2;

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, rr, pp, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(secret.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(n), r: Number(rr), p: Number(pp), maxmem: 128 * Number(n) * Number(rr) * 2 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Used to burn equal time when the user does not exist (prevents user enumeration by timing). */
export const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export function passwordPolicyErrors(pw: string): string[] {
  const errors: string[] = [];
  if (pw.length < 10) errors.push('at least 10 characters');
  if (!/[a-z]/.test(pw)) errors.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) errors.push('an uppercase letter');
  if (!/[0-9]/.test(pw)) errors.push('a digit');
  return errors;
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
