/** 按配置里的 provider 分发到各家适配器。 */
import type { ProviderRequest, WeatherSnapshot } from '../types.ts';
import { parseProvider, withTrimmedText } from '../config.ts';
import { fetchNmc } from './nmc.ts';
import { fetchCma } from './cma.ts';
import { fetchApihz } from './apihz.ts';
import { fetchTencent } from './tencent.ts';
import { fetchQWeather } from './qweather.ts';
import { fetchOpenMeteo } from './openmeteo.ts';
import { fetchPirate } from './pirate.ts';

export async function fetchWeather(input: ProviderRequest): Promise<WeatherSnapshot> {
  // 适配器统一看到去掉首尾空白的配置：多打一个空格不该让地名查不到。
  const req: ProviderRequest = { ...input, cfg: withTrimmedText(input.cfg) };
  switch (parseProvider(req.cfg.provider)) {
    case 'nmc':
      return fetchNmc(req);
    case 'cma':
      return fetchCma(req);
    case 'apihz':
      return fetchApihz(req);
    case 'tencent':
      return fetchTencent(req);
    case 'qweather':
      return fetchQWeather(req);
    case 'openmeteo':
      return fetchOpenMeteo(req);
    case 'pirate':
      return fetchPirate(req);
    default:
      throw new Error(`未知的天气数据源：${String(req.cfg.provider)}`);
  }
}
