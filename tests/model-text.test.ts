import { describe, expect, it } from 'vitest';
import { renderAlerts, renderForecast, renderNextDay, renderNow, renderWeatherError } from '../src/model-text.ts';
import { alert, makeSnapshot, NOW } from './helpers/snapshot.ts';
import { normalizeSections } from '../src/config.ts';

describe('交给模型的正文', () => {
  it('现在天气带要素、发布时间和数据源', () => {
    const text = renderNow(makeSnapshot());
    expect(text).toContain('现在天气（北京）');
    expect(text).toContain('天气：晴');
    expect(text).toContain('气温：11°C（体感 8.5°C）');
    expect(text).toContain('湿度：60%');
    expect(text).toContain('南风');
    expect(text).toContain('数据源：Open-Meteo');
    expect(text).toContain('2026-11-02 20:45');
  });

  it('未来天气列出五个时次并注明逐小时', () => {
    const text = renderForecast(makeSnapshot());
    expect(text).toContain('1 小时后');
    expect(text).toContain('48 小时后');
    expect(text.match(/（逐小时/g)).toHaveLength(5);
    expect(text).toContain('数据源：Open-Meteo');
  });

  it('逐日源会解释取值方式', () => {
    const snapshot = makeSnapshot({
      horizons: [1, 6, 12, 24, 48].map((hours) => ({
        hours: hours as 1 | 6 | 12 | 24 | 48,
        targetMs: NOW + hours * 3_600_000,
        condition: '晴',
        temperatureC: 9,
        granularity: 'day' as const,
        note: '逐日预报：按目标时刻所属的白天时段取值。',
      })),
    });
    const text = renderForecast(snapshot);
    expect(text).toContain('（逐日）');
    expect(text).toContain('该源只提供逐日预报');
  });

  it('混合精度会说明超出逐小时范围的部分', () => {
    const snapshot = makeSnapshot({
      horizons: [1, 6, 12, 24, 48].map((hours) => ({
        hours: hours as 1 | 6 | 12 | 24 | 48,
        targetMs: NOW + hours * 3_600_000,
        condition: '晴',
        temperatureC: 9,
        granularity: (hours === 48 ? 'day' : 'hour') as 'day' | 'hour',
      })),
    });
    const text = renderForecast(snapshot);
    expect(text).toContain('超出逐小时范围');
    expect(text).not.toContain('该源只提供逐日预报');
  });

  it('预警统一成中央气象台体系', () => {
    const text = renderAlerts(makeSnapshot({ alerts: [alert()] }));
    expect(text).toContain('天气预警（北京，中央气象台体系）');
    expect(text).toContain('蓝色·暴雨');
    expect(text).toContain('共 1 条生效中');
    expect(text).toContain('蓝/黄/橙/红');
  });

  it('没有预警与没有预警能力是两句话', () => {
    expect(renderAlerts(makeSnapshot())).toContain('当前没有生效中的天气预警');
    const disabled = renderAlerts(
      makeSnapshot({
        capabilities: { now: true, forecast: true, hourly: true, alerts: false },
        alertsNote: 'Open-Meteo 的公开预报接口不提供天气预警。',
      }),
    );
    expect(disabled).toContain('不提供天气预警');
    expect(disabled).not.toContain('当前没有生效中');
  });

  it('错误正文带原因', () => {
    expect(renderWeatherError('请求超时')).toBe('天气数据获取失败：请求超时');
  });

  it('简略的现在天气只写天气与气温，不含体感', () => {
    const text = renderNow(makeSnapshot(), 'brief');
    expect(text).toContain('- 天气：晴');
    expect(text).toContain('- 气温：11°C');
    expect(text).not.toContain('体感');
    expect(text).not.toContain('湿度');
    expect(text).not.toContain('南风');
    expect(text).toContain('数据源：Open-Meteo');
  });

  it('简略的未来天气写天气、气温与降水概率，不写降水量和风', () => {
    const snapshot = makeSnapshot({
      horizons: [1, 24].map((hours) => ({
        hours: hours as 1 | 24,
        targetMs: NOW + hours * 3_600_000,
        condition: '小雨',
        temperatureC: 9,
        precipitationMm: 3.2,
        precipitationProbabilityPct: 70,
        windDir: '北风',
        windScale: '5级',
        granularity: 'hour' as const,
      })),
    });
    const text = renderForecast(snapshot, 'brief');
    expect(text).toContain('小雨，9°C，降水概率 70%');
    expect(text).not.toContain('3.2 mm');
    expect(text).not.toContain('北风');
  });

  it('时次开关只留下选中的时次', () => {
    const text = renderForecast(makeSnapshot(), 'detailed', [6, 24]);
    expect(text.match(/小时后（/g)).toHaveLength(2);
    expect(text).toContain('6 小时后');
    expect(text).toContain('24 小时后');
    expect(text).not.toContain('1 小时后');
    expect(text).not.toContain('48 小时后');
  });

  it('预警标题压平换行、限长并加书名号', () => {
    const long = alert({ title: `北京市气象台\n发布暴雨蓝色预警   ${'请市民注意防范。'.repeat(30)}` });
    const text = renderAlerts(makeSnapshot({ alerts: [long] }));
    expect(text).toContain('- 蓝色·暴雨：「北京市气象台 发布暴雨蓝色预警 请市民注意防范。');
    expect(text).not.toContain('\n\n');
    expect(text).toContain('…」');
    // 每条预警仍是一行。
    expect(text.split('\n').filter((line) => line.startsWith('- 蓝色·'))).toHaveLength(1);
  });

  it('认不出的预警类别只保留短标签，不照抄整段原文', () => {
    const weird = alert({ type: '某种很长的海外预警分类名称 Thunderstorm Warning Special' });
    const text = renderAlerts(makeSnapshot({ alerts: [weird] }));
    const line = text.split('\n').find((item) => item.startsWith('- 蓝色·'))!;
    expect(line.split('：')[0]).toHaveLength('- 蓝色·'.length + 13);
    expect(line).toContain('…：');
  });
});

describe('每晚次日天气推送正文', () => {
  const sections = normalizeSections({ showNow: true, showForecast: true, showAlerts: true });

  it('有逐日数据时按白天/夜间写明天', () => {
    const snapshot = makeSnapshot({
      daily: [
        { date: '2026-11-02', dayText: '晴', nightText: '多云' },
        {
          date: '2026-11-03',
          dayText: '多云',
          nightText: '小雨',
          dayTempC: 20,
          nightTempC: 12,
          dayWindDir: '东北风',
          dayWindScale: '3~4级',
        },
      ],
      alerts: [alert()],
    });
    const text = renderNextDay(snapshot, sections);
    expect(text).toContain('明天天气（北京，11月03日）：');
    expect(text).toContain('- 天气：白天多云，夜间小雨');
    expect(text).toContain('- 气温：白天 20°C，夜间 12°C');
    expect(text).toContain('- 风：白天 东北风 3~4级');
    expect(text).toContain('天气预警（北京');
    expect(text).toContain('数据源不预报之后才会出现的预警');
  });

  it('没有逐日数据时用明天的逐小时点汇总', () => {
    const snapshot = makeSnapshot({
      hourly: [
        { atMs: Date.parse('2026-11-03T02:00:00+08:00'), temperatureC: 9, condition: '多云', precipitationMm: 0 },
        { atMs: Date.parse('2026-11-03T14:00:00+08:00'), temperatureC: 17, condition: '小雨', precipitationMm: 2.4, precipitationProbabilityPct: 60 },
        { atMs: Date.parse('2026-11-04T02:00:00+08:00'), temperatureC: 8, condition: '晴' },
      ],
    });
    const text = renderNextDay(snapshot, sections);
    expect(text).toContain('- 气温：9~17°C');
    expect(text).toContain('- 降水：全天合计 2.4 mm');
    expect(text).toContain('- 降水概率最高 60%');
    expect(text).toContain('2 个逐小时时次的汇总');
    expect(text).not.toContain('11月04日');
  });

  it('简略的明天天气不写风和降水量', () => {
    const snapshot = makeSnapshot({
      daily: [
        {
          date: '2026-11-03',
          dayText: '多云',
          nightText: '小雨',
          dayTempC: 20,
          nightTempC: 12,
          precipitationMm: 4,
          precipitationProbabilityPct: 60,
          dayWindDir: '东北风',
          dayWindScale: '3~4级',
        },
      ],
    });
    const text = renderNextDay(snapshot, sections, 'brief');
    expect(text).toContain('- 天气：白天多云，夜间小雨');
    expect(text).toContain('- 降水概率：60%');
    expect(text).not.toContain('- 降水：');
    expect(text).not.toContain('东北风');
  });

  it('数据源没有明天的预报时照实说', () => {
    const snapshot = makeSnapshot({
      limitations: ['中国气象数据网默认只提供地面观测资料，没有未来预报。'],
    });
    const text = renderNextDay(snapshot, sections);
    expect(text).toContain('明天天气（北京，11月03日）：Open-Meteo 中国气象数据网默认只提供地面观测资料');
  });

  it('两部分各自跟随自己的开关', () => {
    const snapshot = makeSnapshot({ alerts: [alert()] });
    const onlyAlerts = normalizeSections({ showNow: true, showForecast: false, showAlerts: true });
    const text = renderNextDay(snapshot, onlyAlerts);
    expect(text).not.toContain('明天天气');
    expect(text).toContain('蓝色·暴雨');

    const onlyForecast = normalizeSections({ showNow: false, showForecast: true, showAlerts: false });
    expect(renderNextDay(snapshot, onlyForecast)).not.toContain('天气预警');

    const none = normalizeSections({ showNow: true, showForecast: false, showAlerts: false });
    expect(renderNextDay(snapshot, none)).toContain('没有可投递的内容');
  });
});
