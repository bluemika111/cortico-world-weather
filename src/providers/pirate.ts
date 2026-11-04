/**
 * Pirate Weather：Dark Sky 兼容的兜底源，需要 API KEY。
 * 返回实况、逐小时、逐日与 alerts；预警按标题/严重度归一到中央气象台四级。
 */
import type { DailyPoint, HourlyPoint, ProviderRequest, WeatherAlert, WeatherLocation, WeatherNow, WeatherSnapshot } from '../types.ts';
import { buildHorizons } from '../forecast.ts';
import { makeAlert, dedupeAlerts, sortAlerts } from '../alerts.ts';
import { parseNumber, formatDateKey, windDirectionFromDegree } from '../location.ts';
import { resolveCoordinates } from '../geocode.ts';
import { credentialIssue, resolveCredential, SECRET_NAMES } from '../credentials.ts';
import { providerName, text } from './shared.ts';

type Json = Record<string, unknown>;

const BASE = 'https://api.pirateweather.net/forecast';

const ICONS: Record<string, string> = {
  'clear-day': '晴',
  'clear-night': '晴',
  'partly-cloudy-day': '多云',
  'partly-cloudy-night': '多云',
  cloudy: '阴',
  fog: '雾',
  wind: '大风',
  rain: '雨',
  sleet: '雨夹雪',
  snow: '雪',
  hail: '冰雹',
  thunderstorm: '雷暴',
  tornado: '龙卷风',
};

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function condition(icon: unknown, summary: unknown): string | undefined {
  const summaryText = text(summary);
  if (summaryText && /[\u4e00-\u9fa5]/.test(summaryText)) return summaryText;
  const key = text(icon);
  return key ? ICONS[key] ?? key : summaryText;
}

function percent(value: unknown): number | undefined {
  const n = parseNumber(value);
  if (n === undefined) return undefined;
  return n <= 1 ? Math.round(n * 100) : n;
}

function epochMs(value: unknown): number | undefined {
  const n = parseNumber(value);
  return n === undefined ? undefined : n * 1000;
}

function parseNow(payload: Json, timezone: string): WeatherNow | undefined {
  const current = asRecord(payload.currently);
  if (!current) return undefined;
  const humidity = parseNumber(current.humidity);
  const now: WeatherNow = {
    ...(epochMs(current.time) !== undefined ? { observedAtMs: epochMs(current.time) } : {}),
    ...(condition(current.icon, current.summary) ? { condition: condition(current.icon, current.summary) } : {}),
    ...(parseNumber(current.temperature) !== undefined ? { temperatureC: parseNumber(current.temperature) } : {}),
    ...(parseNumber(current.apparentTemperature) !== undefined
      ? { feelsLikeC: parseNumber(current.apparentTemperature) }
      : {}),
    ...(humidity !== undefined ? { humidityPct: humidity <= 1 ? Math.round(humidity * 100) : humidity } : {}),
    ...(parseNumber(current.pressure) !== undefined ? { pressureHpa: parseNumber(current.pressure) } : {}),
    ...(parseNumber(current.precipIntensity) !== undefined
      ? { precipitationMm: parseNumber(current.precipIntensity) }
      : {}),
    ...(parseNumber(current.windSpeed) !== undefined ? { windSpeedMps: parseNumber(current.windSpeed) } : {}),
    ...(windDirectionFromDegree(current.windBearing)
      ? { windDir: windDirectionFromDegree(current.windBearing) }
      : {}),
    ...(parseNumber(current.visibility) !== undefined ? { visibilityKm: parseNumber(current.visibility) } : {}),
  };
  return Object.values(now).some((value) => value !== undefined) ? now : undefined;
}

function parseHourly(payload: Json): HourlyPoint[] {
  const hourly = asRecord(payload.hourly);
  const points: HourlyPoint[] = [];
  for (const raw of asArray(hourly?.data)) {
    const item = asRecord(raw);
    const atMs = item ? epochMs(item.time) : undefined;
    if (!item || atMs === undefined) continue;
    points.push({
      atMs,
      ...(condition(item.icon, item.summary) ? { condition: condition(item.icon, item.summary) } : {}),
      ...(parseNumber(item.temperature) !== undefined ? { temperatureC: parseNumber(item.temperature) } : {}),
      ...(percent(item.precipProbability) !== undefined
        ? { precipitationProbabilityPct: percent(item.precipProbability) }
        : {}),
      ...(parseNumber(item.precipIntensity) !== undefined
        ? { precipitationMm: parseNumber(item.precipIntensity) }
        : {}),
      ...(parseNumber(item.windSpeed) !== undefined ? { windSpeedMps: parseNumber(item.windSpeed) } : {}),
      ...(windDirectionFromDegree(item.windBearing)
        ? { windDir: windDirectionFromDegree(item.windBearing) }
        : {}),
      ...(percent(item.humidity) !== undefined ? { humidityPct: percent(item.humidity) } : {}),
    });
  }
  return points.sort((a, b) => a.atMs - b.atMs);
}

function parseDaily(payload: Json, timezone: string): DailyPoint[] {
  const daily = asRecord(payload.daily);
  const points: DailyPoint[] = [];
  for (const raw of asArray(daily?.data)) {
    const item = asRecord(raw);
    const atMs = item ? epochMs(item.time) : undefined;
    if (!item || atMs === undefined) continue;
    const date = formatDateKey(atMs, timezone);
    const min = parseNumber(item.temperatureMin);
    const max = parseNumber(item.temperatureMax);
    const direction = windDirectionFromDegree(item.windBearing);
    points.push({
      date,
      ...(condition(item.icon, item.summary) ? { dayText: condition(item.icon, item.summary) } : {}),
      ...(min !== undefined ? { minTempC: min } : {}),
      ...(max !== undefined ? { maxTempC: max } : {}),
      ...(parseNumber(item.precipAccumulation) !== undefined
        ? { precipitationMm: parseNumber(item.precipAccumulation) }
        : {}),
      ...(percent(item.precipProbability) !== undefined
        ? { precipitationProbabilityPct: percent(item.precipProbability) }
        : {}),
      ...(direction ? { dayWindDir: direction, nightWindDir: direction } : {}),
    });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

function parseAlerts(payload: Json, timezone: string): WeatherAlert[] {
  const alerts: WeatherAlert[] = [];
  for (const raw of asArray(payload.alerts)) {
    const item = asRecord(raw);
    const title = text(item?.title);
    if (!item || !title) continue;
    const alert = makeAlert({
      id: text(item.uri) ?? `${title}|${text(item.time) ?? ''}`,
      title,
      type: title,
      level: text(item.severity),
      issuedAt: epochMs(item.time),
      expiresAt: epochMs(item.expires),
      description: text(item.description),
      url: text(item.uri),
      timezone,
    });
    if (alert) alerts.push(alert);
  }
  return sortAlerts(dedupeAlerts(alerts));
}

export async function fetchPirate(req: ProviderRequest): Promise<WeatherSnapshot> {
  const issue = credentialIssue(req.cfg, req.secret);
  if (issue) throw new Error(issue);
  const key = resolveCredential(req.cfg.pirateWeatherKey, SECRET_NAMES.pirateWeatherKey, req.secret);
  const coordinates = await resolveCoordinates(req);
  const url =
    `${BASE}/${encodeURIComponent(key)}/${coordinates.latitude},${coordinates.longitude}` +
    '?units=si&lang=zh&exclude=minutely';
  const payload = await req.fetchJson<Json>(url);
  if (text(payload.error)) {
    throw new Error(`Pirate Weather 返回错误：${text(payload.error)}。请检查 API KEY 与免费额度。`);
  }

  const now = req.sections.now ? parseNow(payload, req.timezone) : undefined;
  const hourly = req.sections.forecast ? parseHourly(payload) : [];
  const daily = req.sections.forecast ? parseDaily(payload, req.timezone) : [];
  const horizons = req.sections.forecast
    ? buildHorizons({ nowMs: req.nowMs, timezone: req.timezone, hourly, daily })
    : [];
  const publishedAtMs = epochMs(asRecord(payload.currently)?.time);
  const location: WeatherLocation = {
    province: req.cfg.province,
    city: req.cfg.city,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
  };

  return {
    provider: 'pirate',
    providerName: providerName('pirate'),
    timezone: req.timezone,
    location,
    fetchedAtMs: req.nowMs,
    ...(publishedAtMs !== undefined ? { publishedAtMs } : {}),
    ...(now ? { now } : {}),
    horizons,
    ...(hourly.length ? { hourly } : {}),
    ...(daily.length ? { daily } : {}),
    alerts: req.sections.alerts ? parseAlerts(payload, req.timezone) : [],
    capabilities: { now: true, forecast: true, hourly: true, alerts: true },
    limitations: [
      'Pirate Weather 免费额度有限；数据来自全球预报模式，中国本地实况可能不如中央气象台细。',
      '英文预警标题会按关键词归入中央气象台类别，无法识别的保留原标题。',
    ],
  };
}
