/**
 * 天气 World：
 * - 启动时取一次，之后在本地凌晨 00:00 起算的整点时次轮询；
 * - 「现在天气」「未来天气」每轮都投递，旧的那条未投递事件先撤回；
 * - 「天气预警」只在新增、解除或等级变化时投递，避免重复报警；
 * - 三类信息至少保留一项，全关时自动恢复「现在天气」；
 * - 另可打开「每晚推送」，到点递一条明天的天气加当前生效预警。
 */
import { fileURLToPath } from 'node:url';
import type {
  EventEnvelope,
  EventTag,
  PushOptions,
  ToolDef,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import {
  normalizeSections,
  needsCoordinates,
  parseNightlyTime,
  parseProvider,
  parseRefreshHours,
  providerLabel,
  weatherConfigGroup,
  withTrimmedText,
  type WeatherConfigSection,
} from './config.ts';
import { SECRET_NAMES } from './credentials.ts';
import { alertsSignature } from './alerts.ts';
import { makeFetchJson } from './http.ts';
import { fetchWeather } from './providers/index.ts';
import { formatDateKey, formatLocalDateTime, nextSlotAt, nextWallClockAt, tomorrowNoonMs } from './location.ts';
import { renderAlerts, renderForecast, renderNextDay, renderNow, renderWeatherError } from './model-text.ts';
import type { FetchJson, WeatherSnapshot } from './types.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const TICK_MS = 30_000;
const CACHE_TTL_MS = 10 * 60_000;
/** 取数失败后不必等到下一个时次；间隔小于它时仍按时次走。 */
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

/** 全部工具的声明；实例按开关返回其中的子集，自描述始终列出全部。 */
export const WEATHER_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'weather_now',
    description:
      'Read the latest current weather for the configured location: condition, temperature, feels-like, humidity, wind, precipitation and pressure when the provider supplies them. Read-only.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'weather_forecast',
    description:
      'Read the latest forecast at roughly 1, 6, 12, 24 and 48 hours ahead for the configured location. The receipt states whether each value is hourly, 3-hourly or a daily day/night period.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'weather_alerts',
    description:
      'Read the active weather alerts for the configured location. Alerts are normalized to the China Meteorological Administration four-level system (blue, yellow, orange, red); a provider without alerts is reported as such.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

type ToolFailure = { text: string; failed: true };

export interface WeatherWorldOptions {
  cfg: WeatherConfigSection;
  timezone: string;
  /** 测试注入。 */
  now?: () => number;
  secret?: (name: string) => string;
  /** 测试注入：跳过真实网络，直接给一份快照。 */
  fetchSnapshot?: (cfg: WeatherConfigSection, nowMs: number) => Promise<WeatherSnapshot>;
  /** 测试注入：适配器网络层。 */
  fetchJson?: FetchJson;
  /** 装配层写回配置；自动经纬度解析成功后回填。 */
  persist?: (patch: Partial<WeatherConfigSection>) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function formatNightlyTime(time: { hour: number; minute: number }): string {
  return `${pad2(time.hour)}:${pad2(time.minute)}`;
}

export class WeatherWorld implements World {
  readonly id = 'weather';

  private host: WorldHost | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private nextDueAt = Number.POSITIVE_INFINITY;
  private armedHours = 0;
  private nightlyDueAt = Number.POSITIVE_INFINITY;
  private armedNightly = '';
  private snapshot: WeatherSnapshot | null = null;
  private snapshotKey = '';
  private refreshing: Promise<void> | null = null;
  private snapshotRequest: Promise<WeatherSnapshot> | null = null;
  private snapshotRequestKey = '';
  private pendingNow: number | null = null;
  private pendingForecast: number | null = null;
  private lastAlertSignature: string | null = null;
  private lastConfigKey = '';
  private lastRefreshError: string | null = null;
  private readonly warned = new Set<string>();
  private readonly clock: () => number;
  private readonly secret: (name: string) => string;
  private readonly fetchJson: FetchJson;

  constructor(private readonly opts: WeatherWorldOptions) {
    this.clock = opts.now ?? Date.now;
    this.secret = opts.secret ?? (() => '');
    this.fetchJson = opts.fetchJson ?? makeFetchJson();
  }

  /** 配置的读视图：字符串都去掉首尾空白，多打一个空格不影响地名查找与报错文案。 */
  private get cfg(): WeatherConfigSection {
    return withTrimmedText(this.opts.cfg);
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    const sections = normalizeSections(this.cfg);
    const decl = (name: string): Omit<ToolDef, 'handler'> => {
      const found = WEATHER_TOOL_DECLS.find((tool) => tool.name === name);
      if (!found) throw new Error(`缺少工具声明：${name}`);
      return found;
    };
    const tools: ToolDef[] = [];
    if (sections.now) {
      tools.push({ ...decl('weather_now'), handler: async () => this.toolNow() });
    }
    if (sections.forecast) {
      tools.push({ ...decl('weather_forecast'), handler: async () => this.toolForecast() });
    }
    if (sections.alerts) {
      tools.push({ ...decl('weather_alerts'), handler: async () => this.toolAlerts() });
    }
    return tools;
  }

  webUi(language?: string): WorldWebUiDecl {
    const zh = language !== 'en';
    const cfg = this.cfg;
    const provider = parseProvider(cfg.provider);
    return {
      label: zh ? '天气' : 'Weather',
      config: [weatherConfigGroup(language === 'en' ? 'en' : 'zh')],
      badges: [
        { label: zh ? '数据源' : 'Provider', value: providerLabel(provider, language === 'en' ? 'en' : 'zh'), tone: 'plain' },
        { label: zh ? '位置' : 'Location', value: cfg.city || cfg.province || '-', tone: 'plain' },
        {
          label: zh ? '取数时次' : 'Slots',
          value: zh ? `00:00 起每 ${parseRefreshHours(cfg.requestEvery)} 小时` : `every ${parseRefreshHours(cfg.requestEvery)}h from 00:00`,
          tone: 'plain',
        },
        {
          label: zh ? '每晚推送' : 'Nightly',
          value: cfg.nightlyPush ? formatNightlyTime(parseNightlyTime(cfg.nightlyPushTime)) : (zh ? '关闭' : 'off'),
          tone: 'plain',
        },
      ],
      panels: [
        {
          id: 'settings',
          title: zh ? '天气开关' : 'Weather switches',
          description: zh
            ? '现在天气、未来天气、天气预警至少保留一项；只剩最后一项时不能关闭。'
            : 'Current conditions, forecast and alerts: at least one stays on; the last one cannot be switched off.',
        },
      ],
      invoke: (panel, method) => this.invokePanel(panel, method),
      promptDocs: [
        {
          key: 'worlds.weather.envPrompt',
          title: zh ? '天气 · 环境提示词' : 'Weather · environment prompt',
          description: zh ? '说明天气事件、工具和数据源限制。' : 'What the weather events, tools and provider limits are.',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [],
        },
      ],
    };
  }

  /** 「天气开关」面板的数据接口；开关仍由面板通过 setConfig 写回。 */
  private async invokePanel(panel: string, method: string): Promise<unknown> {
    if (panel !== 'settings') throw new Error(`未知面板：${panel}`);
    if (method === 'state') {
      const cfg = this.cfg;
      const sections = normalizeSections(cfg);
      return {
        showNow: sections.now,
        showForecast: sections.forecast,
        showAlerts: sections.alerts,
        coerced: sections.coerced,
        provider: parseProvider(cfg.provider),
        location: cfg.city || cfg.province || '-',
        interval: parseRefreshHours(cfg.requestEvery),
        autoGeocode: cfg.autoGeocode,
        nightlyPush: cfg.nightlyPush,
        nightlyPushTime: formatNightlyTime(parseNightlyTime(cfg.nightlyPushTime)),
        nextFetchAt: Number.isFinite(this.nextDueAt)
          ? formatLocalDateTime(this.nextDueAt, this.opts.timezone)
          : null,
      };
    }
    if (method === 'preview') return this.previewState();
    if (method === 'refresh') {
      await this.refreshNow(true);
      return this.previewState();
    }
    throw new Error(`未知方法：${method}`);
  }

  private previewState(): Record<string, unknown> {
    const snapshot = this.snapshot;
    const cfg = this.cfg;
    return {
      available: Boolean(snapshot),
      fetchedAt: snapshot ? formatLocalDateTime(snapshot.fetchedAtMs, snapshot.timezone) : null,
      provider: snapshot?.providerName ?? providerLabel(parseProvider(cfg.provider), 'zh'),
      location: snapshot?.location.city ?? (cfg.city || cfg.province || '-'),
      coordinates:
        snapshot &&
        needsCoordinates(snapshot.provider) &&
        snapshot.location.latitude !== undefined &&
        snapshot.location.longitude !== undefined
          ? `${snapshot.location.latitude.toFixed(4)}, ${snapshot.location.longitude.toFixed(4)}`
          : null,
      now: snapshot ? renderNow(snapshot) : null,
      forecast: snapshot ? renderForecast(snapshot) : null,
      alerts: snapshot ? renderAlerts(snapshot) : null,
      error: this.lastRefreshError,
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.running = true;
    this.pendingNow = null;
    this.pendingForecast = null;
    this.lastAlertSignature = null;
    this.lastConfigKey = '';
    this.lastRefreshError = null;
    this.warned.clear();
    this.armNextFetch(this.clock());
    this.armNightly(this.clock());
    // 启动不阻塞模型循环；网络失败只记日志，下一轮再试。
    void this.refreshNow(true);
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.host = null;
    this.pendingNow = null;
    this.pendingForecast = null;
    this.snapshot = null;
    this.snapshotKey = '';
    this.nextDueAt = Number.POSITIVE_INFINITY;
    this.armedHours = 0;
    this.nightlyDueAt = Number.POSITIVE_INFINITY;
    this.armedNightly = '';
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch(() => {})
        .finally(() => this.schedule());
    }, TICK_MS);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.host) return;
    if (parseRefreshHours(this.cfg.requestEvery) !== this.armedHours) this.armNextFetch(this.clock());
    if (this.nightlyKey() !== this.armedNightly) this.armNightly(this.clock());
    if (this.clock() >= this.nextDueAt) await this.refreshNow(true);
    if (this.clock() >= this.nightlyDueAt) await this.runNightlyPush();
  }

  /** 取数排在本地 00:00 起算的整点时次；刚失败过时提前重试。 */
  private armNextFetch(nowMs: number): void {
    const hours = parseRefreshHours(this.cfg.requestEvery);
    this.armedHours = hours;
    const slot = nextSlotAt(nowMs, this.opts.timezone, hours);
    this.nextDueAt = this.lastRefreshError ? Math.min(slot, nowMs + RETRY_AFTER_FAILURE_MS) : slot;
  }

  /** 开关或时刻变了就重新排；关掉时不再排。 */
  private nightlyKey(): string {
    const cfg = this.cfg;
    if (!cfg.nightlyPush) return 'off';
    const time = parseNightlyTime(cfg.nightlyPushTime);
    return formatNightlyTime(time);
  }

  private armNightly(nowMs: number): void {
    this.armedNightly = this.nightlyKey();
    const cfg = this.cfg;
    if (!cfg.nightlyPush) {
      this.nightlyDueAt = Number.POSITIVE_INFINITY;
      return;
    }
    const time = parseNightlyTime(cfg.nightlyPushTime);
    this.nightlyDueAt = nextWallClockAt(nowMs, this.opts.timezone, time.hour, time.minute);
  }

  /** 每晚推送：明天的天气加当前生效中的预警，一天一次。 */
  private async runNightlyPush(): Promise<void> {
    const nowMs = this.clock();
    this.armNightly(nowMs);
    const cfg = this.cfg;
    const sections = normalizeSections(cfg);
    if (!sections.forecast && !sections.alerts) {
      this.warnOnce('nightly-empty', '「每晚推送」开着，但「未来天气」和「天气预警」都关了，没有内容可投递。');
      return;
    }
    try {
      const snapshot = await this.loadSnapshot(false);
      if (!this.running || !this.host) return;
      const date = formatDateKey(tomorrowNoonMs(nowMs, this.opts.timezone), this.opts.timezone);
      await this.push(this.host, 'weather.next_day', renderNextDay(snapshot, sections), { trigger: 'flush' }, undefined, {
        provider: snapshot.provider,
        date,
        nightly: true,
      });
    } catch (error) {
      this.warnOnce(`nightly:${message(error)}`, `天气每晚推送失败：${message(error)}`);
    }
  }

  /** 立即取一次；并发调用复用同一次刷新。 */
  refreshNow(force = true): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const promise = this.doRefresh(force)
      .catch((error: unknown) => {
        this.lastRefreshError = message(error);
        this.warnOnce(`refresh:${message(error)}`, `天气刷新失败：${message(error)}`);
      })
      .finally(() => {
        if (this.refreshing === promise) this.refreshing = null;
        this.armNextFetch(this.clock());
      });
    this.refreshing = promise;
    return promise;
  }

  private async doRefresh(force: boolean): Promise<void> {
    const cfg = this.cfg;
    const key = this.configKey();
    if (key !== this.lastConfigKey) {
      const hadConfig = this.lastConfigKey !== '';
      this.lastConfigKey = key;
      this.lastAlertSignature = null;
      this.pendingNow = null;
      this.pendingForecast = null;
      if (hadConfig) this.warned.clear();
    }

    const sections = normalizeSections(cfg);
    if (sections.coerced) {
      this.warnOnce('toggles', '天气设置里三项都关了；已自动保留「现在天气」。');
    }

    const snapshot = await this.loadSnapshot(force);
    this.lastRefreshError = null;
    this.persistResolvedCoordinates(snapshot);
    if (!this.running || !this.host) return;
    const host = this.host;

    if (sections.now) {
      if (snapshot.capabilities.now && snapshot.now) {
        await this.pushReplace(host, 'weather.now', renderNow(snapshot), 'piggyback', 'now', ['snapshot']);
      } else {
        this.warnOnce(`now:${snapshot.provider}`, `${snapshot.providerName} 没有返回当前天气。`);
      }
    }

    if (sections.forecast) {
      if (snapshot.capabilities.forecast && snapshot.horizons.length > 0) {
        await this.pushReplace(host, 'weather.forecast', renderForecast(snapshot), 'piggyback', 'forecast', ['snapshot']);
      } else if (!snapshot.capabilities.forecast) {
        this.warnOnce(`forecast:${snapshot.provider}`, `${snapshot.providerName} 不提供未来预报。`);
      }
    }

    if (sections.alerts) {
      if (snapshot.capabilities.alerts) {
        const signature = alertsSignature(snapshot.alerts);
        if (signature !== this.lastAlertSignature) {
          this.lastAlertSignature = signature;
          await this.push(host, 'weather.alert', renderAlerts(snapshot), { trigger: 'flush' }, undefined, {
            provider: snapshot.provider,
            count: snapshot.alerts.length,
          });
        }
      } else {
        this.warnOnce(
          `alerts:${snapshot.provider}`,
          snapshot.alertsNote ?? `${snapshot.providerName} 不提供天气预警。`,
        );
      }
    }
  }

  private async loadSnapshot(force: boolean): Promise<WeatherSnapshot> {
    const cfg = this.cfg;
    const key = this.configKey();
    const nowAt = this.clock();
    if (!force && this.snapshot && this.snapshotKey === key && nowAt - this.snapshot.fetchedAtMs < CACHE_TTL_MS) {
      return this.snapshot;
    }
    if (this.snapshotRequest && this.snapshotRequestKey === key) return this.snapshotRequest;

    const request = this.opts.fetchSnapshot
      ? this.opts.fetchSnapshot(cfg, nowAt)
      : fetchWeather({
          cfg,
          sections: normalizeSections(cfg),
          timezone: this.opts.timezone,
          nowMs: nowAt,
          secret: (name) => this.secret(name),
          fetchJson: this.fetchJson,
        });
    this.snapshotRequest = request;
    this.snapshotRequestKey = key;
    try {
      const snapshot = await request;
      if (this.snapshotRequest === request) {
        this.snapshot = snapshot;
        this.snapshotKey = key;
      }
      return snapshot;
    } finally {
      if (this.snapshotRequest === request) {
        this.snapshotRequest = null;
        this.snapshotRequestKey = '';
      }
    }
  }

  /** 自动解析成功后把经纬度写回配置，改地址时不会继续沿用旧城市的值。 */
  private persistResolvedCoordinates(snapshot: WeatherSnapshot): void {
    const cfg = this.cfg;
    if (!cfg.autoGeocode || !needsCoordinates(snapshot.provider)) return;
    const latitude = snapshot.location.latitude;
    const longitude = snapshot.location.longitude;
    if (latitude === undefined || longitude === undefined) return;
    const round = (value: number): number => Math.round(value * 10_000) / 10_000;
    const nextLatitude = round(latitude);
    const nextLongitude = round(longitude);
    if (Math.abs(nextLatitude - cfg.latitude) < 0.00005 && Math.abs(nextLongitude - cfg.longitude) < 0.00005) return;
    try {
      this.opts.persist?.({ latitude: nextLatitude, longitude: nextLongitude });
      this.lastConfigKey = this.configKey();
      this.snapshotKey = this.lastConfigKey;
    } catch (error) {
      this.warnOnce(`persist-coordinates:${message(error)}`, `回填经纬度失败：${message(error)}`);
    }
  }

  /** 工具调用：优先用 10 分钟内的缓存；请求失败时退回上一次同配置的快照。 */
  private async snapshotForTool(): Promise<WeatherSnapshot> {
    const key = this.configKey();
    try {
      return await this.loadSnapshot(false);
    } catch (error) {
      if (this.snapshot && this.snapshotKey === key) return this.snapshot;
      throw error;
    }
  }

  private async toolNow(): Promise<string | ToolFailure> {
    try {
      return renderNow(await this.snapshotForTool());
    } catch (error) {
      return { text: renderWeatherError(message(error)), failed: true };
    }
  }

  private async toolForecast(): Promise<string | ToolFailure> {
    try {
      const snapshot = await this.snapshotForTool();
      if (!snapshot.capabilities.forecast) {
        return snapshot.limitations[0] ?? `${snapshot.providerName} 不提供未来预报。`;
      }
      return renderForecast(snapshot);
    } catch (error) {
      return { text: renderWeatherError(message(error)), failed: true };
    }
  }

  private async toolAlerts(): Promise<string | ToolFailure> {
    try {
      const snapshot = await this.snapshotForTool();
      if (!snapshot.capabilities.alerts) {
        return snapshot.alertsNote ?? `${snapshot.providerName} 不提供天气预警。`;
      }
      return renderAlerts(snapshot);
    } catch (error) {
      return { text: renderWeatherError(message(error)), failed: true };
    }
  }

  /** 新一条现在/未来天气投递前，撤回上一条还没投递的同类型事件。 */
  private async pushReplace(
    host: WorldHost,
    type: string,
    text: string,
    trigger: PushOptions['trigger'],
    slot: 'now' | 'forecast',
    tags: readonly EventTag[],
  ): Promise<void> {
    const previous = slot === 'now' ? this.pendingNow : this.pendingForecast;
    if (slot === 'now') this.pendingNow = null;
    else this.pendingForecast = null;
    if (previous !== null && host.withdrawPending) {
      try {
        await host.withdrawPending(previous);
      } catch (error) {
        this.warnOnce(`withdraw:${type}`, `撤回上一条天气事件失败：${message(error)}`);
      }
    }
    const envelope = await this.push(host, type, text, { trigger }, tags, undefined);
    if (slot === 'now') this.pendingNow = envelope?.cursor ?? null;
    else this.pendingForecast = envelope?.cursor ?? null;
  }

  private async push(
    host: WorldHost,
    type: string,
    text: string,
    opts: PushOptions,
    tags: readonly EventTag[] | undefined,
    meta: Record<string, unknown> | undefined,
  ): Promise<EventEnvelope | null> {
    try {
      return await host.pushEvent(
        {
          type,
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'internal',
          senderKey: this.id,
          text,
          ...(tags ? { tags } : {}),
          ...(meta ? { meta } : {}),
        },
        opts,
      );
    } catch (error) {
      this.warnOnce(`push:${type}:${message(error)}`, `天气事件投递失败：${message(error)}`);
      return null;
    }
  }

  /** 配置或凭证变化时，缓存与预警去重都要重新开始。 */
  private configKey(): string {
    const cfg = this.cfg;
    return JSON.stringify([
      parseProvider(cfg.provider),
      cfg.province,
      cfg.city,
      cfg.latitude,
      cfg.longitude,
      cfg.autoGeocode,
      cfg.qweatherHost,
      cfg.nmcStationId,
      this.secret(SECRET_NAMES.cmaUserId),
      this.secret(SECRET_NAMES.cmaApiKey),
      cfg.cmaUserId,
      cfg.cmaApiKey,
      cfg.cmaStationId,
      cfg.cmaDataCode,
      cfg.cmaElements,
      this.secret(SECRET_NAMES.apihzId),
      this.secret(SECRET_NAMES.apihzKey),
      cfg.apihzId,
      cfg.apihzKey,
      this.secret(SECRET_NAMES.qweatherKey),
      cfg.qweatherKey,
      this.secret(SECRET_NAMES.pirateWeatherKey),
      cfg.pirateWeatherKey,
    ]);
  }

  private warnOnce(key: string, text: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.host?.log.warn(text);
  }
}
