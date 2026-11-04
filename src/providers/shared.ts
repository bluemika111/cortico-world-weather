/** 各适配器共用的小件：名称、预警字段别名、AQI。 */
import type { Language } from 'cortico/core/language.ts';
import type { ProviderId, WeatherAlert } from '../types.ts';
import { makeAlert, dedupeAlerts } from '../alerts.ts';
import { parseNumber, validText } from '../location.ts';

const NAMES: Record<ProviderId, string> = {
  nmc: '中央气象台',
  cma: '中国气象数据网',
  apihz: '接口盒子',
  tencent: '腾讯天气',
  qweather: '和风天气',
  openmeteo: 'Open-Meteo',
  pirate: 'Pirate Weather',
};

export function providerName(provider: ProviderId, language?: Language): string {
  if (language === 'en') {
    return {
      nmc: 'NMC / CMA',
      cma: 'China Meteorological Data',
      apihz: 'APIHZ',
      tencent: 'Tencent Weather',
      qweather: 'QWeather',
      openmeteo: 'Open-Meteo',
      pirate: 'Pirate Weather',
    }[provider];
  }
  return NAMES[provider];
}

export function text(value: unknown): string | undefined {
  return validText(value);
}

/** 去掉第三方错误文案末尾的句号，避免拼出「……。。」。 */
export function cleanMessage(value: string): string {
  return value.replace(/[。.!！\s]+$/u, '');
}

export function absoluteNmcUrl(value: unknown): string | undefined {
  const url = text(value);
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `https://www.nmc.cn${url}`;
  return undefined;
}

/**
 * 接口盒子、腾讯、NMC 的预警数组字段名并不统一，这里按常见别名收一遍。
 * 认不出的对象不会硬编一条预警。
 */
export function parseFlexibleAlerts(value: unknown, timezone: string): WeatherAlert[] {
  const items = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const alerts: WeatherAlert[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const alert = makeAlert({ title: item, timezone });
      if (alert) alerts.push(alert);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title =
      text(o.title) ?? text(o.alarm_title) ?? text(o.alarmTitle) ?? text(o.name) ?? text(o.content) ?? text(o.text);
    const type =
      text(o.signaltype) ?? text(o.alarm_type) ?? text(o.typeName) ?? text(o.type) ?? text(o.alarmType);
    const level =
      text(o.signallevel) ??
      text(o.alarm_level) ??
      text(o.level) ??
      text(o.severityColor) ??
      text(o.severity);
    const issued =
      text(o.issuetime) ??
      text(o.alarm_time) ??
      text(o.pubTime) ??
      text(o.effective) ??
      text(o.time) ??
      text(o.startTime);
    const expires = text(o.expires) ?? text(o.expireTime) ?? text(o.endTime);
    const description =
      text(o.issuecontent) ??
      text(o.alarm_content) ??
      text(o.description) ??
      text(o.text) ??
      text(o.content);
    const sender = text(o.sender) ?? text(o.province);
    const alert = makeAlert({
      id: text(o.alertid) ?? text(o.alarm_id) ?? text(o.id) ?? text(o.alarmId),
      type,
      level,
      title,
      issuedAt: issued,
      expiresAt: expires,
      description,
      sender,
      url: absoluteNmcUrl(o.url) ?? text(o.uri),
      timezone,
    });
    if (alert) alerts.push(alert);
  }
  return dedupeAlerts(alerts);
}

export function parseAqi(source: unknown): { aqi?: number; text?: string } {
  if (!source || typeof source !== 'object') return {};
  const o = source as Record<string, unknown>;
  const aqi = parseNumber(o.aqi);
  const label = text(o.text) ?? text(o.aqi_name) ?? text(o.category);
  return {
    ...(aqi !== undefined ? { aqi } : {}),
    ...(label ? { text: label } : {}),
  };
}
