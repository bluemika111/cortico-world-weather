import type { WeatherAlert, WeatherSnapshot } from '../../src/types.ts';
import { WEATHER_DEFAULTS, type WeatherConfigSection } from '../../src/config.ts';

export const NOW = Date.parse('2026-11-02T20:45:00+08:00');

export const BASE_CFG: WeatherConfigSection = { ...WEATHER_DEFAULTS, provider: 'openmeteo' };

export function makeSnapshot(
  overrides: Partial<WeatherSnapshot> = {},
  cfg: WeatherConfigSection = BASE_CFG,
  now = NOW,
): WeatherSnapshot {
  return {
    provider: cfg.provider,
    providerName: 'Open-Meteo',
    timezone: 'Asia/Shanghai',
    location: { province: cfg.province, city: cfg.city, latitude: cfg.latitude, longitude: cfg.longitude },
    fetchedAtMs: now,
    publishedAtMs: now,
    now: {
      condition: '晴',
      temperatureC: 11,
      feelsLikeC: 8.5,
      humidityPct: 60,
      pressureHpa: 1020,
      precipitationMm: 0,
      windDir: '南风',
      windSpeedMps: 2,
    },
    horizons: [1, 6, 12, 24, 48].map((hours) => ({
      hours: hours as 1 | 6 | 12 | 24 | 48,
      targetMs: now + hours * 3_600_000,
      condition: '晴',
      temperatureC: 10 + hours / 10,
      granularity: 'hour' as const,
    })),
    alerts: [],
    capabilities: { now: true, forecast: true, hourly: true, alerts: true },
    limitations: [],
    ...overrides,
  };
}

export function alert(overrides: Partial<WeatherAlert> = {}): WeatherAlert {
  return {
    id: 'a1',
    type: '暴雨',
    level: '蓝色',
    title: '北京市气象台发布暴雨蓝色预警',
    issuedAtMs: NOW - 3_600_000,
    ...overrides,
  };
}
