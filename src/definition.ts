import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import type { Language } from 'cortico/core/language.ts';
import {
  WEATHER_DEFAULTS,
  providerOptions,
  type WeatherConfigSection,
} from './config.ts';
import { preflightIssue } from './credentials.ts';
import { WEATHER_TOOL_DECLS, WeatherWorld } from './world.ts';

export const WEATHER: WorldDefinition<WeatherConfigSection> = {
  id: 'weather',
  label: 'Weather',
  defaults: () => ({ ...WEATHER_DEFAULTS }),
  preflight: (ctx) => {
    const issue = preflightIssue(ctx.cfg, (name) => ctx.secret(name));
    if (issue) throw new Error(issue);
  },
  configOptions: (kind: string, language: Language): Array<{ value: string; label: string }> =>
    kind === 'weatherProvider' ? providerOptions(language) : [],
  create: (ctx) =>
    new WeatherWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      secret: (name) => ctx.secret(name),
      persist: (patch) => ctx.persist(patch),
    }),
  describe: {
    tools: describeTools(WEATHER_TOOL_DECLS, {
      weather_now: {
        zh: '读取配置地点的最新现在天气。',
        en: 'Reads the latest current weather for the configured location.',
      },
      weather_forecast: {
        zh: '读取配置地点未来 1/6/12/24/48 小时的天气，并注明精度是逐小时、3 小时还是逐日。',
        en: 'Reads the forecast at roughly 1, 6, 12, 24 and 48 hours ahead, stating whether each value is hourly, 3-hourly or daily.',
      },
      weather_alerts: {
        zh: '读取配置地点生效中的天气预警，等级统一为中央气象台的蓝/黄/橙/红四级。',
        en: 'Reads active alerts, normalized to the CMA blue/yellow/orange/red levels.',
      },
    }),
    events: [
      {
        type: 'weather.now',
        description: {
          zh: '现在天气：每次成功取数后递来，正文带数据源的发布时间；旧事件还没投递时会被新事件撤回。',
          en: 'Current weather after a successful fetch, with the provider publication time; an undelivered older one is withdrawn.',
        },
        trigger: 'piggyback',
        tags: ['snapshot'],
      },
      {
        type: 'weather.forecast',
        description: {
          zh: '未来天气：1/6/12/24/48 小时后的天气；逐日源会在正文里注明精度。旧事件还没投递时会被新事件撤回。',
          en: 'Forecast at 1/6/12/24/48 hours ahead; daily-only providers say so in the text. An undelivered older one is withdrawn.',
        },
        trigger: 'piggyback',
        tags: ['snapshot'],
      },
      {
        type: 'weather.alert',
        description: {
          zh: '天气预警：预警新增、解除或等级变化时递来，正文统一为中央气象台体系；没有变化就不重复投递。',
          en: 'Weather alerts when they appear, clear or change level, normalized to the CMA system; no repeat when unchanged.',
        },
        trigger: 'flush',
      },
      {
        type: 'weather.next_day',
        description: {
          zh: '每晚推送：到设定时刻递来明天的天气和当前生效中的预警，一天一次；需要打开「每晚推送」。',
          en: 'Nightly push at the configured time: tomorrow weather plus the alerts currently in force, once a day when the nightly switch is on.',
        },
        trigger: 'flush',
      },
    ],
  },
};
