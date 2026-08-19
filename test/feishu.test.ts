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
});
