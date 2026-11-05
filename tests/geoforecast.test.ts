import { describe, expect, it, beforeEach } from 'vitest';
import {
  cityCores,
  formatDateKey,
  formatLocalDateTime,
  namesMatch,
  nextSlotAt,
  nextWallClockAt,
  parseLocalStamp,
  parseNumber,
  parsePrecipitation,
  placeCandidates,
  prefectureCity,
  shortProvince,
  tomorrowNoonMs,
  wallTimeToMs,
  windDirectionFromDegree,
} from '../src/location.ts';
import { buildHorizons } from '../src/forecast.ts';
import {
  detailOptions,
  normalizeHorizons,
  normalizeSections,
  parseDetailMode,
  parseNightlyTime,
  parseRefreshHours,
  WEATHER_DEFAULTS,
  withTrimmedText,
} from '../src/config.ts';
import { resetGeocodeCache, resolveCoordinates } from '../src/geocode.ts';
import type { FetchJson, ProviderRequest } from '../src/types.ts';

const NOW = Date.parse('2026-11-02T20:45:00+08:00');
const TZ = 'Asia/Shanghai';
const HOUR = 3_600_000;

describe('时间与地名', () => {
  it('墙上时间能换算回绝对时刻', () => {
    expect(wallTimeToMs({ year: 2026, month: 11, day: 2, hour: 20, minute: 45 }, TZ)).toBe(NOW);
    expect(formatLocalDateTime(NOW, TZ)).toBe('2026-11-02 20:45');
  });

  it('认得出各家常见时间写法', () => {
    expect(parseLocalStamp('2026-11-02 20:45', TZ)).toBe(NOW);
    expect(parseLocalStamp('2026/11/02 20:45', TZ)).toBe(NOW);
    expect(parseLocalStamp('20261102204500', TZ)).toBe(NOW);
    expect(parseLocalStamp('2026-11-02T20:45', TZ)).toBe(NOW);
    expect(parseLocalStamp('2026-11-02T12:45Z', TZ)).toBe(NOW);
    expect(parseLocalStamp('9999', TZ)).toBeUndefined();
    expect(parseLocalStamp('', TZ)).toBeUndefined();
  });

  it('省市名称允许带或不带行政区后缀', () => {
    expect(namesMatch('北京市', '北京')).toBe(true);
    expect(namesMatch('甘肃省', '甘肃')).toBe(true);
    expect(namesMatch('酒泉市', '酒泉')).toBe(true);
    expect(namesMatch('朝阳区', '朝阳')).toBe(true);
    expect(namesMatch('北京', '上海')).toBe(false);
    expect(cityCores('南宁市武鸣区')).toContain('武鸣');
  });

  it('带单位的数字与缺测哨兵值', () => {
    expect(parseNumber('5.4℃')).toBe(5.4);
    expect(parseNumber('3.3m/s')).toBe(3.3);
    expect(parseNumber('74.2%')).toBe(74.2);
    expect(parseNumber(0)).toBe(0);
    expect(parseNumber(9999)).toBeUndefined();
    expect(parseNumber('9999.0')).toBeUndefined();
    expect(parsePrecipitation('无降水')).toBe(0);
    expect(windDirectionFromDegree(270)).toBe('西风');
    expect(windDirectionFromDegree(205)).toBe('西南风');
  });
});

describe('设置归一化', () => {
  it('请求间隔只接受 1–48 的整数小时', () => {
    expect(parseRefreshHours('6')).toBe(6);
    expect(parseRefreshHours(12)).toBe(12);
    expect(parseRefreshHours(0)).toBe(6);
    expect(parseRefreshHours(49)).toBe(6);
    expect(parseRefreshHours('x')).toBe(6);
  });

  it('三项全关时恢复现在天气', () => {
    expect(normalizeSections({ showNow: false, showForecast: false, showAlerts: false })).toEqual({
      now: true,
      forecast: false,
      alerts: false,
      coerced: true,
    });
    expect(normalizeSections({ showNow: false, showForecast: false, showAlerts: true })).toEqual({
      now: false,
      forecast: false,
      alerts: true,
      coerced: false,
    });
  });

  it('详略只认 brief，其余按详细', () => {
    expect(parseDetailMode('brief')).toBe('brief');
    expect(parseDetailMode('detailed')).toBe('detailed');
    expect(parseDetailMode('')).toBe('detailed');
    expect(parseDetailMode(undefined)).toBe('detailed');
    expect(detailOptions('zh').map((option) => option.value)).toEqual(['brief', 'detailed']);
    expect(detailOptions('en')[0].label).toBe('Brief');
  });

  it('时次开关按选中的留下，全关时保留 24 小时', () => {
    expect(normalizeHorizons({ horizon1h: false, horizon6h: true, horizon12h: false, horizon24h: true, horizon48h: false }).hours).toEqual([6, 24]);
    const coerced = normalizeHorizons({
      horizon1h: false,
      horizon6h: false,
      horizon12h: false,
      horizon24h: false,
      horizon48h: false,
    });
    expect(coerced).toEqual({ hours: [24], coerced: true });
    expect(normalizeHorizons(WEATHER_DEFAULTS).hours).toEqual([1, 6, 12, 24, 48]);
  });
});

describe('未来时次', () => {
  it('逐小时源取最接近的时次', () => {
    const hourly = Array.from({ length: 72 }, (_, index) => ({
      atMs: NOW + index * HOUR,
      condition: '晴',
      temperatureC: 10 + index / 10,
    }));
    const horizons = buildHorizons({ nowMs: NOW, timezone: TZ, hourly, daily: [] });
    expect(horizons).toHaveLength(5);
    expect(horizons.map((h) => h.hours)).toEqual([1, 6, 12, 24, 48]);
    expect(horizons[0].granularity).toBe('hour');
    expect(horizons[0].targetMs).toBe(NOW + HOUR);
    expect(horizons[4].granularity).toBe('hour');
  });

  it('3 小时粒度会标出来', () => {
    const hourly = [3, 6, 9, 12].map((hours) => ({
      atMs: NOW + hours * HOUR,
      condition: '多云',
      temperatureC: 8,
    }));
    const horizons = buildHorizons({ nowMs: NOW, timezone: TZ, hourly, daily: [] });
    expect(horizons[1].granularity).toBe('3h');
    expect(horizons[1].condition).toBe('多云');
  });

  it('只有逐日源时按白天/夜间时段取值', () => {
    const daily = [
      { date: '2026-11-02', dayText: '晴', nightText: '多云', dayTempC: 19, nightTempC: 3 },
      { date: '2026-11-03', dayText: '小雨', nightText: '阴', dayTempC: 16, nightTempC: 5 },
      { date: '2026-11-04', dayText: '晴', nightText: '晴', dayTempC: 18, nightTempC: 4 },
    ];
    const horizons = buildHorizons({ nowMs: NOW, timezone: TZ, hourly: [], daily });
    expect(horizons).toHaveLength(5);
    for (const horizon of horizons) expect(horizon.granularity).toBe('day');
    // 当下是 20:45，1 小时后仍在夜间。
    expect(horizons[0].condition).toBe('多云');
    expect(horizons[0].temperatureC).toBe(3);
    expect(horizons[0].temperatureMinC).toBe(3);
    expect(horizons[0].temperatureMaxC).toBe(19);
    // 12 小时后是次日 08:45，取 11-03 的白天。
    expect(horizons[2].condition).toBe('小雨');
    expect(horizons[2].temperatureC).toBe(16);
    expect(horizons[3].note).toContain('夜间');
  });

  it('没有未来数据时也会留下五个时次并说明', () => {
    const horizons = buildHorizons({ nowMs: NOW, timezone: TZ, hourly: [], daily: [] });
    expect(horizons).toHaveLength(5);
    expect(horizons[0].note).toContain('没有可用');
  });
});

describe('地址与经纬度', () => {
  beforeEach(() => resetGeocodeCache());

  const request = (
    overrides: Partial<typeof WEATHER_DEFAULTS>,
    fetcher: (url: string) => unknown | Promise<unknown>,
  ): ProviderRequest => {
    const cfg = { ...WEATHER_DEFAULTS, provider: 'openmeteo' as const, ...overrides };
    const fetchJson: FetchJson = async <T>(url: string): Promise<T> => (await fetcher(url)) as T;
    return {
      cfg,
      sections: normalizeSections(cfg),
      timezone: TZ,
      nowMs: NOW,
      secret: () => '',
      fetchJson,
    };
  };

  it('把区县地址展开成可重试的省市组合', () => {
    expect(shortProvince('广西壮族自治区')).toBe('广西');
    expect(shortProvince('北京市')).toBe('北京');
    expect(prefectureCity('南宁市武鸣区')).toBe('南宁市');
    expect(prefectureCity('南宁市')).toBeUndefined();
    const pairs = placeCandidates('广西壮族自治区', '南宁市武鸣区');
    expect(pairs[0]).toEqual({ province: '广西壮族自治区', city: '南宁市武鸣区' });
    expect(pairs[1]).toEqual({ province: '广西壮族自治区', city: '南宁市' });
    expect(pairs[2]).toEqual({ province: '广西', city: '南宁市' });
  });

  it('自动解析会使用城市地址而不是旧经纬度', async () => {
    const seen: string[] = [];
    const coordinates = await resolveCoordinates(
      request({ autoGeocode: true, province: '广西壮族自治区', city: '南宁市武鸣区', latitude: 39.9, longitude: 116.4 }, (url) => {
        seen.push(decodeURIComponent(url));
        // 真实接口对带「市」的查询常常为空；只有「南宁」能查到。
        return decodeURIComponent(url).includes('name=南宁&')
          ? {
              results: [
                {
                  name: '南宁',
                  latitude: 22.81667,
                  longitude: 108.31667,
                  country_code: 'CN',
                  admin1: '广西',
                  admin2: '南宁市',
                  population: 5977185,
                },
              ],
            }
          : { results: [] };
      }),
    );
    expect(coordinates).toMatchObject({ latitude: 22.81667, longitude: 108.31667 });
    expect(seen.some((url) => url.includes('name=南宁&'))).toBe(true);
  });

  it('关闭自动解析时直接使用手填经纬度', async () => {
    let called = false;
    const coordinates = await resolveCoordinates(
      request({ autoGeocode: false, latitude: 1.5, longitude: 2.5 }, () => {
        called = true;
        return {};
      }),
    );
    expect(coordinates).toEqual({ latitude: 1.5, longitude: 2.5 });
    expect(called).toBe(false);
  });

  it('解析不到时明确报错，不沿用旧城市', async () => {
    resetGeocodeCache();
    await expect(
      resolveCoordinates(
        request({ autoGeocode: true, province: '广西壮族自治区', city: '南宁市武鸣区' }, () => ({ results: [] })),
      ),
    ).rejects.toThrow(/自动获取经纬度/);
  });
});

describe('取数排程', () => {
  const at = (text: string): number => Date.parse(text);
  const wall = (y: number, mo: number, d: number, h: number, mi: number): number =>
    wallTimeToMs({ year: y, month: mo, day: d, hour: h, minute: mi }, TZ);

  it('按本地 00:00 起算的整点时次排队', () => {
    expect(nextSlotAt(at('2026-11-02T05:00:00+08:00'), TZ, 6)).toBe(wall(2026, 11, 2, 6, 0));
    expect(nextSlotAt(at('2026-11-02T06:00:00+08:00'), TZ, 6)).toBe(wall(2026, 11, 2, 12, 0));
    expect(nextSlotAt(at('2026-11-02T20:45:00+08:00'), TZ, 6)).toBe(wall(2026, 11, 3, 0, 0));
    expect(nextSlotAt(at('2026-11-02T18:00:00+08:00'), TZ, 5)).toBe(wall(2026, 11, 2, 20, 0));
  });

  it('间隔不能整除一天时回到次日 00:00，大于一天时每天一次', () => {
    expect(nextSlotAt(at('2026-11-02T22:00:00+08:00'), TZ, 7)).toBe(wall(2026, 11, 3, 0, 0));
    expect(nextSlotAt(at('2026-11-02T20:00:00+08:00'), TZ, 5)).toBe(wall(2026, 11, 3, 0, 0));
    expect(nextSlotAt(at('2026-11-02T00:30:00+08:00'), TZ, 48)).toBe(wall(2026, 11, 3, 0, 0));
    expect(nextSlotAt(at('2026-11-02T09:15:00+08:00'), TZ, 1)).toBe(wall(2026, 11, 2, 10, 0));
  });

  it('每晚时刻到了投今天，错过就等明天', () => {
    expect(nextWallClockAt(at('2026-11-02T19:00:00+08:00'), TZ, 20, 0)).toBe(wall(2026, 11, 2, 20, 0));
    expect(nextWallClockAt(at('2026-11-02T20:00:00+08:00'), TZ, 20, 0)).toBe(wall(2026, 11, 3, 20, 0));
    expect(nextWallClockAt(NOW, TZ, 21, 30)).toBe(wall(2026, 11, 2, 21, 30));
    expect(formatDateKey(tomorrowNoonMs(at('2026-11-30T23:30:00+08:00'), TZ), TZ)).toBe('2026-12-01');
  });

  it('配置里的空白与坏时刻都会被收拾干净', () => {
    const cfg = {
      ...WEATHER_DEFAULTS,
      province: ' 上海市 ',
      city: '浦东新区　',
      nmcStationId: ' Wqsps ',
      apihzKey: '  key ',
    };
    const clean = withTrimmedText(cfg);
    expect(clean.province).toBe('上海市');
    expect(clean.city).toBe('浦东新区');
    expect(clean.nmcStationId).toBe('Wqsps');
    expect(clean.apihzKey).toBe('key');
    expect(cfg.city).toBe('浦东新区　');

    expect(parseNightlyTime('7:30')).toEqual({ hour: 7, minute: 30 });
    expect(parseNightlyTime(' 20:00 ')).toEqual({ hour: 20, minute: 0 });
    expect(parseNightlyTime('25:00')).toEqual({ hour: 20, minute: 0 });
    expect(parseNightlyTime('晚上八点')).toEqual({ hour: 20, minute: 0 });
  });
});
