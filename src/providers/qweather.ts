/**
 * 和风天气 QWeather v7：实况、72 小时逐时、实时预警。
 * 免费订阅有调用次数上限；预警接口单独请求，失败时只放弃预警，不影响实况与预报。
 */
import type { HourlyPoint, ProviderRequest, WeatherAlert, WeatherLocation, WeatherNow, WeatherSnapshot } from '../types.ts';
import { buildHorizons } from '../forecast.ts';
import { makeAlert, dedupeAlerts, sortAlerts } from '../alerts.ts';
import { parseLocalStamp, parseNumber, parsePrecipitation } from '../location.ts';
import { resolveCoordinates } from '../geocode.ts';
import { credentialIssue, resolveCredential, SECRET_NAMES } from '../credentials.ts';
import { cleanMessage, providerName, text } from './shared.ts';

type Json = Record<string, unknown>;

const DEFAULT_HOST = 'devapi.qweather.com';

function baseUrl(host: string): string {
  const raw = host.trim() || DEFAULT_HOST;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return `${new URL(withScheme).origin}/v7`;
  } catch {
    return `https://${DEFAULT_HOST}/v7`;
  }
}

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function checkCode(payload: Json, what: string): void {
  const code = text(payload.code) ?? String(payload.code ?? '');
  if (code === '200') return;
  const hint =
    code === '401' || code === '403'
      ? '请检查 API KEY，以及「和风天气 · API Host」是否与控制台里这个项目的地址一致；免费版与商业版地址不同，403 时优先检查 Host。'
      : '';
  throw new Error(`和风天气 ${what} 返回错误码 ${code || '?'}：${cleanMessage(text(payload.msg) ?? '未知错误')}。${hint}`);
}

function parseNow(payload: Json, timezone: string): WeatherNow | undefined {
  const now = asRecord(payload.now);
  if (!now) return undefined;
  const speed = parseNumber(now.windSpeed);
  const result: WeatherNow = {
    ...(parseLocalStamp(now.obsTime, timezone) !== undefined
      ? { observedAtMs: parseLocalStamp(now.obsTime, timezone) }
      : {}),
    ...(text(now.text) ? { condition: text(now.text) } : {}),
    ...(parseNumber(now.temp) !== undefined ? { temperatureC: parseNumber(now.temp) } : {}),
    ...(parseNumber(now.feelsLike) !== undefined ? { feelsLikeC: parseNumber(now.feelsLike) } : {}),
    ...(parseNumber(now.humidity) !== undefined ? { humidityPct: parseNumber(now.humidity) } : {}),
    ...(parseNumber(now.pressure) !== undefined ? { pressureHpa: parseNumber(now.pressure) } : {}),
    ...(parsePrecipitation(now.precip) !== undefined ? { precipitationMm: parsePrecipitation(now.precip) } : {}),
    ...(text(now.windDir) ? { windDir: text(now.windDir) } : {}),
    ...(text(now.windScale) ? { windScale: text(now.windScale) } : {}),
    ...(speed !== undefined ? { windSpeedMps: Math.round((speed / 3.6) * 10) / 10 } : {}),
    ...(parseNumber(now.vis) !== undefined ? { visibilityKm: parseNumber(now.vis) } : {}),
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

function parseHourly(payload: Json, timezone: string): HourlyPoint[] {
  const points: HourlyPoint[] = [];
  for (const raw of asArray(payload.hourly)) {
    const item = asRecord(raw);
    if (!item) continue;
    const atMs = parseLocalStamp(item.fxTime, timezone);
    if (atMs === undefined) continue;
    const speed = parseNumber(item.windSpeed);
    points.push({
      atMs,
      ...(text(item.text) ? { condition: text(item.text) } : {}),
      ...(parseNumber(item.temp) !== undefined ? { temperatureC: parseNumber(item.temp) } : {}),
      ...(parseNumber(item.humidity) !== undefined ? { humidityPct: parseNumber(item.humidity) } : {}),
      ...(parseNumber(item.pop) !== undefined ? { precipitationProbabilityPct: parseNumber(item.pop) } : {}),
      ...(parsePrecipitation(item.precip) !== undefined
        ? { precipitationMm: parsePrecipitation(item.precip) }
        : {}),
      ...(text(item.windDir) ? { windDir: text(item.windDir) } : {}),
      ...(text(item.windScale) ? { windScale: text(item.windScale) } : {}),
      ...(speed !== undefined ? { windSpeedMps: Math.round((speed / 3.6) * 10) / 10 } : {}),
    });
  }
  return points.sort((a, b) => a.atMs - b.atMs);
}

function parseAlerts(payload: Json, timezone: string): WeatherAlert[] {
  const alerts: WeatherAlert[] = [];
  for (const raw of asArray(payload.warning)) {
    const item = asRecord(raw);
    if (!item) continue;
    const title = text(item.title);
    if (!title) continue;
    const alert = makeAlert({
      id: text(item.id),
      title,
      type: text(item.typeName) ?? text(item.type),
      level: text(item.level) ?? text(item.severityColor) ?? text(item.severity),
      issuedAt: text(item.pubTime) ?? text(item.startTime),
      expiresAt: text(item.endTime),
      description: text(item.text),
      sender: text(item.sender),
      url: text(item.url),
      timezone,
    });
    if (alert) alerts.push(alert);
  }
  return sortAlerts(dedupeAlerts(alerts));
}

export async function fetchQWeather(req: ProviderRequest): Promise<WeatherSnapshot> {
  const issue = credentialIssue(req.cfg, req.secret);
  if (issue) throw new Error(issue);
  const key = resolveCredential(req.cfg.qweatherKey, SECRET_NAMES.qweatherKey, req.secret);
  const coordinates = await resolveCoordinates(req);
  const location = `${coordinates.longitude.toFixed(2)},${coordinates.latitude.toFixed(2)}`;
  const base = baseUrl(req.cfg.qweatherHost);
  const common = new URLSearchParams({ location, key, lang: 'zh' });

  let nowPayload: Json | null = null;
  if (req.sections.now) {
    nowPayload = await req.fetchJson<Json>(`${base}/weather/now?${common.toString()}&unit=m`);
    checkCode(nowPayload, '实况');
  }

  let hourlyPayload: Json | null = null;
  if (req.sections.forecast) {
    hourlyPayload = await req.fetchJson<Json>(`${base}/weather/72h?${common.toString()}&unit=m`);
    checkCode(hourlyPayload, '72 小时预报');
  }

  let warningPayload: Json | null = null;
  let warningError: string | undefined;
  if (req.sections.alerts) {
    try {
      warningPayload = await req.fetchJson<Json>(`${base}/warning/now?${common.toString()}`);
      checkCode(warningPayload, '预警');
    } catch (error) {
      warningError = error instanceof Error ? error.message : String(error);
    }
  }

  const now = nowPayload ? parseNow(nowPayload, req.timezone) : undefined;
  const hourly = hourlyPayload ? parseHourly(hourlyPayload, req.timezone) : [];
  const horizons = req.sections.forecast
    ? buildHorizons({ nowMs: req.nowMs, timezone: req.timezone, hourly, daily: [] })
    : [];
  const alerts = warningPayload ? parseAlerts(warningPayload, req.timezone) : [];
  const publishedAtMs =
    parseLocalStamp(nowPayload ? asRecord(nowPayload.now)?.obsTime : undefined, req.timezone) ??
    (hourly[0] ? hourly[0].atMs : undefined);
  const locationInfo: WeatherLocation = {
    province: req.cfg.province,
    city: req.cfg.city,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
  };

  return {
    provider: 'qweather',
    providerName: providerName('qweather'),
    timezone: req.timezone,
    location: locationInfo,
    fetchedAtMs: req.nowMs,
    ...(publishedAtMs !== undefined ? { publishedAtMs } : {}),
    ...(now ? { now } : {}),
    horizons,
    ...(hourly.length ? { hourly } : {}),
    alerts,
    capabilities: { now: true, forecast: true, hourly: true, alerts: warningError === undefined },
    limitations: [
      '和风天气免费订阅有每日调用次数上限；超出后接口会返回错误码。',
      ...(warningError ? [`预警接口当前不可用：${warningError}`] : []),
    ],
    ...(warningError ? { alertsNote: `和风天气预警接口当前不可用：${warningError}` } : {}),
  };
}
