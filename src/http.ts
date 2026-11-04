/** 所有数据源共用的 JSON 请求：超时、错误裁剪、URL 去参数（不把密钥写进日志）。 */
import type { FetchJson, FetchLike } from './types.ts';

const DEFAULT_TIMEOUT_MS = 20_000;

function endpointOf(url: string): string {
  try {
    // 只保留主机名：密钥可能在查询串（和风、接口盒子）或路径里（Pirate Weather）。
    return new URL(url).host || '天气接口';
  } catch {
    return '天气接口';
  }
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? `：${flat.slice(0, 160)}` : '';
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '请求超时';
    return error.message;
  }
  return String(error);
}

export function makeFetchJson(
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): FetchJson {
  return async <T>(url: string, init: { headers?: Record<string, string> } = {}): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Coopanion-Weather/0.1',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`请求 ${endpointOf(url)} 返回 HTTP ${response.status}${snippet(text)}`);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`请求 ${endpointOf(url)} 返回的不是 JSON${snippet(text)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('请求 ')) throw error;
      throw new Error(`请求 ${endpointOf(url)} 失败：${reason(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
