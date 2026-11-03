import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const getKey = () => {
  const encoded = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  if (!encoded || !/^[0-9a-fA-F]{64}$/.test(encoded)) {
    throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY must be a 32-byte hex key');
  }
  return Buffer.from(encoded, 'hex');
};

export const encryptSocialToken = (plaintext) => {
  if (typeof plaintext !== 'string' || !plaintext) throw new TypeError('Token is required');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
};

export const decryptSocialToken = (sealed) => {
  if (typeof sealed !== 'string') throw new TypeError('Encrypted token is required');
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported encrypted token format');
  const [_, nonce, tag, payload] = parts;
  const iv = Buffer.from(nonce, 'base64url');
  const authTag = Buffer.from(tag, 'base64url');
  if (iv.length !== 12 || authTag.length !== 16) throw new Error('Invalid encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
};
