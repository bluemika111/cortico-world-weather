import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { WEATHER } from '../src/definition.ts';
import { WEATHER_DEFAULTS, type WeatherConfigSection } from '../src/config.ts';
import { preflightIssue } from '../src/credentials.ts';
import { WeatherWorld } from '../src/world.ts';
import type { WeatherSnapshot } from '../src/types.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { alert, BASE_CFG, makeSnapshot, NOW } from './helpers/snapshot.ts';

let scratchDir: string;
beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'weather-world-'));
});
afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function makeWorld(
  cfg: Partial<WeatherConfigSection>,
  snapshots: WeatherSnapshot[],
  secrets: Record<string, string> = {},
): WeatherWorld {
  let calls = 0;
  return new WeatherWorld({
    cfg: { ...BASE_CFG, ...cfg },
    timezone: 'Asia/Shanghai',
    now: () => NOW,
    secret: (name) => secrets[name] ?? '',
    fetchSnapshot: async () => snapshots[Math.min(calls++, snapshots.length - 1)],
  });
}

async function refresh(world: WeatherWorld, host: FakeHost, times = 1): Promise<void> {
  await world.start(host);
  for (let index = 0; index < times; index += 1) await world.refreshNow();
  await world.stop();
}

describe('Weather World', () => {
  it('干装载不报失败：装载器会接受它', async () => {
    const report = await dryMountWorld(WEATHER, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('默认给出三个工具、配置组与环境提示词', () => {
    const world = WEATHER.create(fakeWorldContext(WEATHER, { scratchDir }));
    expect(world.tools().map((tool) => tool.name)).toEqual([
      'weather_now',
      'weather_forecast',
      'weather_alerts',
    ]);
    expect(world.envPromptVars()).toEqual({});
    const webUi = world.webUi!('zh');
    expect(webUi.config?.map((group) => group.id)).toEqual(['world:weather']);
    expect(webUi.promptDocs?.map((doc) => doc.role)).toEqual(['envPrompt']);
  });

  it('启动时投递现在、未来和预警；预警立即投递', async () => {
    const world = makeWorld({}, [makeSnapshot({ alerts: [alert()] })]);
    const host = new FakeHost();
    await refresh(world, host);

    expect(host.events.map((event) => event.type)).toEqual([
      'weather.now',
      'weather.forecast',
      'weather.alert',
    ]);
    expect(host.pushOpts[0]?.trigger).toBe('piggyback');
    expect(host.pushOpts[1]?.trigger).toBe('piggyback');
    expect(host.pushOpts[2]?.trigger).toBe('flush');
    expect(host.events[0].text).toContain('现在天气（北京）');
    expect(host.events[1].text).toContain('未来天气（北京）');
    expect(host.events[2].text).toContain('蓝色·暴雨');
    expect(host.events[0].source).toBe('weather');
    // 正文里的天气现象、预警标题都来自数据源，必须按外部事件框定投递。
    expect(host.events.every((event) => event.origin === 'external')).toBe(true);
  });

  it('简略只影响投递的事件，工具回执仍写全要素', async () => {
    const world = makeWorld({ nowDetail: 'brief', forecastDetail: 'brief' }, [makeSnapshot()]);
    const host = new FakeHost();
    await refresh(world, host);
    const now = host.events.find((event) => event.type === 'weather.now')!;
    expect(now.text).toContain('- 气温：11°C');
    expect(now.text).not.toContain('湿度');
    expect(now.text).not.toContain('体感');

    const tool = world.tools().find((item) => item.name === 'weather_now')!;
    expect(String(await tool.handler({}, {} as ToolCallContext))).toContain('湿度：60%');
  });

  it('关掉的时次不再投递，weather_forecast 也只返回剩下的时次', async () => {
    const world = makeWorld({ horizon1h: false, horizon6h: false, horizon12h: false, horizon48h: false }, [makeSnapshot()]);
    const host = new FakeHost();
    await refresh(world, host);
    const forecast = host.events.find((event) => event.type === 'weather.forecast')!;
    expect(forecast.text).toContain('24 小时后');
    expect(forecast.text).not.toContain('1 小时后');
    expect(forecast.text).not.toContain('48 小时后');

    const tool = world.tools().find((item) => item.name === 'weather_forecast')!;
    const receipt = String(await tool.handler({}, {} as ToolCallContext));
    expect(receipt).toContain('24 小时后');
    expect(receipt).not.toContain('12 小时后');
  });

  it('五个时次全关时自动保留 24 小时并说明', async () => {
    const world = makeWorld(
      { horizon1h: false, horizon6h: false, horizon12h: false, horizon24h: false, horizon48h: false },
      [makeSnapshot()],
    );
    const host = new FakeHost();
    await refresh(world, host);
    const forecast = host.events.find((event) => event.type === 'weather.forecast')!;
    expect(forecast.text).toContain('24 小时后');
    expect(host.warnings.join('\n')).toContain('已自动保留「24 小时后」');
  });

  it('面板状态带详略与逐时次开关', async () => {
    const world = makeWorld({ nowDetail: 'brief', forecastDetail: 'detailed', horizon48h: false }, [makeSnapshot()]);
    const state = (await world.webUi!('zh').invoke!('settings', 'state', [])) as Record<string, unknown>;
    expect(state).toMatchObject({
      nowDetail: 'brief',
      forecastDetail: 'detailed',
      horizon1h: true,
      horizon48h: false,
      horizonHours: [1, 6, 12, 24],
      horizonsCoerced: false,
    });
    expect(world.webUi!('zh').badges?.map((badge) => badge.value)).toContain('1/6/12/24 h');
  });

  it('只开未来天气时只投递未来天气，工具也只留一个', async () => {
    const world = makeWorld({ showNow: false, showForecast: true, showAlerts: false }, [makeSnapshot()]);
    const host = new FakeHost();
    await refresh(world, host);
    expect(host.events.map((event) => event.type)).toEqual(['weather.forecast']);
    expect(world.tools().map((tool) => tool.name)).toEqual(['weather_forecast']);
  });

  it('三项全关时自动保留现在天气', async () => {
    const world = makeWorld({ showNow: false, showForecast: false, showAlerts: false }, [makeSnapshot()]);
    const host = new FakeHost();
    await refresh(world, host);
    expect(host.events.map((event) => event.type)).toEqual(['weather.now']);
    expect(host.warnings.join('\n')).toContain('已自动保留「现在天气」');
    expect(world.tools().map((tool) => tool.name)).toEqual(['weather_now']);
  });

  it('预警没有变化时不重复投递', async () => {
    const same = makeSnapshot({ alerts: [alert()] });
    const changed = makeSnapshot({
      alerts: [alert({ id: 'a2', level: '橙色', title: '北京市气象台发布暴雨橙色预警' })],
    });
    const world = makeWorld({}, [same, same, changed]);
    const host = new FakeHost();
    await refresh(world, host, 3);

    const alerts = host.events.filter((event) => event.type === 'weather.alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0].text).toContain('蓝色·暴雨');
    expect(alerts[1].text).toContain('橙色·暴雨');
  });

  it('新一条现在/未来天气会撤回上一条未投递的同类型事件', async () => {
    const world = makeWorld({}, [makeSnapshot(), makeSnapshot()]);
    const host = new FakeHost();
    await refresh(world, host, 2);
    expect(host.withdrawn).toEqual([1, 2]);
  });

  it('数据源没有预警能力时不伪造预警', async () => {
    const world = makeWorld(
      {},
      [
        makeSnapshot({
          capabilities: { now: true, forecast: true, hourly: true, alerts: false },
          alertsNote: 'Open-Meteo 的公开预报接口不提供天气预警。',
        }),
      ],
    );
    const host = new FakeHost();
    await refresh(world, host);
    expect(host.events.map((event) => event.type)).toEqual(['weather.now', 'weather.forecast']);
    expect(host.warnings.join('\n')).toContain('不提供天气预警');
    const tool = world.tools().find((item) => item.name === 'weather_alerts')!;
    expect(await tool.handler({}, {} as ToolCallContext)).toContain('不提供天气预警');
  });

  it('取数失败时工具给出失败回执，不抛到模型', async () => {
    const world = new WeatherWorld({
      cfg: { ...BASE_CFG, provider: 'qweather', qweatherKey: '' },
      timezone: 'Asia/Shanghai',
      now: () => NOW,
      secret: () => '',
      fetchSnapshot: async () => {
        throw new Error('和风天气需要先注册：https://dev.qweather.com/');
      },
    });
    const host = new FakeHost();
    await world.start(host);
    await world.refreshNow();
    const tool = world.tools()[0];
    const result = await tool.handler({}, {} as ToolCallContext);
    await world.stop();

    expect(result).toMatchObject({ failed: true });
    expect(String((result as { text?: string }).text)).toContain('天气数据获取失败');
    expect(host.warnings.join('\n')).toContain('天气刷新失败');
  });

  it('激活前会提示缺少的凭证', () => {
    const ctx = fakeWorldContext(WEATHER, { scratchDir });
    expect(() => WEATHER.preflight!(ctx)).not.toThrow();
    ctx.cfg.provider = 'apihz';
    expect(() => WEATHER.preflight!(ctx)).toThrow(/apihz\.cn/);
    ctx.cfg.provider = 'openmeteo';
    ctx.cfg.autoGeocode = false;
    ctx.cfg.latitude = 120;
    expect(() => WEATHER.preflight!(ctx)).toThrow(/纬度/);
  });

  it('面板能读到上一次获取的数据，也能手动刷新', async () => {
    const world = makeWorld({}, [makeSnapshot()]);
    const host = new FakeHost();
    await world.start(host);
    await world.refreshNow();
    const webUi = world.webUi!('zh');
    const preview = (await webUi.invoke!('settings', 'preview', [])) as {
      available: boolean;
      fetchedAt: string | null;
      now: string | null;
      forecast: string | null;
      alerts: string | null;
      error: string | null;
    };
    expect(preview.available).toBe(true);
    expect(preview.fetchedAt).toBe('2026-11-02 20:45');
    expect(preview.now).toContain('现在天气（北京）');
    expect(preview.forecast).toContain('未来天气（北京）');
    expect(preview.alerts).toContain('当前没有生效中的天气预警');
    expect(preview.error).toBeNull();

    const refreshed = (await webUi.invoke!('settings', 'refresh', [])) as { available: boolean };
    expect(refreshed.available).toBe(true);
    await world.stop();
  });

  it('自动解析的经纬度会写回配置', async () => {
    let patch: Partial<WeatherConfigSection> | undefined;
    const cfg: WeatherConfigSection = { ...BASE_CFG, autoGeocode: true };
    const world = new WeatherWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      now: () => NOW,
      secret: () => '',
      persist: (next) => {
        patch = next;
      },
      fetchSnapshot: async () =>
        makeSnapshot({
          location: {
            province: '广西壮族自治区',
            city: '南宁市武鸣区',
            latitude: 23.15,
            longitude: 108.27,
          },
        }),
    });
    const host = new FakeHost();
    await world.start(host);
    await world.refreshNow();
    await world.stop();
    expect(patch).toEqual({ latitude: 23.15, longitude: 108.27 });
  });

  it('面板状态反映有效开关与强制恢复', async () => {
    const world = makeWorld({ showNow: false, showForecast: false, showAlerts: false }, [makeSnapshot()]);
    const webUi = world.webUi!('zh');
    expect(webUi.panels?.map((panel) => panel.id)).toEqual(['settings']);
    const state = await webUi.invoke!('settings', 'state', []);
    expect(state).toMatchObject({
      showNow: true,
      showForecast: false,
      showAlerts: false,
      coerced: true,
      location: '北京',
      interval: 6,
    });
    await expect(webUi.invoke!('settings', 'unknown', [])).rejects.toThrow(/未知方法/);
  });

  it('环境变量可以补上配置里没填的密钥', () => {
    const cfg = { ...WEATHER_DEFAULTS, provider: 'qweather' as const, qweatherKey: '' };
    expect(preflightIssue(cfg, () => '')).toMatch(/dev\.qweather\.com/);
    expect(preflightIssue(cfg, (name) => (name === 'WEATHER_QWEATHER_KEY' ? 'from-env' : ''))).toBeNull();
  });
});

describe('取数与每晚推送的排程', () => {
  function worldWith(
    cfg: Partial<WeatherConfigSection>,
    snapshot: () => WeatherSnapshot,
  ): WeatherWorld {
    return new WeatherWorld({
      cfg: { ...BASE_CFG, ...cfg },
      timezone: 'Asia/Shanghai',
      fetchSnapshot: async () => snapshot(),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('取数排在从 00:00 起算的时次，不是从上一次取数往后推', async () => {
    vi.setSystemTime(new Date(Date.parse('2026-11-02T19:59:30+08:00')));
    let calls = 0;
    const world = worldWith({ requestEvery: 6 }, () => {
      calls += 1;
      return makeSnapshot();
    });
    const host = new FakeHost();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);

    // 00:00 到时才再取一次；此后到 06:00 之前不会再取。
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5 * 3_600_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1 * 3_600_000);
    expect(calls).toBe(3);
    expect(host.events.some((event) => event.type === 'weather.next_day')).toBe(false);
    await world.stop();
  });

  it('改请求间隔会重新排时次', async () => {
    vi.setSystemTime(new Date(Date.parse('2026-11-02T19:59:30+08:00')));
    let calls = 0;
    const cfg: WeatherConfigSection = { ...BASE_CFG, requestEvery: 6 };
    const world = new WeatherWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      fetchSnapshot: async () => {
        calls += 1;
        return makeSnapshot();
      },
    });
    const host = new FakeHost();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(1);
    cfg.requestEvery = 1;
    // 间隔一改就重新排：下一个时次是 21:00，而不是原来的 00:00。
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(calls).toBe(2);
    await world.stop();
  });

  it('打开每晚推送后到点递来明天天气与当前预警，一天只递一次', async () => {
    vi.setSystemTime(new Date(Date.parse('2026-11-02T19:59:30+08:00')));
    let calls = 0;
    const world = worldWith({ nightlyPush: true, nightlyPushTime: '20:00' }, () => {
      calls += 1;
      return makeSnapshot({
        daily: [{ date: '2026-11-03', dayText: '多云', nightText: '小雨', dayTempC: 20, nightTempC: 12 }],
        alerts: [alert()],
      });
    });
    const host = new FakeHost();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(90_000);

    const nightly = host.events.filter((event) => event.type === 'weather.next_day');
    expect(nightly).toHaveLength(1);
    expect(nightly[0].text).toContain('明天天气（北京，11月03日）：');
    expect(nightly[0].text).toContain('- 天气：白天多云，夜间小雨');
    expect(nightly[0].text).toContain('蓝色·暴雨');
    expect(nightly[0].meta).toMatchObject({ nightly: true, date: '2026-11-03' });
    const index = host.events.indexOf(nightly[0]);
    expect(host.pushOpts[index]?.trigger).toBe('flush');
    // 刚取过数据，每晚推送不再额外请求互联网。
    expect(calls).toBe(1);
    expect(host.events.filter((event) => event.type === 'weather.now')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20 * 3_600_000);
    expect(host.events.filter((event) => event.type === 'weather.next_day')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(host.events.filter((event) => event.type === 'weather.next_day')).toHaveLength(2);
    await world.stop();
  });

  it('每晚推送的明天天气跟随未来天气的详略', async () => {
    vi.setSystemTime(new Date(Date.parse('2026-11-02T19:59:30+08:00')));
    const world = worldWith({ nightlyPush: true, forecastDetail: 'brief' }, () =>
      makeSnapshot({
        daily: [
          {
            date: '2026-11-03',
            dayText: '多云',
            dayTempC: 20,
            precipitationMm: 4,
            precipitationProbabilityPct: 60,
            dayWindDir: '东北风',
          },
        ],
      }),
    );
    const host = new FakeHost();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(90_000);
    const nightly = host.events.filter((event) => event.type === 'weather.next_day');
    expect(nightly).toHaveLength(1);
    expect(nightly[0].text).toContain('- 降水概率：60%');
    expect(nightly[0].text).not.toContain('东北风');
    expect(nightly[0].text).not.toContain('- 降水：');
    await world.stop();
  });

  it('未来天气和天气预警都关着时，每晚推送说明没有内容', async () => {
    vi.setSystemTime(new Date(Date.parse('2026-11-02T19:59:30+08:00')));
    const world = worldWith(
      { nightlyPush: true, nightlyPushTime: '20:00', showNow: true, showForecast: false, showAlerts: false },
      () => makeSnapshot(),
    );
    const host = new FakeHost();
    await world.start(host);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(host.events.map((event) => event.type)).toEqual(['weather.now']);
    expect(host.warnings.join(' | ')).toContain('每晚推送');
    await world.stop();
  });

  it('面板能读到每晚推送与下次取数时间', async () => {
    const cfg: WeatherConfigSection = { ...BASE_CFG, nightlyPush: true, nightlyPushTime: '21:15' };
    const world = new WeatherWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      now: () => NOW,
      fetchSnapshot: async () => makeSnapshot(),
    });
    const host = new FakeHost();
    await world.start(host);
    const webUi = world.webUi!('zh');
    expect(webUi.badges?.map((badge) => badge.value)).toContain('21:15');
    const state = (await webUi.invoke!('settings', 'state', [])) as Record<string, unknown>;
    expect(state).toMatchObject({ nightlyPush: true, nightlyPushTime: '21:15', nextFetchAt: '2026-11-03 00:00' });
    expect(webUi.badges?.map((badge) => badge.value)).toContain('00:00 起每 6 小时');
    await world.stop();
  });
});
