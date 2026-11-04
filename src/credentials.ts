/** 凭证与前置检查：缺什么就说清楚去哪注册、填哪一项，不替用户猜。 */
import type { WeatherConfigSection } from './config.ts';
import { needsCoordinates, needsPlaceNames, parseProvider } from './config.ts';
import type { ProviderId } from './types.ts';

export const SECRET_NAMES = {
  cmaUserId: 'WEATHER_CMA_USER_ID',
  cmaApiKey: 'WEATHER_CMA_API_KEY',
  apihzId: 'WEATHER_APIHZ_ID',
  apihzKey: 'WEATHER_APIHZ_KEY',
  qweatherKey: 'WEATHER_QWEATHER_KEY',
  pirateWeatherKey: 'WEATHER_PIRATE_KEY',
} as const;

/** 配置里填了就用配置，空串时再读部署 .env。 */
export function resolveCredential(
  value: string | undefined,
  secretName: string,
  secret: (name: string) => string,
): string {
  const fromConfig = (value ?? '').trim();
  if (fromConfig) return fromConfig;
  try {
    return (secret(secretName) ?? '').trim();
  } catch {
    return '';
  }
}

export function registrationHint(provider: ProviderId): string {
  switch (provider) {
    case 'cma':
      return '中国气象数据网需要先实名注册，并在「气象 API 服务」里订购资料：https://data.cma.cn/ 。从订单或用户中心取得用户 ID 与密钥（旧版是 userId + pwd，新版是 key），填入「中国气象数据网」两项。';
    case 'apihz':
      return '接口盒子需要先免费注册：https://www.apihz.cn/ 。登录后到用户中心复制数字 ID 与通讯密钥，填入「接口盒子 · 用户 ID」和「接口盒子 · 通讯密钥」。';
    case 'qweather':
      return '和风天气需要先注册并创建项目：https://dev.qweather.com/ 。把项目里的 API KEY 填入「和风天气 · API KEY」。';
    case 'pirate':
      return 'Pirate Weather 需要先免费注册：https://pirateweather.net/ 。在控制台生成 API KEY 后填入「Pirate Weather · API KEY」。';
    default:
      return '这个数据源不需要密钥。';
  }
}

/** 只检查凭证；返回 null 表示够用。 */
export function credentialIssue(cfg: WeatherConfigSection, secret: (name: string) => string): string | null {
  const provider = parseProvider(cfg.provider);
  switch (provider) {
    case 'cma': {
      const userId = resolveCredential(cfg.cmaUserId, SECRET_NAMES.cmaUserId, secret);
      const key = resolveCredential(cfg.cmaApiKey, SECRET_NAMES.cmaApiKey, secret);
      if (!userId && !key) return registrationHint('cma');
      if (userId && !key) return '中国气象数据网已填用户 ID，但还缺密钥 / 密码。' + registrationHint('cma');
      return null;
    }
    case 'apihz': {
      const id = resolveCredential(cfg.apihzId, SECRET_NAMES.apihzId, secret);
      const key = resolveCredential(cfg.apihzKey, SECRET_NAMES.apihzKey, secret);
      if (!id || !key) return '接口盒子需要用户 ID 和通讯密钥两项都填。' + registrationHint('apihz');
      return null;
    }
    case 'qweather':
      return resolveCredential(cfg.qweatherKey, SECRET_NAMES.qweatherKey, secret) ? null : registrationHint('qweather');
    case 'pirate':
      return resolveCredential(cfg.pirateWeatherKey, SECRET_NAMES.pirateWeatherKey, secret)
        ? null
        : registrationHint('pirate');
    default:
      return null;
  }
}

function locationIssue(cfg: WeatherConfigSection): string | null {
  const provider = parseProvider(cfg.provider);
  if (needsPlaceNames(provider)) {
    if (provider === 'nmc' && cfg.nmcStationId.trim()) return null;
    if (!cfg.province.trim() || !cfg.city.trim()) {
      return '请先填写「省 / 直辖市」和「城市 / 区县」，例如 北京市 / 北京。';
    }
  }
  if (provider === 'cma' && !cfg.cmaStationId.trim()) {
    return '中国气象数据网需要填台站号，例如北京 54511。';
  }
  if (needsCoordinates(provider)) {
    if (cfg.autoGeocode) return null;
    const { latitude, longitude } = cfg;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return '纬度必须是 -90 到 90 之间的数字。';
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return '经度必须是 -180 到 180 之间的数字。';
  }
  return null;
}

/** 激活前的完整检查：凭证、位置、经纬度。 */
export function preflightIssue(cfg: WeatherConfigSection, secret: (name: string) => string): string | null {
  return credentialIssue(cfg, secret) ?? locationIssue(cfg);
}
