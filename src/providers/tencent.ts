/**
 * 腾讯天气公开页面接口：`wis.qq.com/weather/common`。
 * 免密钥；observe 是实况，forecast_1h 是未来 24 小时，forecast_24h 是 8 天逐日。
 * 这是网页接口，没有官方 SLA。
 */
import type { DailyPoint, HourlyPoint, ProviderRequest, WeatherLocation, WeatherNow, WeatherSnapshot } from '../types.ts';
import { buildHorizons } from '../forecast.ts';
import {
  parseLocalStamp,
  parseNumber,
  parsePrecipitation,
  placeCandidates,
  windDirectionFromDegree,
  type PlaceCandidate,
} from '../location.ts';
import { cleanMessage, parseFlexibleAlerts, providerName, text } from './shared.ts';

type Json = Record<string, unknown>;

const ENDPOINT = 'https://wis.qq.com/weather/common';

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function objectValues(value: unknown): Json[] {
  const record = asRecord(value);
  if (!record) return [];
  return Object.values(record)
    .map(asRecord)
    .filter((item): item is Json => item !== null);
}

function parseNow(observe: Json | null, timezone: string): WeatherNow | undefined {
  if (!observe) return undefined;
  const now: WeatherNow = {
    ...(parseLocalStamp(observe.update_time, timezone) !== undefined
      ? { observedAtMs: parseLocalStamp(observe.update_time, timezone) }
      : {}),
    ...(text(observe.weather) ? { condition: text(observe.weather) } : {}),
    ...(parseNumber(observe.degree) !== undefined ? { temperatureC: parseNumber(observe.degree) } : {}),
    ...(parseNumber(observe.humidity) !== undefined ? { humidityPct: parseNumber(observe.humidity) } : {}),
    ...(parseNumber(observe.pressure) !== undefined ? { pressureHpa: parseNumber(observe.pressure) } : {}),
    ...(parsePrecipitation(observe.precipitation) !== undefined
      ? { precipitationMm: parsePrecipitation(observe.precipitation) }
      : {}),
    ...(text(observe.wind_direction_name) || windDirectionFromDegree(observe.wind_direction)
      ? { windDir: text(observe.wind_direction_name) ?? windDirectionFromDegree(observe.wind_direction) }
      : {}),
    ...(text(observe.wind_power) ? { windScale: text(observe.wind_power) } : {}),
  };
  return Object.values(now).some((value) => value !== undefined) ? now : undefined;
}

function parseHourly(forecast: unknown, timezone: string): HourlyPoint[] {
  const points: HourlyPoint[] = [];
  for (const item of objectValues(forecast)) {
    const atMs = parseLocalStamp(item.update_time, timezone);
    if (atMs === undefined) continue;
    points.push({
      atMs,
      ...(text(item.weather) ? { condition: text(item.weather) } : {}),
      ...(parseNumber(item.degree) !== undefined ? { temperatureC: parseNumber(item.degree) } : {}),
      ...(text(item.wind_direction) ? { windDir: text(item.wind_direction) } : {}),
      ...(text(item.wind_power) ? { windScale: text(item.wind_power) } : {}),
    });
  }
  return points.sort((a, b) => a.atMs - b.atMs);
}

function parseDaily(forecast: unknown): DailyPoint[] {
  const points: DailyPoint[] = [];
  for (const item of objectValues(forecast)) {
    const date = text(item.time);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const min = parseNumber(item.min_degree);
    const max = parseNumber(item.max_degree);
    points.push({
      date,
      ...(text(item.day_weather) ? { dayText: text(item.day_weather) } : {}),
      ...(text(item.night_weather) ? { nightText: text(item.night_weather) } : {}),
      ...(min !== undefined ? { minTempC: min, nightTempC: min } : {}),
      ...(max !== undefined ? { maxTempC: max, dayTempC: max } : {}),
      ...(text(item.day_wind_direction) ? { dayWindDir: text(item.day_wind_direction) } : {}),
      ...(text(item.night_wind_direction) ? { nightWindDir: text(item.night_wind_direction) } : {}),
      ...(text(item.day_wind_power) ? { dayWindScale: text(item.day_wind_power) } : {}),
      ...(text(item.night_wind_power) ? { nightWindScale: text(item.night_wind_power) } : {}),
      ...(parseNumber(item.aqi) !== undefined ? { note: `AQI ${parseNumber(item.aqi)}` } : {}),
    });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

function hasRequiredData(data: Json, sections: ProviderRequest['sections']): boolean {
  const observe = asRecord(data.observe);
  const observeOk = Boolean(
    observe &&
      (text(observe.degree) ||
        text(observe.weather) ||
        parseNumber(observe.humidity) !== undefined ||
        parseNumber(observe.pressure) !== undefined),
  );
  const forecastOk = objectValues(data.forecast_1h).length > 0 || objectValues(data.forecast_24h).length > 0;
  const alertOk = Object.prototype.hasOwnProperty.call(data, 'alarm');
  return (!sections.now || observeOk) && (!sections.forecast || forecastOk) && (!sections.alerts || alertOk);
}

export async function fetchTencent(req: ProviderRequest): Promise<WeatherSnapshot> {
  const types = [
    req.sections.now ? 'observe' : '',
    req.sections.forecast ? 'forecast_1h' : '',
    req.sections.forecast ? 'forecast_24h' : '',
    req.sections.alerts ? 'alarm' : '',
  ].filter(Boolean);

  const candidates = placeCandidates(req.cfg.province, req.cfg.city).slice(0, 6);
  let data: Json | null = null;
  let used: PlaceCandidate | null = null;
  let lastError = '';

  for (const place of candidates) {
    const params = new URLSearchParams({
      source: 'pc',
      weather_type: types.join('|'),
      province: place.province,
      city: place.city,
    });
    const payload = await req.fetchJson<Json>(`${ENDPOINT}?${params.toString()}`);
    if (parseNumber(payload.status) !== 200) {
      lastError = `腾讯天气返回错误：${cleanMessage(text(payload.message) ?? '未知错误')}`;
      continue;
    }
    const candidateData = asRecord(payload.data);
    if (!candidateData || !hasRequiredData(candidateData, req.sections)) {
      lastError = '腾讯天气没有返回该地区的天气数据';
      continue;
    }
    data = candidateData;
    used = place;
    break;
  }

  if (!data || !used) {
    const tried = candidates.map((place) => `${place.province}/${place.city}`).join('、');
    throw new Error(
      `${lastError || '腾讯天气没有返回数据'}。已尝试：${tried || `${req.cfg.province}/${req.cfg.city}`}。腾讯天气是公开页面接口，可能临时不可用；也可以把城市改成地级市名（例如 南宁市）后再试。`,
    );
  }

  const observe = asRecord(data.observe);
  const now = parseNow(observe, req.timezone);
  const hourly = req.sections.forecast ? parseHourly(data.forecast_1h, req.timezone) : [];
  const daily = req.sections.forecast ? parseDaily(data.forecast_24h) : [];
  const horizons = req.sections.forecast
    ? buildHorizons({ nowMs: req.nowMs, timezone: req.timezone, hourly, daily })
    : [];
  const publishedAtMs =
    parseLocalStamp(observe?.update_time, req.timezone) ?? (hourly[0] ? hourly[0].atMs : undefined);
  const location: WeatherLocation = {
    province: used.province,
    city: used.city,
    latitude: req.cfg.latitude,
    longitude: req.cfg.longitude,
  };
  const normalizedNote =
    used.province !== req.cfg.province || used.city !== req.cfg.city
      ? `腾讯天气没有返回区县级数据，已改用「${used.province} / ${used.city}」查询；该接口通常只认到地级市。`
      : undefined;

  return {
    provider: 'tencent',
    providerName: providerName('tencent'),
    timezone: req.timezone,
    location,
    fetchedAtMs: req.nowMs,
    ...(publishedAtMs !== undefined ? { publishedAtMs } : {}),
    ...(now ? { now } : {}),
    horizons,
    ...(hourly.length ? { hourly } : {}),
    ...(daily.length ? { daily } : {}),
    alerts: req.sections.alerts ? parseFlexibleAlerts(data.alarm, req.timezone) : [],
    capabilities: { now: true, forecast: true, hourly: true, alerts: true },
    limitations: [
      '腾讯天气是公开的网页接口，没有官方 SLA；预警数组有时为空。',
      '逐小时预报覆盖未来 24 小时，48 小时后使用逐日预报。',
      ...(normalizedNote ? [normalizedNote] : []),
    ],
  };
}
