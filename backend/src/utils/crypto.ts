import crypto from 'crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM

function getDerivedKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a sensitive string (such as an OAuth refresh token) using AES-256-GCM authenticated encryption.
 * Output format: `ivHex:cipherHex:tagHex`
 */
export function encryptToken(plaintext: string, secretKey: string = env.OAUTH_TOKEN_ENCRYPTION_KEY): string {
  if (!plaintext) {
    throw new Error('Cannot encrypt empty plaintext');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getDerivedKey(secretKey);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`;
}

/**
 * Decrypts a ciphertext encrypted with `encryptToken`.
 * Validates the authentication tag to guarantee integrity and authenticity.
 */
export function decryptToken(ciphertext: string, secretKey: string = env.OAUTH_TOKEN_ENCRYPTION_KEY): string {
  if (!ciphertext) {
    throw new Error('Cannot decrypt empty ciphertext');
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted token format');
  }

  const [ivHex, encryptedHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const key = getDerivedKey(secretKey);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
