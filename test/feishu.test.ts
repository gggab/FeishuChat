import { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { FeishuClient } from '../src/feishu.js';

/** 构造一个最小可用的 mock AxiosInstance */
function mockHttp(impl: Partial<AxiosInstance>): AxiosInstance {
  return impl as AxiosInstance;
}

describe('FeishuClient', () => {
  it('exchangeCode 以 authorization_code 调 v2 token 端点', async () => {
    const post = vi.fn().mockResolvedValue({
      data: { access_token: 'u-at', refresh_token: 'u-rt', expires_in: 7200 },
    });
    const client = new FeishuClient('app-id', 'app-secret', mockHttp({ post }));
    const resp = await client.exchangeCode('auth-code', 'http://x/oauth/callback');
    expect(resp.access_token).toBe('u-at');
    expect(post).toHaveBeenCalledWith('/authen/v2/oauth/token', {
      grant_type: 'authorization_code',
      client_id: 'app-id',
      client_secret: 'app-secret',
      code: 'auth-code',
      redirect_uri: 'http://x/oauth/callback',
    });
  });

  it('refreshToken 以 refresh_token 调 v2 token 端点', async () => {
    const post = vi.fn().mockResolvedValue({
      data: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 7200 },
    });
    const client = new FeishuClient('app-id', 'app-secret', mockHttp({ post }));
    const resp = await client.refreshToken('old-rt');
    expect(resp.access_token).toBe('new-at');
    expect(post).toHaveBeenCalledWith('/authen/v2/oauth/token', {
      grant_type: 'refresh_token',
      client_id: 'app-id',
      client_secret: 'app-secret',
      refresh_token: 'old-rt',
    });
  });

  it('getUserInfo 带 Bearer 头并解析 data', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { code: 0, msg: 'success', data: { open_id: 'ou_1', name: '李四' } },
    });
    const client = new FeishuClient('a', 's', mockHttp({ get }));
    const info = await client.getUserInfo('u-at');
    expect(info.open_id).toBe('ou_1');
    expect(get).toHaveBeenCalledWith('/authen/v1/user_info', {
      headers: { Authorization: 'Bearer u-at' },
    });
  });

  it('飞书业务 code != 0 时抛出带 code/msg 的错误', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { code: 99991663, msg: 'user access token invalid' },
    });
    const client = new FeishuClient('a', 's', mockHttp({ get }));
    await expect(client.getUserInfo('bad')).rejects.toThrow(/99991663/);
  });

  it('callAsUser 以用户身份调用并透传参数', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { code: 0, msg: 'success', data: { items: [] } },
    });
    const client = new FeishuClient('a', 's', mockHttp({ request }));
    const result = await client.callAsUser<{ items: unknown[] }>('u-at', 'get', '/im/v1/chats', {
      params: { page_size: 10 },
    });
    expect(result.items).toEqual([]);
    expect(request).toHaveBeenCalledWith({
      method: 'get',
      url: '/im/v1/chats',
      params: { page_size: 10 },
      data: undefined,
      headers: { Authorization: 'Bearer u-at' },
    });
  });

  it('getTenantToken 缓存 token，有效期内不重复请求', async () => {
    const post = vi.fn().mockResolvedValue({
      data: { code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 },
    });
    const client = new FeishuClient('app-id', 'app-secret', mockHttp({ post }));
    expect(await client.getTenantToken()).toBe('t-1');
    expect(await client.getTenantToken()).toBe('t-1');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/auth/v3/tenant_access_token/internal', {
      app_id: 'app-id',
      app_secret: 'app-secret',
    });
  });

  it('getTenantToken 业务失败时抛错且不缓存', async () => {
    const post = vi.fn().mockResolvedValue({ data: { code: 10003, msg: 'invalid app_secret' } });
    const client = new FeishuClient('a', 's', mockHttp({ post }));
    await expect(client.getTenantToken()).rejects.toThrow(/10003/);
    // 失败后重试会再次发起请求
    await expect(client.getTenantToken()).rejects.toThrow(/10003/);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('sendCardMessage 以 tenant token 调 im/v1/messages', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ data: { code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 } })
      .mockResolvedValueOnce({ data: { code: 0, msg: 'success', data: {} } });
    const client = new FeishuClient('a', 's', mockHttp({ post }));
    const card = { header: { template: 'red', title: { tag: 'plain_text', content: 'x' } }, elements: [] };
    await client.sendCardMessage('oc_chat1', card);
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/im/v1/messages?receive_id_type=chat_id',
      { receive_id: 'oc_chat1', msg_type: 'interactive', content: JSON.stringify(card) },
      { headers: { Authorization: 'Bearer t-1' } },
    );
  });
});
