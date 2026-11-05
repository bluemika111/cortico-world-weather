/** 七类数据源共用的快照形状。适配器只填能确认的字段，缺什么就留空。 */
import type { WeatherConfigSection } from './config.ts';

export type ProviderId = 'nmc' | 'cma' | 'apihz' | 'tencent' | 'qweather' | 'openmeteo' | 'pirate';

export const PROVIDER_IDS: readonly ProviderId[] = ['nmc', 'cma', 'apihz', 'tencent', 'qweather', 'openmeteo', 'pirate'];

/** 中央气象台的四级预警；认不出时用「未知」，不替对方降级或升级。 */
export type AlertLevel = '蓝色' | '黄色' | '橙色' | '红色' | '未知';

/** 模型拿到的时间尺度：此刻之后的 1、6、12、24、48 小时。 */
export type HorizonHours = 1 | 6 | 12 | 24 | 48;

export const HORIZON_HOURS: readonly HorizonHours[] = [1, 6, 12, 24, 48];

/** 事件正文的详略：brief 只给天气与气温（未来时次多一个降水概率），detailed 给全部要素。 */
export type DetailMode = 'brief' | 'detailed';

export interface WeatherNow {
  observedAtMs?: number;
  condition?: string;
  temperatureC?: number;
  feelsLikeC?: number;
  humidityPct?: number;
  pressureHpa?: number;
  precipitationMm?: number;
  windDir?: string;
  windScale?: string;
  windSpeedMps?: number;
  visibilityKm?: number;
  aqi?: number;
  aqiText?: string;
}

/** 一个未来时次。逐小时源给点值；逐日源给白天/夜间时段与最高/最低温。 */
export interface WeatherHorizon {
  hours: HorizonHours;
  targetMs: number;
  condition?: string;
  temperatureC?: number;
  temperatureMinC?: number;
  temperatureMaxC?: number;
  precipitationMm?: number;
  precipitationProbabilityPct?: number;
  windDir?: string;
  windScale?: string;
  windSpeedMps?: number;
  humidityPct?: number;
  /** 这个值的来源精度：逐小时、3 小时、逐日时段。 */
  granularity: 'hour' | '3h' | 'day';
  note?: string;
}

export interface WeatherAlert {
  id: string;
  /** 中央气象台体系里的灾害类别，例如暴雨、大风、寒潮。 */
  type: string;
  level: AlertLevel;
  title: string;
  issuedAtMs?: number;
  expiresAtMs?: number;
  description?: string;
  sender?: string;
  url?: string;
}

export interface WeatherCapabilities {
  now: boolean;
  forecast: boolean;
  hourly: boolean;
  alerts: boolean;
}

export interface WeatherLocation {
  province?: string;
  city: string;
  latitude?: number;
  longitude?: number;
  stationId?: string;
}

export interface WeatherSnapshot {
  provider: ProviderId;
  providerName: string;
  /** 本次渲染采用的时区，用于把数据源时间换算成用户看到的时间。 */
  timezone: string;
  location: WeatherLocation;
  /** 本扩展完成这次请求的时刻。 */
  fetchedAtMs: number;
  /** 数据源自己的发布时间；没有就不填。 */
  publishedAtMs?: number;
  now?: WeatherNow;
  horizons: WeatherHorizon[];
  alerts: WeatherAlert[];
  /** 适配器解析出的逐小时点，只用于「明天天气」这类汇总，不直接进事件正文。 */
  hourly?: HourlyPoint[];
  /** 适配器解析出的逐日点；没有逐日数据的源留空。 */
  daily?: DailyPoint[];
  capabilities: WeatherCapabilities;
  /** 数据源本身的限制，例如「没有逐小时预报」「没有预警」。 */
  limitations: string[];
  alertsNote?: string;
}

/** 三项开关归一化后的结果；全关时自动保留「现在天气」。 */
export interface WeatherSections {
  now: boolean;
  forecast: boolean;
  alerts: boolean;
  coerced: boolean;
}

export interface HourlyPoint {
  atMs: number;
  condition?: string;
  temperatureC?: number;
  precipitationMm?: number;
  precipitationProbabilityPct?: number;
  windDir?: string;
  windScale?: string;
  windSpeedMps?: number;
  humidityPct?: number;
}

/** 逐日源的一天；白天/夜间分开，气温可以是最高/最低。 */
export interface DailyPoint {
  date: string;
  dayText?: string;
  nightText?: string;
  dayTempC?: number;
  nightTempC?: number;
  minTempC?: number;
  maxTempC?: number;
  dayWindDir?: string;
  dayWindScale?: string;
  nightWindDir?: string;
  nightWindScale?: string;
  precipitationMm?: number;
  precipitationProbabilityPct?: number;
  note?: string;
}

export interface HttpInit {
  headers?: Record<string, string>;
}

export type FetchLike = (
  url: string,
  init?: HttpInit & { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type FetchJson = <T>(url: string, init?: HttpInit) => Promise<T>;

export interface ProviderRequest {
  cfg: WeatherConfigSection;
  sections: WeatherSections;
  timezone: string;
  nowMs: number;
  secret(name: string): string;
  fetchJson: FetchJson;
}
