import { describe, expect, it } from 'vitest';
import { makeFetchJson } from '../src/http.ts';

describe('JSON 请求', () => {
  it('错误信息只保留主机名，不泄露路径或查询串里的密钥', async () => {
    const fetchJson = makeFetchJson(async () => ({
      ok: false,
      status: 500,
      text: async () => 'upstream failed',
    }));
    for (const url of [
      'https://api.pirateweather.net/forecast/SECRET-IN-PATH/39.9,116.4?units=si',
      'https://devapi.qweather.com/v7/weather/now?location=116.41,39.90&key=SECRET-IN-QUERY',
    ]) {
      let message = '';
      try {
        await fetchJson(url);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain(new URL(url).host);
      expect(message).not.toContain('SECRET');
    }
  });

  it('非 JSON 响应会说明主机与状态，不把整页内容倒出来', async () => {
    const fetchJson = makeFetchJson(async () => ({
      ok: true,
      status: 200,
      text: async () => `<html>${'x'.repeat(500)}</html>`,
    }));
    await expect(fetchJson('https://example.com/weather')).rejects.toThrow(/不是 JSON/);
  });
});
