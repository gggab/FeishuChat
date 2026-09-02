import axios, { AxiosError, AxiosInstance } from 'axios';

export const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
export const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface UserInfo {
  open_id: string;
  name: string;
  en_name?: string;
  avatar_url?: string;
}

interface FeishuEnvelope<T> {
  code: number;
  msg: string;
  data?: T;
}

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

function feishuError(err: unknown, action: string): Error {
  const axiosErr = err as AxiosError<FeishuEnvelope<unknown>>;
  const detail = axiosErr.response?.data
    ? `code=${axiosErr.response.data.code} msg=${axiosErr.response.data.msg}`
    : (err as Error).message;
  return new Error(`飞书接口调用失败（${action}）：${detail}`);
}

export class FeishuClient {
  private readonly http: AxiosInstance;
  private readonly appId: string;
  private readonly appSecret: string;
  private tenantToken: { value: string; expiresAt: number } | null = null;
  private tenantTokenPromise: Promise<string> | null = null;

  constructor(appId: string, appSecret: string, http?: AxiosInstance) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.http =
      http ??
      axios.create({
        baseURL: FEISHU_API_BASE,
        timeout: 15000,
      });
  }

  /** 校验飞书业务返回码（飞书 HTTP 200 时仍可能 code != 0） */
  private unwrap<T>(resp: { data: FeishuEnvelope<T> }, action: string): T {
    if (resp.data.code !== 0) {
      throw new Error(`飞书接口返回错误（${action}）：code=${resp.data.code} msg=${resp.data.msg}`);
    }
    return resp.data.data as T;
  }

  /** 授权码换 user_access_token */
  async exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
    try {
      const resp = await this.http.post<TokenResponse>('/authen/v2/oauth/token', {
        grant_type: 'authorization_code',
        client_id: this.appId,
        client_secret: this.appSecret,
        code,
        redirect_uri: redirectUri,
      });
      return resp.data;
    } catch (err) {
      throw feishuError(err, '授权码换令牌');
    }
  }

  /** refresh_token 刷新 user_access_token */
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    try {
      const resp = await this.http.post<TokenResponse>('/authen/v2/oauth/token', {
        grant_type: 'refresh_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        refresh_token: refreshToken,
      });
      return resp.data;
    } catch (err) {
      throw feishuError(err, '刷新令牌');
    }
  }

  /** 获取当前用户信息 */
  async getUserInfo(userAccessToken: string): Promise<UserInfo> {
    try {
      const resp = await this.http.get<FeishuEnvelope<UserInfo>>('/authen/v1/user_info', {
        headers: { Authorization: `Bearer ${userAccessToken}` },
      });
      return this.unwrap(resp, '获取用户信息');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('飞书接口返回错误')) throw err;
      throw feishuError(err, '获取用户信息');
    }
  }

  /** 以某用户身份调飞书 OpenAPI（自动带 Bearer） */
  async callAsUser<T>(
    userAccessToken: string,
    method: 'get' | 'post',
    urlPath: string,
    options: { params?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const action = `${method.toUpperCase()} ${urlPath}`;
    try {
      const resp = await this.http.request<FeishuEnvelope<T>>({
        method,
        url: urlPath,
        params: options.params,
        data: options.body,
        headers: { Authorization: `Bearer ${userAccessToken}` },
      });
      return this.unwrap(resp, action);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('飞书接口返回错误')) throw err;
      throw feishuError(err, action);
    }
  }

  /**
   * 获取 tenant_access_token（应用身份），带内存缓存：距过期 <5 分钟时重新获取。
   * 并发调用共享同一次换 token 请求。
   */
  async getTenantToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tenantToken.expiresAt - 5 * 60_000) {
      return this.tenantToken.value;
    }
    this.tenantTokenPromise ??= this.fetchTenantToken().finally(() => {
      this.tenantTokenPromise = null;
    });
    return this.tenantTokenPromise;
  }

  private async fetchTenantToken(): Promise<string> {
    try {
      const resp = await this.http.post<TenantTokenResponse>('/auth/v3/tenant_access_token/internal', {
        app_id: this.appId,
        app_secret: this.appSecret,
      });
      if (resp.data.code !== 0 || !resp.data.tenant_access_token) {
        throw new Error(`code=${resp.data.code} msg=${resp.data.msg}`);
      }
      this.tenantToken = {
        value: resp.data.tenant_access_token,
        expiresAt: Date.now() + (resp.data.expire ?? 7200) * 1000,
      };
      return this.tenantToken.value;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('code=')) {
        throw new Error(`飞书接口返回错误（获取 tenant_access_token）：${err.message}`);
      }
      throw feishuError(err, '获取 tenant_access_token');
    }
  }

  /** 以应用身份向指定群发送 interactive 卡片消息（机器人需在群内） */
  async sendCardMessage(chatId: string, card: Record<string, unknown>): Promise<void> {
    const token = await this.getTenantToken();
    try {
      const resp = await this.http.post<FeishuEnvelope<unknown>>(
        '/im/v1/messages?receive_id_type=chat_id',
        { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      this.unwrap(resp, '发送卡片消息');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('飞书接口返回错误')) throw err;
      throw feishuError(err, '发送卡片消息');
    }
  }
}
