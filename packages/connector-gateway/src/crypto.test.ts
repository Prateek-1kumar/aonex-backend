import { describe, it, expect } from 'bun:test';
import { encryptToken, decryptToken } from './crypto.js';

// 32 bytes = 64 hex chars
const KEY = 'a'.repeat(64);

describe('encryptToken / decryptToken', () => {
  it('round-trips a plain token', () => {
    const plaintext = 'shpat_abc123secrettoken';
    const ciphertext = encryptToken(plaintext, KEY);
    expect(decryptToken(ciphertext, KEY)).toBe(plaintext);
  });

  it('produces different ciphertext each call (random IV)', () => {
    const plaintext = 'shpat_abc123secrettoken';
    expect(encryptToken(plaintext, KEY)).not.toBe(encryptToken(plaintext, KEY));
  });

  it('throws on tampered ciphertext', () => {
    const ciphertext = encryptToken('token', KEY);
    const parts = ciphertext.split(':');
    // Corrupt the auth tag
    parts[1] = Buffer.from('deadbeefdeadbeefdead', 'hex').toString('base64');
    expect(() => decryptToken(parts.join(':'), KEY)).toThrow();
  });
});
