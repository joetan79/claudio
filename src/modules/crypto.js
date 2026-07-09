import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey() {
  const secret = process.env.APP_ENCRYPTION_KEY;
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
}

export function isEncryptionEnabled() {
  return !!process.env.APP_ENCRYPTION_KEY;
}

export function encrypt(plaintext) {
  const key = getKey();
  if (!key) throw new Error('Encryption not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(ciphertext) {
  const key = getKey();
  if (!key) throw new Error('Encryption not configured');
  const [ivHex, authTagHex, dataHex] = ciphertext.split(':');
  if (!ivHex || !authTagHex || !dataHex) throw new Error('Malformed ciphertext');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

export function maskKey(plaintext) {
  if (!plaintext || plaintext.length < 9) return '****';
  return `${plaintext.slice(0, 5)}...${plaintext.slice(-4)}`;
}
