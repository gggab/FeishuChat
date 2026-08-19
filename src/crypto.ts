import crypto from 'node:crypto';

const IV_LENGTH = 12; // GCM 推荐的 96 位 IV
const KEY_LENGTH = 32; // AES-256

function keyFromHex(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('加密密钥必须是 64 个十六进制字符（32 字节）');
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * AES-256-GCM 加密。
 * 输出格式：base64(iv[12] | ciphertext | authTag[16])
 */
export function encrypt(plainText: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  if (key.length !== KEY_LENGTH) throw new Error('密钥长度必须为 32 字节');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

/** 解密 encrypt() 的产物；密文被篡改或密钥错误时抛异常 */
export function decrypt(cipherText: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const buf = Buffer.from(cipherText, 'base64');
  if (buf.length <= IV_LENGTH + 16) {
    throw new Error('密文格式非法');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - 16);
  const encrypted = buf.subarray(IV_LENGTH, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** 生成随机 token（hex 字符串） */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
