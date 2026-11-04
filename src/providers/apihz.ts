/**
 * 接口盒子 apihz.cn 免费天气接口：
 * `tqyb.php?id=&key=&sheng=&place=&day=7&hourtype=1`。
 * 逐时预报是 3 小时粒度；本地预警在 `alarm` 字段里。
 */
import type { DailyPoint, HourlyPoint, ProviderRequest, WeatherLocation, WeatherNow, WeatherSnapshot } from '../types.ts';
import { buildHorizons } from '../forecast.ts';
import {
  formatDateKey,
  hourOf,
  localParts,
  parseHourMinute,
  parseLocalStamp,
  parseNumber,
  parsePrecipitation,
  placeCandidates,
  wallTimeToMs,
  windDirectionFromDegree,
  type PlaceCandidate,
} from '../location.ts';
import { cleanMessage, parseFlexibleAlerts, providerName, text } from './shared.ts';

type Json = Record<string, unknown>;

const ENDPOINT = 'https://cn.apihz.cn/api/tianqi/tqyb.php';

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return undefined;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function parseNow(payload: Json, nowMs: number, timezone: string): WeatherNow | undefined {
  const info = asRecord(payload.nowinfo) ?? {};
  const night = hourOf(nowMs, timezone) < 6 || hourOf(nowMs, timezone) >= 18;
  const condition = night ? text(payload.weather2) ?? text(payload.weather1) : text(payload.weather1) ?? text(payload.weather2);
  const direction =
    text(info.windDirection) ??
    windDirectionFromDegree(info.windDirectionDegree);
  const now: WeatherNow = {
    ...(parseLocalStamp(info.uptime ?? payload.uptime, timezone) !== undefined
      ? { observedAtMs: parseLocalStamp(info.uptime ?? payload.uptime, timezone) }
      : {}),
    ...(condition ? { condition } : {}),
    ...(parseNumber(info.temperature) !== undefined ? { temperatureC: parseNumber(info.temperature) } : {}),
    ...(parseNumber(info.feelst) !== undefined ? { feelsLikeC: parseNumber(info.feelst) } : {}),
    ...(parseNumber(info.humidity) !== undefined ? { humidityPct: parseNumber(info.humidity) } : {}),
    ...(parseNumber(info.pressure) !== undefined ? { pressureHpa: parseNumber(info.pressure) } : {}),
    ...(parsePrecipitation(info.precipitation) !== undefined
      ? { precipitationMm: parsePrecipitation(info.precipitation) }
      : {}),
    ...(direction ? { windDir: direction } : {}),
    ...(text(info.windScale) ? { windScale: text(info.windScale) } : {}),
    ...(parseNumber(info.windSpeed) !== undefined ? { windSpeedMps: parseNumber(info.windSpeed) } : {}),
  };
  return Object.values(now).some((value) => value !== undefined) ? now : undefined;
}

function parseHourly(payload: Json, nowMs: number, timezone: string): HourlyPoint[] {
  const base = parseLocalStamp(payload.hourtime ?? payload.uptime, timezone) ?? nowMs;
  const baseParts = localParts(base, timezone);
  const points: HourlyPoint[] = [];

  for (let day = 1; day <= 7; day += 1) {
    const list = asArray(payload[`hour${day}`]);
    let dayOffset = day - 1;
    let previousMinutes = -1;
    for (const raw of list) {
      const item = asRecord(raw);
      const clock = parseHourMinute(item?.['时间']);
      if (!item || !clock) continue;
      const minutes = clock.hour * 60 + clock.minute;
      if (previousMinutes >= 0 && minutes < previousMinutes) dayOffset += 1;
      previousMinutes = minutes;
      const atMs = wallTimeToMs(
        {
          year: baseParts.year,
          month: baseParts.month,
          day: baseParts.day + dayOffset,
          hour: clock.hour,
          minute: clock.minute,
        },
        timezone,
      );
      const point: HourlyPoint = {
        atMs,
        ...(text(item['天气']) ? { condition: text(item['天气']) } : {}),
        ...(parseNumber(item['气温']) !== undefined ? { temperatureC: parseNumber(item['气温']) } : {}),
        ...(parsePrecipitation(item['降水']) !== undefined
          ? { precipitationMm: parsePrecipitation(item['降水']) }
          : {}),
        ...(text(item['风向']) ? { windDir: text(item['风向']) } : {}),
        ...(parseNumber(item['风速']) !== undefined ? { windSpeedMps: parseNumber(item['风速']) } : {}),
        ...(parseNumber(item['湿度']) !== undefined ? { humidityPct: parseNumber(item['湿度']) } : {}),
      };
      points.push(point);
    }
  }

  const seen = new Set<number>();
  return points
    .filter((point) => {
      if (seen.has(point.atMs)) return false;
      seen.add(point.atMs);
      return true;
    })
    .sort((a, b) => a.atMs - b.atMs);
}

function parseDaily(payload: Json, nowMs: number, timezone: string): DailyPoint[] {
  const baseDate = formatDateKey(
    parseLocalStamp(payload.uptime ?? payload.hourtime, timezone) ?? nowMs,
    timezone,
  );
  const days: DailyPoint[] = [];
  const today: DailyPoint = {
    date: baseDate,
    ...(text(payload.weather1) ? { dayText: text(payload.weather1) } : {}),
    ...(text(payload.weather2) ? { nightText: text(payload.weather2) } : {}),
    ...(parseNumber(payload.wd1) !== undefined ? { dayTempC: parseNumber(payload.wd1) } : {}),
    ...(parseNumber(payload.wd2) !== undefined ? { nightTempC: parseNumber(payload.wd2) } : {}),
    ...(text(payload.winddirection1) ? { dayWindDir: text(payload.winddirection1) } : {}),
    ...(text(payload.winddirection2) ? { nightWindDir: text(payload.winddirection2) } : {}),
    ...(text(payload.windleve1) ? { dayWindScale: text(payload.windleve1) } : {}),
    ...(text(payload.windleve2) ? { nightWindScale: text(payload.windleve2) } : {}),
  };
  days.push(today);

  for (let index = 2; index <= 7; index += 1) {
    const item = asRecord(payload[`weatherday${index}`]);
    if (!item) continue;
    const date = normalizeDate(item.date);
    if (!date) continue;
    days.push({
      date,
      ...(text(item.weather1) ? { dayText: text(item.weather1) } : {}),
      ...(text(item.weather2) ? { nightText: text(item.weather2) } : {}),
      ...(parseNumber(item.wd1) !== undefined ? { dayTempC: parseNumber(item.wd1) } : {}),
      ...(parseNumber(item.wd2) !== undefined ? { nightTempC: parseNumber(item.wd2) } : {}),
      ...(text(item.winddirection1) ? { dayWindDir: text(item.winddirection1) } : {}),
      ...(text(item.winddirection2) ? { nightWindDir: text(item.winddirection2) } : {}),
      ...(text(item.windleve1) ? { dayWindScale: text(item.windleve1) } : {}),
      ...(text(item.windleve2) ? { nightWindScale: text(item.windleve2) } : {}),
    });
  }
  return days;
}

function hasWeatherData(payload: Json): boolean {
  return Boolean(
    asRecord(payload.nowinfo) ??
      text(payload.weather1) ??
      text(payload.weather2) ??
      asArray(payload.hour1).length,
  );
}

function fatalError(code: number | undefined, message: string): boolean {
  if (code === 401 || code === 403) return true;
  return /频次|过快|次数|会员|余额|积分|密钥|通讯|授权|登录|未注册|不存在该用户/i.test(message);
}

export async function fetchApihz(req: ProviderRequest): Promise<WeatherSnapshot> {
  const id = req.cfg.apihzId.trim() || req.secret('WEATHER_APIHZ_ID').trim();
  const key = req.cfg.apihzKey.trim() || req.secret('WEATHER_APIHZ_KEY').trim();
  if (!id || !key) {
    throw new Error(
      '接口盒子需要用户 ID 和通讯密钥。请到 https://www.apihz.cn/ 免费注册，在用户中心复制数字 ID 与 key，填入天气设置。',
    );
  }

  const candidates = placeCandidates(req.cfg.province, req.cfg.city).slice(0, 6);
  let payload: Json | null = null;
  let used: PlaceCandidate | null = null;
  let lastError = '';

  for (const place of candidates) {
    const params = new URLSearchParams({
      id,
      key,
      sheng: place.province,
      place: place.city,
      day: '7',
      hourtype: req.sections.forecast ? '1' : '0',
    });
    const response = await req.fetchJson<Json>(`${ENDPOINT}?${params.toString()}`);
    const code = parseNumber(response.code);
    if (code !== 200) {
      const msg = cleanMessage(text(response.msg) ?? '接口返回未知错误');
      lastError = `接口盒子返回错误 ${code ?? '?'}：${msg}`;
      if (fatalError(code, msg)) {
        throw new Error(
          `${lastError}。请检查用户 ID 与通讯密钥，或稍后重试；免费注册地址：https://www.apihz.cn/ 。`,
        );
      }
      continue;
    }
    if (!hasWeatherData(response)) {
      lastError = '接口盒子没有返回该地区的天气数据';
      continue;
    }
    payload = response;
    used = place;
    break;
  }

  if (!payload || !used) {
    const tried = candidates.map((place) => `${place.province}/${place.city}`).join('、');
    throw new Error(
      `${lastError || '接口盒子没有返回天气数据'}。已尝试：${tried || `${req.cfg.province}/${req.cfg.city}`}。接口盒子通常只支持到地级市，请把城市改成地级市名（例如 南宁市）。`,
    );
  }

  const now = parseNow(payload, req.nowMs, req.timezone);
  const hourly = req.sections.forecast ? parseHourly(payload, req.nowMs, req.timezone) : [];
  const daily = req.sections.forecast ? parseDaily(payload, req.nowMs, req.timezone) : [];
  const horizons = req.sections.forecast
    ? buildHorizons({ nowMs: req.nowMs, timezone: req.timezone, hourly, daily })
    : [];

  const publishedAtMs = parseLocalStamp(payload.uptime ?? payload.hourtime, req.timezone);
  const location: WeatherLocation = {
    province: text(payload.sheng) ?? used.province,
    city: text(payload.name) ?? text(payload.shi) ?? used.city,
    ...(parseNumber(payload.lat) !== undefined ? { latitude: parseNumber(payload.lat) } : { latitude: req.cfg.latitude }),
    ...(parseNumber(payload.lon) !== undefined ? { longitude: parseNumber(payload.lon) } : { longitude: req.cfg.longitude }),
  };
  const normalizedNote =
    used.province !== req.cfg.province || used.city !== req.cfg.city
      ? `接口盒子只支持到地级市；本次用「${used.province} / ${used.city}」查询。`
      : undefined;

  return {
    provider: 'apihz',
    providerName: providerName('apihz'),
    timezone: req.timezone,
    location,
    fetchedAtMs: req.nowMs,
    ...(publishedAtMs !== undefined ? { publishedAtMs } : {}),
    ...(now ? { now } : {}),
    horizons,
    ...(hourly.length ? { hourly } : {}),
    ...(daily.length ? { daily } : {}),
    alerts: req.sections.alerts ? parseFlexibleAlerts(payload.alarm, req.timezone) : [],
    capabilities: { now: true, forecast: true, hourly: true, alerts: true },
    limitations: [
      '接口盒子的时段预报是 3 小时粒度，1 小时后的值取最接近目标时刻的时次。',
      '本地预警取自天气接口的 alarm 字段；全国预警汇总接口需要另购授权。',
      ...(normalizedNote ? [normalizedNote] : []),
    ],
  };
}
