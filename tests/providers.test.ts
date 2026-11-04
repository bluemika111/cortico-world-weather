import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEATHER_DEFAULTS, normalizeSections, type WeatherConfigSection } from '../src/config.ts';
import type { FetchJson, ProviderRequest } from '../src/types.ts';
import { fetchNmc } from '../src/providers/nmc.ts';
import { fetchApihz } from '../src/providers/apihz.ts';
import { fetchTencent } from '../src/providers/tencent.ts';
import { fetchQWeather } from '../src/providers/qweather.ts';
import { fetchOpenMeteo } from '../src/providers/openmeteo.ts';
import { fetchPirate } from '../src/providers/pirate.ts';
import { fetchCma } from '../src/providers/cma.ts';
import { fetchWeather } from '../src/providers/index.ts';
import { credentialIssue, preflightIssue } from '../src/credentials.ts';
import { levelFrom, typeFrom } from '../src/alerts.ts';

const NOW = Date.parse('2026-11-02T20:45:00+08:00');
const TZ = 'Asia/Shanghai';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures', name), 'utf8')) as T;
}

function makeRequest(
  overrides: Partial<WeatherConfigSection>,
  fetcher: (url: string) => unknown | Promise<unknown>,
  secrets: Record<string, string> = {},
): ProviderRequest {
  const cfg = { ...WEATHER_DEFAULTS, ...overrides };
  const fetchJson: FetchJson = async <T>(url: string): Promise<T> => (await fetcher(url)) as T;
  return {
    cfg,
    sections: normalizeSections(cfg),
    timezone: TZ,
    nowMs: NOW,
    secret: (name) => secrets[name] ?? '',
    fetchJson,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('中央气象台适配器', () => {
  const weather = fixture<Record<string, unknown>>('nmc-weather.json');

  function fetcherWith(weatherPayload: unknown, alerts: unknown = { data: { page: { list: [] }, provinceAlarms: [] } }) {
    return (url: string): unknown => {
      if (url.endsWith('/rest/province')) return [{ code: 'ABJ', name: '北京市' }];
      if (url.includes('/rest/province/ABJ')) return [{ code: 'Wqsps', province: '北京市', city: '北京' }];
      if (url.includes('/rest/weather')) return { msg: 'success', code: 0, data: weatherPayload };
      if (url.includes('/rest/findAlarm')) return alerts;
      throw new Error(`unexpected url: ${url}`);
    };
  }

  it('解析实况、逐日未来和站点预警', async () => {
    const alertPayload = {
      data: {
        page: {
          list: [
            {
              alertid: 'bj1',
              title: '北京市气象台发布暴雨蓝色预警',
              issuetime: '2026/11/02 20:38',
              url: '/publish/alarm/bj1.html',
            },
            {
              alertid: 'sh1',
              title: '上海市气象台发布大风黄色预警',
              issuetime: '2026/11/02 20:00',
              url: '/publish/alarm/sh1.html',
            },
          ],
        },
        provinceAlarms: [],
      },
    };
    const snapshot = await fetchNmc(
      makeRequest({ provider: 'nmc', province: '北京市', city: '北京' }, fetcherWith(weather, alertPayload)),
    );

    expect(snapshot.provider).toBe('nmc');
    expect(snapshot.timezone).toBe(TZ);
    expect(snapshot.capabilities).toEqual({ now: true, forecast: true, hourly: false, alerts: true });
    expect(snapshot.now).toMatchObject({
      condition: '晴',
      temperatureC: 8.5,
      feelsLikeC: 7.4,
      humidityPct: 67,
      windDir: '西南风',
      windScale: '微风',
      aqi: 91,
      aqiText: '良',
    });
    expect(snapshot.publishedAtMs).toBe(Date.parse('2026-11-02T20:15:00+08:00'));
    expect(snapshot.horizons).toHaveLength(5);
    expect(snapshot.horizons[0]).toMatchObject({ hours: 1, granularity: 'day', condition: '晴', temperatureC: 3 });
    expect(snapshot.horizons[3]).toMatchObject({
      hours: 24,
      granularity: 'day',
      condition: '多云',
      temperatureC: 5,
      temperatureMinC: 5,
      temperatureMaxC: 19,
    });
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]).toMatchObject({ id: 'bj1', type: '暴雨', level: '蓝色' });
    expect(snapshot.limitations.join('')).toContain('逐日预报');
  });

  it('显式填了城市代码就不查省市列表', async () => {
    let provinceCalls = 0;
    const snapshot = await fetchNmc(
      makeRequest({ provider: 'nmc', province: '北京市', city: '北京', nmcStationId: 'Wqsps' }, (url) => {
        if (url.includes('/rest/province')) provinceCalls += 1;
        if (url.includes('/rest/weather')) return { data: weather };
        if (url.includes('/rest/findAlarm')) return { data: { page: { list: [] } } };
        return {};
      }),
    );
    expect(provinceCalls).toBe(0);
    expect(snapshot.location.stationId).toBe('Wqsps');
  });
});

describe('接口盒子适配器', () => {
  const payload = fixture<Record<string, unknown>>('apihz.json');

  it('解析实况与 3 小时粒度时段预报，并按需带上 ID/KEY', async () => {
    let seen = '';
    const snapshot = await fetchApihz(
      makeRequest({ provider: 'apihz', apihzId: '123', apihzKey: 'abc', province: '甘肃', city: '兰州' }, (url) => {
        seen = url;
        return payload;
      }),
    );
    expect(seen).toContain('id=123');
    expect(seen).toContain('key=abc');
    expect(seen).toContain('hourtype=1');
    expect(snapshot.now).toMatchObject({ temperatureC: 6.2, feelsLikeC: 4.9, humidityPct: 53 });
    expect(snapshot.horizons).toHaveLength(5);
    expect(snapshot.horizons[0].granularity).toBe('3h');
    expect(snapshot.limitations.join('')).toContain('3 小时');
  });

  it('识别 alarm 里的本地预警', async () => {
    const withAlarm = clone(payload);
    withAlarm.alarm = [
      {
        title: '兰州市气象台发布大风蓝色预警',
        signaltype: '大风',
        signallevel: '蓝色',
        issuetime: '2026/11/02 20:00',
      },
    ];
    const snapshot = await fetchApihz(
      makeRequest({ provider: 'apihz', apihzId: '123', apihzKey: 'abc', province: '甘肃', city: '兰州' }, () => withAlarm),
    );
    expect(snapshot.alerts[0]).toMatchObject({ type: '大风', level: '蓝色' });
  });

  it('区县名返回 400 时退到地级市', async () => {
    const nanning = clone(payload);
    nanning.sheng = '广西';
    nanning.shi = '南宁';
    nanning.name = '南宁';
    const seen: string[] = [];
    const snapshot = await fetchApihz(
      makeRequest(
        {
          provider: 'apihz',
          apihzId: '123',
          apihzKey: 'abc',
          province: '广西壮族自治区',
          city: '南宁市武鸣区',
        },
        (url) => {
          seen.push(url);
          return seen.length === 1 ? { code: 400, msg: '地区不存在' } : nanning;
        },
      ),
    );
    expect(seen).toHaveLength(2);
    expect(decodeURIComponent(seen[1])).toContain('place=南宁市');
    expect(snapshot.now?.temperatureC).toBe(6.2);
    expect(snapshot.limitations.join('')).toContain('南宁市');
  });
});

describe('腾讯天气适配器', () => {
  it('解析实况、逐小时与 8 天逐日', async () => {
    const payload = fixture<Record<string, unknown>>('tencent.json');
    const snapshot = await fetchTencent(
      makeRequest({ provider: 'tencent', province: '北京市', city: '北京' }, () => payload),
    );
    expect(snapshot.now).toMatchObject({
      condition: '晴',
      temperatureC: 8,
      humidityPct: 66,
      pressureHpa: 1016,
      windDir: '北风',
      windScale: '1-3',
    });
    expect(snapshot.horizons).toHaveLength(5);
    expect(snapshot.horizons[0].granularity).toBe('hour');
    expect(snapshot.horizons[4].granularity).toBe('day');
    expect(snapshot.publishedAtMs).toBe(Date.parse('2026-11-02T20:30:00+08:00'));
  });

  it('区县名没有要素时退到地级市重试', async () => {
    const payload = fixture<Record<string, unknown>>('tencent.json');
    const empty = { status: 200, message: 'OK', data: { observe: null, forecast_1h: {}, forecast_24h: {}, alarm: [] } };
    let calls = 0;
    const snapshot = await fetchTencent(
      makeRequest(
        { provider: 'tencent', province: '广西壮族自治区', city: '南宁市武鸣区' },
        () => {
          calls += 1;
          return calls === 1 ? empty : payload;
        },
      ),
    );
    expect(calls).toBe(2);
    expect(snapshot.now?.temperatureC).toBe(8);
    expect(snapshot.limitations.join('')).toContain('地级市');
  });
});

describe('Open-Meteo 适配器', () => {
  it('解析实况与逐小时，并明确没有预警', async () => {
    const payload = fixture<Record<string, unknown>>('openmeteo.json');
    const snapshot = await fetchOpenMeteo(makeRequest({ provider: 'openmeteo', autoGeocode: false }, () => payload));
    expect(snapshot.now).toMatchObject({
      condition: '晴',
      temperatureC: 11,
      feelsLikeC: 8.5,
      humidityPct: 60,
      windSpeedMps: 6,
      windDir: '西南风',
    });
    expect(snapshot.horizons).toHaveLength(5);
    expect(snapshot.horizons[0].granularity).toBe('hour');
    expect(snapshot.capabilities.alerts).toBe(false);
    expect(snapshot.alertsNote).toContain('不提供天气预警');
  });
});

describe('和风天气适配器', () => {
  it('解析实况、72 小时逐时和预警等级', async () => {
    const hourly = Array.from({ length: 72 }, (_, index) => ({
      fxTime: new Date(NOW + index * 3_600_000).toISOString(),
      temp: String(9 + index / 10),
      text: '晴',
      windDir: '东风',
      windScale: '2',
      windSpeed: '9',
      humidity: '50',
      pop: '10',
      precip: '0',
      pressure: '1010',
    }));
    const urls: string[] = [];
    const snapshot = await fetchQWeather(
      makeRequest(
        {
          provider: 'qweather',
          qweatherKey: 'k',
          qweatherHost: 'https://abc.re.qweatherapi.com',
          autoGeocode: false,
        },
        (url) => {
        urls.push(url);
        if (url.includes('/weather/now')) {
          return {
            code: '200',
            now: {
              obsTime: '2026-11-02T20:40+08:00',
              temp: '9',
              feelsLike: '7',
              text: '多云',
              windDir: '东风',
              windScale: '2',
              windSpeed: '9',
              humidity: '55',
              precip: '0',
              pressure: '1010',
              vis: '15',
            },
          };
        }
        if (url.includes('/weather/72h')) return { code: '200', hourly };
        if (url.includes('/warning/now')) {
          return {
            code: '200',
            warning: [
              {
                id: 'w1',
                title: '北京市气象台发布暴雨橙色预警',
                typeName: '暴雨',
                severityColor: 'Orange',
                pubTime: '2026-11-02T20:00+08:00',
                endTime: '2026-11-02T23:00+08:00',
                text: '注意防范',
                sender: '北京市气象台',
              },
            ],
          };
        }
        throw new Error(`unexpected url: ${url}`);
      }),
    );
    expect(urls.some((url) => url.startsWith('https://abc.re.qweatherapi.com/v7/weather/now'))).toBe(true);
    expect(urls.some((url) => decodeURIComponent(url).includes('location=116.41,39.90'))).toBe(true);
    expect(urls.every((url) => url.includes('key=k'))).toBe(true);
    expect(snapshot.now).toMatchObject({ condition: '多云', temperatureC: 9, feelsLikeC: 7, humidityPct: 55 });
    expect(snapshot.horizons).toHaveLength(5);
    expect(snapshot.alerts[0]).toMatchObject({ type: '暴雨', level: '橙色' });
  });
});

describe('Pirate Weather 适配器', () => {
  it('解析 Dark Sky 结构并把英文预警归一化', async () => {
    const hourly = Array.from({ length: 50 }, (_, index) => ({
      time: NOW / 1000 + index * 3_600,
      summary: 'Clear',
      icon: 'clear-night',
      temperature: 10,
      precipProbability: 0.1,
      precipIntensity: 0,
      windSpeed: 3,
      windBearing: 180,
      humidity: 0.5,
    }));
    const daily = Array.from({ length: 3 }, (_, index) => ({
      time: NOW / 1000 + index * 86_400,
      icon: 'clear-day',
      temperatureMin: 4,
      temperatureMax: 16,
      precipAccumulation: 0,
    }));
    const payload = {
      currently: {
        time: NOW / 1000,
        summary: 'Clear',
        icon: 'clear-night',
        temperature: 10,
        apparentTemperature: 8,
        humidity: 0.5,
        pressure: 1010,
        precipIntensity: 0,
        windSpeed: 3,
        windBearing: 180,
        visibility: 10,
      },
      hourly: { data: hourly },
      daily: { data: daily },
      alerts: [
        {
          title: 'Heat Advisory',
          severity: 'Severe',
          time: NOW / 1000,
          expires: NOW / 1000 + 7_200,
          description: 'Hot',
          uri: 'https://example.com/alert',
        },
      ],
    };
    const snapshot = await fetchPirate(
      makeRequest({ provider: 'pirate', pirateWeatherKey: 'k', autoGeocode: false }, () => payload),
    );
    expect(snapshot.now).toMatchObject({ temperatureC: 10, feelsLikeC: 8, humidityPct: 50, windDir: '南风' });
    expect(snapshot.horizons).toHaveLength(5);
    expect(snapshot.alerts[0]).toMatchObject({ type: '高温', level: '橙色' });
  });
});

describe('中国气象数据网适配器', () => {
  const rows = [
    { Station_Id_C: '54511', Year: 2026, Mon: 11, Day: 2, Hour: 11, TEM: '4.1', RHU: '45', PRE_1h: '0', PRS: '1014' },
    {
      Station_Id_C: '54511',
      Year: 2026,
      Mon: 11,
      Day: 2,
      Hour: 12,
      TEM: '5.2',
      RHU: '40',
      PRE_1h: '0.5',
      PRS: '1015',
      WIN_S_Inst_Max: '3',
      WIN_D_Inst_Max: '270',
    },
  ];

  it('解析旧版 userId + pwd 观测接口，并说明没有预报', async () => {
    let seen = '';
    const snapshot = await fetchCma(
      makeRequest(
        { provider: 'cma', cmaUserId: 'u', cmaApiKey: 'p', cmaStationId: '54511' },
        (url) => {
          seen = url;
          return { returnCode: '0', data: rows };
        },
      ),
    );
    expect(seen).toContain('userId=u');
    expect(seen).toContain('pwd=p');
    expect(seen).toContain('timeRange=');
    expect(snapshot.now).toMatchObject({
      temperatureC: 5.2,
      humidityPct: 40,
      pressureHpa: 1015,
      precipitationMm: 0.5,
      windDir: '西风',
      windSpeedMps: 3,
    });
    expect(snapshot.capabilities).toEqual({ now: true, forecast: false, hourly: false, alerts: false });
    expect(snapshot.limitations.join('')).toContain('观测资料');
  });

  it('新版 key 接口会自动改用 SURF_CHN_HOR', async () => {
    let seen = '';
    const snapshot = await fetchCma(
      makeRequest(
        { provider: 'cma', cmaUserId: '', cmaApiKey: 'new-key', cmaStationId: '54511' },
        (url) => {
          seen = url;
          return { returnCode: '0', DS: rows };
        },
      ),
    );
    expect(seen).toContain('key=new-key');
    expect(seen).toContain('data=SURF_CHN_HOR');
    expect(snapshot.now?.temperatureC).toBe(5.2);
  });

  it('订单没订某些要素时自动退到最小要素集合', async () => {
    let calls = 0;
    const snapshot = await fetchCma(
      makeRequest(
        { provider: 'cma', cmaUserId: 'u', cmaApiKey: 'p', cmaStationId: '54511' },
        () => {
          calls += 1;
          return calls === 1
            ? { returnCode: '-1', returnMessage: '您没有该要素的权限' }
            : { returnCode: '0', data: rows };
        },
      ),
    );
    expect(calls).toBe(2);
    expect(snapshot.now?.temperatureC).toBe(5.2);
  });
});

describe('凭证与预警归一化', () => {
  it('缺凭证会指向对应注册页', () => {
    expect(credentialIssue({ ...WEATHER_DEFAULTS, provider: 'apihz' }, () => '')).toContain('apihz.cn');
    expect(credentialIssue({ ...WEATHER_DEFAULTS, provider: 'qweather' }, () => '')).toContain('qweather.com');
    expect(credentialIssue({ ...WEATHER_DEFAULTS, provider: 'pirate' }, () => '')).toContain('pirateweather.net');
    expect(credentialIssue({ ...WEATHER_DEFAULTS, provider: 'cma' }, () => '')).toContain('data.cma.cn');
    expect(
      credentialIssue({ ...WEATHER_DEFAULTS, provider: 'cma', cmaUserId: 'u', cmaApiKey: '' }, () => ''),
    ).toContain('缺密钥');
  });

  it('需要密钥的适配器在缺凭证时不会发请求', async () => {
    await expect(fetchQWeather(makeRequest({ provider: 'qweather' }, () => null))).rejects.toThrow(/qweather/);
    await expect(fetchApihz(makeRequest({ provider: 'apihz' }, () => null))).rejects.toThrow(/apihz/);
    await expect(fetchPirate(makeRequest({ provider: 'pirate' }, () => null))).rejects.toThrow(/pirateweather/);
  });

  it('经纬度越界会在激活前被拦下', () => {
    expect(preflightIssue({ ...WEATHER_DEFAULTS, provider: 'openmeteo', latitude: 91 }, () => '')).toBeNull();
    expect(
      preflightIssue({ ...WEATHER_DEFAULTS, provider: 'openmeteo', autoGeocode: false, latitude: 91 }, () => ''),
    ).toContain('纬度');
    expect(
      preflightIssue({ ...WEATHER_DEFAULTS, provider: 'openmeteo', autoGeocode: false, longitude: 181 }, () => ''),
    ).toContain('经度');
  });

  it('英文严重度与中文等级对齐', () => {
    expect(levelFrom('Minor')).toBe('蓝色');
    expect(levelFrom('Moderate')).toBe('黄色');
    expect(levelFrom('Severe')).toBe('橙色');
    expect(levelFrom('Extreme')).toBe('红色');
    expect(typeFrom(undefined, 'Heat Advisory')).toBe('高温');
    expect(typeFrom(undefined, 'Thunderstorm Warning')).toBe('雷电');
  });
});

describe('配置里多打的空格', () => {
  function request(overrides: Partial<WeatherConfigSection>, fetcher: (url: string) => unknown): ProviderRequest {
    const cfg = { ...WEATHER_DEFAULTS, ...overrides };
    return {
      cfg,
      sections: normalizeSections(cfg),
      timezone: TZ,
      nowMs: NOW,
      secret: () => '',
      fetchJson: async <T>(url: string): Promise<T> => (await fetcher(url)) as T,
    };
  }

  it('地名查找与报错文案都用去掉首尾空白的写法', async () => {
    const seen: string[] = [];
    const req = request({ provider: 'nmc', province: '　北京市 ', city: '不存在的城市 ' }, (url) => {
      seen.push(url);
      if (url.endsWith('/rest/province')) return [{ code: 'ABJ', name: '北京市' }];
      if (url.includes('/rest/province/ABJ')) return [{ code: 'Wqsps', province: '北京市', city: '北京' }];
      throw new Error(`unexpected url: ${url}`);
    });
    await expect(fetchWeather(req)).rejects.toThrow('中央气象台没有找到「北京市 / 不存在的城市」对应的城市');
    expect(seen[1]).toContain('/rest/province/ABJ');
  });

  it('自动解析经纬度的报错里也不留空格', async () => {
    const req = request({ provider: 'openmeteo', province: '上海市 ', city: '不存在的地方 ' }, () => ({ results: [] }));
    await expect(fetchWeather(req)).rejects.toThrow('无法根据「上海市 不存在的地方」自动获取经纬度');
  });
});
