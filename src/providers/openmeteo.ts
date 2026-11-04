/**
 * Open-Meteo：免密钥兜底源。实况 + 96 小时逐时。
 * 公开预报接口没有天气预警字段，也没有独立预警端点；这一点会明确交给模型。
 */
import type { HourlyPoint, ProviderRequest, WeatherLocation, WeatherNow, WeatherSnapshot } from '../types.ts';
import { buildHorizons } from '../forecast.ts';
import { parseLocalStamp, parseNumber, parsePrecipitation, windDirectionFromDegree } from '../location.ts';
import { resolveCoordinates } from '../geocode.ts';
import { providerName, text } from './shared.ts';

type Json = Record<string, unknown>;

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

const WMO: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '中毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
};

export function wmoCondition(code: unknown): string | undefined {
  const n = parseNumber(code);
  return n === undefined ? undefined : WMO[n] ?? `WMO ${n}`;
}

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function arrayAt(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseNow(payload: Json, timezone: string): WeatherNow | undefined {
  const current = asRecord(payload.current);
  if (!current) return undefined;
  const now: WeatherNow = {
    ...(parseLocalStamp(current.time, timezone) !== undefined
      ? { observedAtMs: parseLocalStamp(current.time, timezone) }
      : {}),
    ...(wmoCondition(current.weather_code) ? { condition: wmoCondition(current.weather_code) } : {}),
    ...(parseNumber(current.temperature_2m) !== undefined
      ? { temperatureC: parseNumber(current.temperature_2m) }
      : {}),
    ...(parseNumber(current.apparent_temperature) !== undefined
      ? { feelsLikeC: parseNumber(current.apparent_temperature) }
      : {}),
    ...(parseNumber(current.relative_humidity_2m) !== undefined
      ? { humidityPct: parseNumber(current.relative_humidity_2m) }
      : {}),
    ...(parseNumber(current.pressure_msl) !== undefined ? { pressureHpa: parseNumber(current.pressure_msl) } : {}),
    ...(parsePrecipitation(current.precipitation) !== undefined
      ? { precipitationMm: parsePrecipitation(current.precipitation) }
      : {}),
    ...(parseNumber(current.wind_speed_10m) !== undefined
      ? { windSpeedMps: parseNumber(current.wind_speed_10m) }
      : {}),
    ...(windDirectionFromDegree(current.wind_direction_10m)
      ? { windDir: windDirectionFromDegree(current.wind_direction_10m) }
      : {}),
  };
  return Object.values(now).some((value) => value !== undefined) ? now : undefined;
}

function parseHourly(payload: Json, timezone: string): HourlyPoint[] {
  const hourly = asRecord(payload.hourly);
  if (!hourly) return [];
  const times = arrayAt(hourly.time);
  const points: HourlyPoint[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const atMs = parseLocalStamp(times[index], timezone);
    if (atMs === undefined) continue;
    const condition = wmoCondition(arrayAt(hourly.weather_code)[index]);
    const point: HourlyPoint = {
      atMs,
      ...(condition ? { condition } : {}),
      ...(parseNumber(arrayAt(hourly.temperature_2m)[index]) !== undefined
        ? { temperatureC: parseNumber(arrayAt(hourly.temperature_2m)[index]) }
        : {}),
      ...(parseNumber(arrayAt(hourly.relative_humidity_2m)[index]) !== undefined
        ? { humidityPct: parseNumber(arrayAt(hourly.relative_humidity_2m)[index]) }
        : {}),
      ...(parseNumber(arrayAt(hourly.precipitation_probability)[index]) !== undefined
        ? { precipitationProbabilityPct: parseNumber(arrayAt(hourly.precipitation_probability)[index]) }
        : {}),
      ...(parsePrecipitation(arrayAt(hourly.precipitation)[index]) !== undefined
        ? { precipitationMm: parsePrecipitation(arrayAt(hourly.precipitation)[index]) }
        : {}),
      ...(parseNumber(arrayAt(hourly.wind_speed_10m)[index]) !== undefined
        ? { windSpeedMps: parseNumber(arrayAt(hourly.wind_speed_10m)[index]) }
        : {}),
      ...(windDirectionFromDegree(arrayAt(hourly.wind_direction_10m)[index])
        ? { windDir: windDirectionFromDegree(arrayAt(hourly.wind_direction_10m)[index]) }
        : {}),
    };
    points.push(point);
  }
  return points.sort((a, b) => a.atMs - b.atMs);
}

export async function fetchOpenMeteo(req: ProviderRequest): Promise<WeatherSnapshot> {
  const coordinates = await resolveCoordinates(req);
  const params = new URLSearchParams({
    latitude: String(coordinates.latitude),
    longitude: String(coordinates.longitude),
    timezone: req.timezone,
    forecast_days: '4',
    wind_speed_unit: 'ms',
    precipitation_unit: 'mm',
    current:
      'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m',
    hourly:
      'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
  });

  const payload = req.sections.now || req.sections.forecast
    ? await req.fetchJson<Json>(`${ENDPOINT}?${params.toString()}`)
    : {};
  const now = req.sections.now ? parseNow(payload, req.timezone) : undefined;
  const hourly = req.sections.forecast ? parseHourly(payload, req.timezone) : [];
  const horizons = req.sections.forecast
    ? buildHorizons({ nowMs: req.nowMs, timezone: req.timezone, hourly, daily: [] })
    : [];
  const publishedAtMs = parseLocalStamp(asRecord(payload.current)?.time, req.timezone);
  const location: WeatherLocation = {
    province: req.cfg.province,
    city: req.cfg.city,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
  };
  const note =
    'Open-Meteo 的公开预报接口不提供天气预警：响应里没有预警字段，也没有独立的预警端点。';

  return {
    provider: 'openmeteo',
    providerName: providerName('openmeteo'),
    timezone: req.timezone,
    location,
    fetchedAtMs: req.nowMs,
    ...(publishedAtMs !== undefined ? { publishedAtMs } : {}),
    ...(now ? { now } : {}),
    horizons,
    ...(hourly.length ? { hourly } : {}),
    alerts: [],
    capabilities: { now: true, forecast: true, hourly: true, alerts: false },
    limitations: [
      note,
      'Open-Meteo 返回 WMO 天气代码，本扩展已翻译成中文天气现象。',
      'Open-Meteo 是兜底源；它的数据来自全球模式，本地实况可能不如中央气象台细。',
    ],
    alertsNote: note,
  };
}
