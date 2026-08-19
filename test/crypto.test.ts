import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, randomToken } from '../src/crypto.js';

const KEY = 'a'.repeat(64); // 32 字节测试密钥
const KEY2 = 'b'.repeat(64);

describe('crypto', () => {
  it('加解密往返一致', () => {
    const plain = 'u-access-token-中文内容-{}:"json"';
    const cipher = encrypt(plain, KEY);
    expect(cipher).not.toContain(plain);
    expect(decrypt(cipher, KEY)).toBe(plain);
  });

  it('同一明文每次密文不同（随机 IV）', () => {
    const c1 = encrypt('same', KEY);
    const c2 = encrypt('same', KEY);
    expect(c1).not.toBe(c2);
    expect(decrypt(c1, KEY)).toBe('same');
    expect(decrypt(c2, KEY)).toBe('same');
  });

  it('错误密钥解密失败', () => {
    const cipher = encrypt('secret', KEY);
    expect(() => decrypt(cipher, KEY2)).toThrow();
  });

  it('篡改密文解密失败（GCM 完整性校验）', () => {
    const cipher = encrypt('secret', KEY);
    const buf = Buffer.from(cipher, 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(() => decrypt(buf.toString('base64'), KEY)).toThrow();
  });

  it('非法密钥长度抛错', () => {
    expect(() => encrypt('x', 'abcd')).toThrow(/64/);
  });

  it('randomToken 生成指定长度 hex', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});
