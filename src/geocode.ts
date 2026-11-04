/**
 * 地址 → 经纬度：用 Open-Meteo 的免费地理编码服务。
 * 只在自动解析打开时使用；解析失败宁可报错，也不沿用旧城市的经纬度。
 */
import type { ProviderRequest } from './types.ts';
import { prefectureCity, shortProvince, stripAdminSuffix } from './location.ts';

export interface ResolvedCoordinates {
  latitude: number;
  longitude: number;
  name?: string;
  admin1?: string;
  admin2?: string;
}

interface GeoResult {
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  country_code?: unknown;
  admin1?: unknown;
  admin2?: unknown;
  population?: unknown;
}

interface GeoPayload {
  results?: unknown;
}

const TTL_MS = 24 * 3_600_000;
const cache = new Map<string, { at: number; value: ResolvedCoordinates }>();

export function resetGeocodeCache(): void {
  cache.clear();
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function queryNames(city: string): string[] {
  const raw = city.trim();
  const prefecture = prefectureCity(raw);
  // Open-Meteo 对中国地名比较挑：「南宁市」查不到，「南宁」可以。
  const queries = [
    raw,
    prefecture,
    stripAdminSuffix(raw),
    prefecture ? stripAdminSuffix(prefecture) : undefined,
    prefecture ? prefecture.replace(/市$/u, '') : undefined,
  ];
  return queries
    .map((item) => item?.trim() ?? '')
    .filter((item, index, all) => item !== '' && all.indexOf(item) === index);
}

interface GeoCandidate {
  name?: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  admin2?: string;
  population: number;
}

function pickResult(
  results: readonly GeoResult[],
  query: string,
  province: string,
  chinaOnly: boolean,
): ResolvedCoordinates | undefined {
  const candidates = results.flatMap((item): GeoCandidate[] => {
    const latitude = num(item.latitude);
    const longitude = num(item.longitude);
    if (latitude === undefined || longitude === undefined) return [];
    const country = clean(item.country_code);
    if (chinaOnly && country && country.toUpperCase() !== 'CN') return [];
    const name = clean(item.name);
    const admin1 = clean(item.admin1);
    const admin2 = clean(item.admin2);
    return [
      {
        latitude,
        longitude,
        population: num(item.population) ?? 0,
        ...(name ? { name } : {}),
        ...(admin1 ? { admin1 } : {}),
        ...(admin2 ? { admin2 } : {}),
      },
    ];
  });
  if (!candidates.length) return undefined;

  const queryCore = stripAdminSuffix(query);
  const provinceCore = stripAdminSuffix(shortProvince(province));
  const score = (item: GeoCandidate): number => {
    let points = 0;
    if (item.name && (item.name.includes(queryCore) || queryCore.includes(item.name))) points += 6;
    if (item.admin1 && provinceCore && (item.admin1.includes(provinceCore) || provinceCore.includes(item.admin1))) {
      points += 4;
    }
    if (item.admin2 && (item.admin2.includes(queryCore) || queryCore.includes(item.admin2))) points += 3;
    return points * 1_000_000 + Math.min(item.population, 999_999);
  };
  candidates.sort((a, b) => score(b) - score(a));
  const best = candidates[0];
  return {
    latitude: best.latitude,
    longitude: best.longitude,
    ...(best.name ? { name: best.name } : {}),
    ...(best.admin1 ? { admin1: best.admin1 } : {}),
    ...(best.admin2 ? { admin2: best.admin2 } : {}),
  };
}

/** 按配置决定使用手填经纬度，还是按省市自动解析。 */
export async function resolveCoordinates(req: ProviderRequest): Promise<ResolvedCoordinates> {
  if (!req.cfg.autoGeocode) {
    return { latitude: req.cfg.latitude, longitude: req.cfg.longitude };
  }
  const key = `${req.cfg.province}|${req.cfg.city}`;
  const hit = cache.get(key);
  if (hit && req.nowMs - hit.at < TTL_MS) return hit.value;

  const chinaOnly = /[\u4e00-\u9fa5]/u.test(req.cfg.province) || /[\u4e00-\u9fa5]/u.test(req.cfg.city);
  for (const query of queryNames(req.cfg.city)) {
    const params = new URLSearchParams({
      name: query,
      count: '5',
      language: 'zh',
      format: 'json',
      ...(chinaOnly ? { countryCode: 'CN' } : {}),
    });
    const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
    try {
      const payload = await req.fetchJson<GeoPayload>(url);
      const results = Array.isArray(payload.results) ? (payload.results as GeoResult[]) : [];
      const value = pickResult(results, query, req.cfg.province, chinaOnly);
      if (value) {
        cache.set(key, { at: req.nowMs, value });
        return value;
      }
    } catch {
      // 换下一个候选地名再试；全部失败时给一条明确的手填提示。
    }
  }

  throw new Error(
    `无法根据「${req.cfg.province} ${req.cfg.city}」自动获取经纬度。请把城市改成地级市名（例如 南宁市），或关闭「自动解析经纬度」后手动填写纬度与经度。`,
  );
}
