/**
 * 中央气象台 nmc.cn 公开 JSON：
 * - 天气：`/rest/weather?stationid=<城市代码>`，代码形如 Wqsps，不是 54511 那种站号；
 * - 预警：`/rest/findAlarm` 的列表按省份取，再按城市名过滤。
 * 公开接口只有逐日预报，没有逐小时预报。
 */
import type { WeatherAlert, WeatherLocation, WeatherNow, WeatherSnapshot, ProviderRequest } from '../types.ts';
import type { DailyPoint } from '../types.ts';
import { makeAlert, dedupeAlerts, sortAlerts } from '../alerts.ts';
import { buildHorizons } from '../forecast.ts';
import {
  cityCores,
  namesMatch,
  parseLocalStamp,
  parseNumber,
  parsePrecipitation,
  stripAdminSuffix,
  validText,
} from '../location.ts';
import { absoluteNmcUrl, parseAqi, providerName, text } from './shared.ts';

type Json = Record<string, unknown>;

const BASE = 'https://www.nmc.cn';
const NMC_HEADERS = { Referer: 'https://www.nmc.cn/' };
const MAX_ALERTS = 10;

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface NmcCity {
  code: string;
  province?: string;
  city: string;
}

interface NmcStation extends NmcCity {
  cities?: NmcCity[];
}

async function resolveStation(req: ProviderRequest): Promise<NmcStation> {
  const explicit = req.cfg.nmcStationId.trim();
  if (explicit) {
    return { code: explicit, province: req.cfg.province, city: req.cfg.city };
  }

  const provinces = await req.fetchJson<unknown>(`${BASE}/rest/province`, { headers: NMC_HEADERS });
  const provinceList = asArray(provinces)
    .map(asRecord)
    .filter((item): item is Json => item !== null)
    .map((item) => ({ code: text(item.code) ?? '', name: text(item.name) ?? '' }))
    .filter((item) => item.code && item.name);
  const province = provinceList.find((item) => namesMatch(item.name, req.cfg.province));
  if (!province) {
    throw new Error(
      `中央气象台没有找到省级行政区「${req.cfg.province}」。请填写完整名称，例如 北京市、甘肃省；也可以在配置里直接填中央气象台城市代码。`,
    );
  }

  const rawCities = await req.fetchJson<unknown>(`${BASE}/rest/province/${encodeURIComponent(province.code)}`, {
    headers: NMC_HEADERS,
  });
  const cities = asArray(rawCities)
    .map(asRecord)
    .filter((item): item is Json => item !== null)
    .map((item) => ({
      code: text(item.code) ?? '',
      province: text(item.province) ?? province.name,
      city: text(item.city) ?? '',
    }))
    .filter((item) => item.code && item.city);
  const city = (() => {
    const wanted = cityCores(req.cfg.city);
    const exact = cities.find((item) =>
      cityCores(item.city).some((core) => wanted.some((want) => core === want)),
    );
    return exact ?? cities.find((item) => namesMatch(item.city, req.cfg.city));
  })();
  if (!city) {
    throw new Error(
      `中央气象台没有找到「${req.cfg.province} / ${req.cfg.city}」对应的城市。请检查城市名，或在配置里填中央气象台城市代码。`,
    );
  }
  return { ...city, cities };
}

function todayCondition(predict: Json, atMs: number, timezone: string): string | undefined {
  const detail = asArray(predict.detail).map(asRecord).filter((item): item is Json => item !== null);
  const today = detail[0];
  if (!today) return undefined;
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit' })
      .format(new Date(atMs))
      .replace(/\D/g, ''),
  );
  const period = hour < 6 || hour >= 18 ? 'night' : 'day';
  const side = asRecord(today[period]);
  const weather = asRecord(side?.weather);
  return text(weather?.info);
}

function parseNow(real: Json, predict: Json, air: Json | null, atMs: number, timezone: string): WeatherNow | undefined {
  const weather = asRecord(real.weather) ?? {};
  const wind = asRecord(real.wind) ?? {};
  const aqi = parseAqi(air);
  const now: WeatherNow = {
    ...(parseLocalStamp(real.publish_time, timezone) !== undefined
      ? { observedAtMs: parseLocalStamp(real.publish_time, timezone) }
      : {}),
    ...(text(weather.info) ?? todayCondition(predict, atMs, timezone)
      ? { condition: text(weather.info) ?? todayCondition(predict, atMs, timezone) }
      : {}),
    ...(parseNumber(weather.temperature) !== undefined ? { temperatureC: parseNumber(weather.temperature) } : {}),
    ...(parseNumber(weather.feelst) !== undefined ? { feelsLikeC: parseNumber(weather.feelst) } : {}),
    ...(parseNumber(weather.humidity) !== undefined ? { humidityPct: parseNumber(weather.humidity) } : {}),
    ...(parseNumber(weather.airpressure) !== undefined ? { pressureHpa: parseNumber(weather.airpressure) } : {}),
    ...(parsePrecipitation(weather.rain) !== undefined ? { precipitationMm: parsePrecipitation(weather.rain) } : {}),
    ...(text(wind.direct) ? { windDir: text(wind.direct) } : {}),
    ...(text(wind.power) ? { windScale: text(wind.power) } : {}),
    ...(parseNumber(wind.speed) !== undefined ? { windSpeedMps: parseNumber(wind.speed) } : {}),
    ...(aqi.aqi !== undefined ? { aqi: aqi.aqi } : {}),
    ...(aqi.text ? { aqiText: aqi.text } : {}),
  };
  return Object.values(now).some((value) => value !== undefined) ? now : undefined;
}

function parseDays(predict: Json): DailyPoint[] {
  return asArray(predict.detail)
    .map(asRecord)
    .filter((item): item is Json => item !== null)
    .map((item) => {
      const day = asRecord(item.day);
      const night = asRecord(item.night);
      const dayWeather = asRecord(day?.weather);
      const nightWeather = asRecord(night?.weather);
      const dayWind = asRecord(day?.wind);
      const nightWind = asRecord(night?.wind);
      const date = text(item.date);
      return {
        date: date ?? '',
        ...(text(dayWeather?.info) ? { dayText: text(dayWeather?.info) } : {}),
        ...(text(nightWeather?.info) ? { nightText: text(nightWeather?.info) } : {}),
        ...(parseNumber(dayWeather?.temperature) !== undefined
          ? { dayTempC: parseNumber(dayWeather?.temperature) }
          : {}),
        ...(parseNumber(nightWeather?.temperature) !== undefined
          ? { nightTempC: parseNumber(nightWeather?.temperature) }
          : {}),
        ...(text(dayWind?.direct) ? { dayWindDir: text(dayWind?.direct) } : {}),
        ...(text(dayWind?.power) ? { dayWindScale: text(dayWind?.power) } : {}),
        ...(text(nightWind?.direct) ? { nightWindDir: text(nightWind?.direct) } : {}),
        ...(text(nightWind?.power) ? { nightWindScale: text(nightWind?.power) } : {}),
        ...(parseNumber(item.precipitation) !== undefined
          ? { precipitationMm: parseNumber(item.precipitation) }
          : {}),
      } satisfies DailyPoint;
    })
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
}

function parseStationWarn(warn: Json | null, timezone: string): WeatherAlert[] {
  if (!warn) return [];
  const title = text(warn.alert);
  const signalType = text(warn.signaltype);
  const signalLevel = text(warn.signallevel);
  const issue = text(warn.issuetime);
  if (!title && !signalType && !signalLevel) return [];
  const fullTitle = title && !/^\d+$/.test(title) ? title : `${signalType ?? '气象预警'}${signalLevel ?? ''}预警`;
  const alert = makeAlert({
    id: absoluteNmcUrl(warn.url) ?? `${fullTitle}|${issue ?? ''}`,
    title: fullTitle,
    type: signalType,
    level: signalLevel,
    issuedAt: issue,
    description: text(warn.issuecontent),
    sender: [text(warn.province), text(warn.city)].filter(Boolean).join('') || undefined,
    url: absoluteNmcUrl(warn.url),
    timezone,
  });
  return alert ? [alert] : [];
}

function alertMatchesLocation(title: string, cityCore: string, provinceCore: string, cityCores: readonly string[]): boolean {
  if (cityCore && title.includes(cityCore)) return true;
  if (!provinceCore || !title.includes(provinceCore)) return false;
  const otherCity = cityCores.some((city) => city && city !== cityCore && city.length >= 2 && title.includes(city));
  return !otherCity;
}

async function fetchAlerts(
  req: ProviderRequest,
  real: Json,
  station: NmcStation,
  stationInfo: Json,
): Promise<{ alerts: WeatherAlert[]; note?: string }> {
  const stationWarn = parseStationWarn(asRecord(real.warn), req.timezone);
  const provinceName = text(stationInfo.province) ?? station.province ?? req.cfg.province;
  const cityName = text(stationInfo.city) ?? station.city ?? req.cfg.city;
  if (!provinceName) return { alerts: dedupeAlerts(stationWarn) };

  let candidates: unknown[] = [];
  let note: string | undefined;
  try {
    const payload = await req.fetchJson<Json>(
      `${BASE}/rest/findAlarm?pageNo=1&pageSize=50&signaltype=&signallevel=&province=${encodeURIComponent(provinceName)}`,
      { headers: NMC_HEADERS },
    );
    const data = asRecord(payload.data) ?? {};
    const page = asRecord(data.page) ?? {};
    candidates = [...asArray(page.list), ...asArray(data.provinceAlarms)];
  } catch {
    note = '中央气象台的预警列表暂时取不到，只显示了站点级预警。';
  }

  const cityCore = stripAdminSuffix(cityName);
  const provinceCore = stripAdminSuffix(provinceName);
  const cityCores = [
    cityCore,
    ...(station.cities ?? []).map((item) => stripAdminSuffix(item.city)),
  ].filter((item, index, all) => item && all.indexOf(item) === index);

  const list: WeatherAlert[] = [];
  for (const item of candidates) {
    const o = asRecord(item);
    const title = text(o?.title);
    if (!title || !alertMatchesLocation(title, cityCore, provinceCore, cityCores)) continue;
    const alert = makeAlert({
      id: text(o?.alertid),
      title,
      issuedAt: text(o?.issuetime),
      url: absoluteNmcUrl(o?.url),
      timezone: req.timezone,
    });
    if (alert) list.push(alert);
  }

  const merged = sortAlerts(dedupeAlerts([...stationWarn, ...list]));
  if (merged.length > MAX_ALERTS) {
    return { alerts: merged.slice(0, MAX_ALERTS), note: note ?? `生效预警较多，只列前 ${MAX_ALERTS} 条。` };
  }
  return { alerts: merged, ...(note ? { note } : {}) };
}

export async function fetchNmc(req: ProviderRequest): Promise<WeatherSnapshot> {
  const station = await resolveStation(req);
  const payload = await req.fetchJson<Json>(`${BASE}/rest/weather?stationid=${encodeURIComponent(station.code)}`, {
    headers: NMC_HEADERS,
  });
  const data = asRecord(payload.data);
  if (!data) {
    throw new Error('中央气象台接口没有返回该城市的天气。可能是城市代码不对，或接口暂时不可用。');
  }
  const real = asRecord(data.real) ?? {};
  const predict = asRecord(data.predict) ?? {};
  const stationInfo = asRecord(real.station) ?? {};
  const air = asRecord(data.air);
  const publishText = text(real.publish_time) ?? text(predict.publish_time);
  const publishedAtMs = parseLocalStamp(publishText, req.timezone);
  const now = parseNow(real, predict, air, req.nowMs, req.timezone);
  const days = parseDays(predict);
  const horizons = buildHorizons({
    nowMs: req.nowMs,
    timezone: req.timezone,
    hourly: [],
    daily: days,
  });

  const alertResult = req.sections.alerts
    ? await fetchAlerts(req, real, station, stationInfo)
    : { alerts: parseStationWarn(asRecord(real.warn), req.timezone) };

  const location: WeatherLocation = {
    province: text(stationInfo.province) ?? station.province,
    city: text(stationInfo.city) ?? station.city,
    latitude: req.cfg.latitude,
    longitude: req.cfg.longitude,
    stationId: station.code,
  };

  return {
    provider: 'nmc',
    providerName: providerName('nmc'),
    timezone: req.timezone,
    location,
    fetchedAtMs: req.nowMs,
    ...(publishedAtMs !== undefined ? { publishedAtMs } : {}),
    ...(now ? { now } : {}),
    horizons,
    ...(days.length ? { daily: days } : {}),
    alerts: alertResult.alerts,
    capabilities: { now: true, forecast: true, hourly: false, alerts: true },
    limitations: [
      '中央气象台公开接口只有逐日预报，没有逐小时预报；1/6/12 小时后的值按目标时刻所属的白天/夜间时段取。',
      '该公开接口是按发布内容轮询的，不是服务端主动推送；本扩展按配置的间隔取最新发布。',
    ],
    ...(alertResult.note ? { alertsNote: alertResult.note } : {}),
  };
}
