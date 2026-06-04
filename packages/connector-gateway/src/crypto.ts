// AES-256-GCM helpers for encrypting connection tokens at rest.
//
// encryptToken / decryptToken wrap node:crypto with a per-call random IV and an
// auth tag, serialized as `iv:tag:ciphertext` (base64). The 32-byte key is passed
// in hex-encoded by the caller (from env). Used by the Postgres connection registry.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

export function encryptToken(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptToken(ciphertext: string, keyHex: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('INVALID_CIPHERTEXT_FORMAT');
  const [ivB64, tagB64, encB64] = parts as [string, string, string];
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
