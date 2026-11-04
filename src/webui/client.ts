/**
 * 「天气开关」面板：三项里只剩最后一项时，那一项直接禁用，不能关掉。
 * 下方展示上一次成功取到的数据，并可手动刷新一次。
 * 数据源、位置与密钥仍在同一页的配置表单里改。
 */
import type { WebUiCheckbox, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

type SectionKey = 'showNow' | 'showForecast' | 'showAlerts';

interface State {
  showNow: boolean;
  showForecast: boolean;
  showAlerts: boolean;
  coerced?: boolean;
  provider: string;
  location: string;
  interval: number;
  autoGeocode?: boolean;
  nightlyPush?: boolean;
  nightlyPushTime?: string;
  nextFetchAt?: string | null;
}

interface Preview {
  available: boolean;
  fetchedAt: string | null;
  provider: string;
  location: string;
  coordinates: string | null;
  now: string | null;
  forecast: string | null;
  alerts: string | null;
  error: string | null;
}

const KEYS: readonly SectionKey[] = ['showNow', 'showForecast', 'showAlerts'];

const PROVIDER_NAMES: Record<string, { zh: string; en: string }> = {
  nmc: { zh: '中央气象台', en: 'NMC / CMA' },
  cma: { zh: '中国气象数据网', en: 'China Meteorological Data' },
  apihz: { zh: '接口盒子', en: 'APIHZ' },
  tencent: { zh: '腾讯天气', en: 'Tencent Weather' },
  qweather: { zh: '和风天气', en: 'QWeather' },
  openmeteo: { zh: 'Open-Meteo', en: 'Open-Meteo' },
  pirate: { zh: 'Pirate Weather', en: 'Pirate Weather' },
};

const TEXT = {
  zh: {
    title: '天气开关',
    desc: '现在天气、未来天气、天气预警至少保留一项；只剩最后一项时，它不能被关掉。改动保存后立即生效。',
    loading: '正在读取当前开关…',
    ready: '开关已读取。',
    failed: '读取失败',
    saving: '正在保存…',
    saved: '已保存。下一次取数会按新开关投递。',
    blocked: '至少保留一项；只剩这一项时不能关闭。',
    coerced: '之前三项都关着，已自动保留「现在天气」；现在可以重新打开其它项。',
    provider: '数据源',
    location: '位置',
    every: '请求间隔',
    nextFetch: '下次取数',
    nightly: '每晚推送明天的天气和当前预警',
    nightlyTitle: '到设定时刻投递一条「明天天气 + 当前生效中的预警」，一天一次。明天天气跟随「未来天气」开关，预警跟随「天气预警」开关。',
    nightlyTime: '推送时刻（HH:mm）',
    nightlyBadTime: '时刻要写成 HH:mm，例如 20:00。',
    nightlyBlocked: '「未来天气」和「天气预警」都关了，每晚推送没有内容可投递。',
    hint: 'API 所需的 ID、KEY、台站号在下方配置表单里填；缺什么会在激活或取数时报出来，并给出注册地址。和风天气 403 时优先检查配置里的 API Host。',
    lastTitle: '上一次获取',
    lastDesc: '最近一次成功取到的数据；不会为了展示再请求互联网。',
    lastLoading: '正在读取上一次的数据…',
    lastEmpty: '还没有取到数据；点「刷新一次」或等待下一次轮询。',
    lastFetched: '获取时间',
    coordinates: '经纬度',
    lastError: '最近一次错误',
    refresh: '刷新一次',
    refreshing: '正在请求天气数据…',
    refreshFailed: '刷新失败',
    labels: {
      showNow: '现在天气',
      showForecast: '未来天气（1/6/12/24/48 小时）',
      showAlerts: '天气预警',
    },
  },
  en: {
    title: 'Weather switches',
    desc: 'Current conditions, forecast and alerts: at least one stays on. When only one is left, it cannot be switched off. Changes apply immediately.',
    loading: 'Reading current switches…',
    ready: 'Switches loaded.',
    failed: 'Failed to read',
    saving: 'Saving…',
    saved: 'Saved. The next fetch will deliver according to these switches.',
    blocked: 'At least one section must stay on; the last one cannot be turned off.',
    coerced: 'All three were off, so current conditions was restored. You can turn the others back on now.',
    provider: 'Provider',
    location: 'Location',
    every: 'Every',
    nextFetch: 'Next fetch',
    nightly: 'Nightly push of tomorrow weather and current alerts',
    nightlyTitle:
      'At the set time, deliver one event with tomorrow weather plus the alerts in force, once a day. Tomorrow weather follows the forecast switch, alerts follow the alert switch.',
    nightlyTime: 'Push time (HH:mm)',
    nightlyBadTime: 'Write the time as HH:mm, for example 20:00.',
    nightlyBlocked: 'Forecast and alerts are both off, so the nightly push has nothing to deliver.',
    hint: 'Put the required ID, KEY or station number in the config form below. Missing values are reported with the registration address. On QWeather 403, check the API Host in the config.',
    lastTitle: 'Last fetch',
    lastDesc: 'The last successfully fetched data; displaying it does not call the provider again.',
    lastLoading: 'Reading the last fetch…',
    lastEmpty: 'No data yet. Press “Refresh once” or wait for the next poll.',
    lastFetched: 'Fetched',
    coordinates: 'Coordinates',
    lastError: 'Last error',
    refresh: 'Refresh once',
    refreshing: 'Requesting weather data…',
    refreshFailed: 'Refresh failed',
    labels: {
      showNow: 'Current weather',
      showForecast: 'Forecast (1/6/12/24/48 h)',
      showAlerts: 'Weather alerts',
    },
  },
} as const;

export const settingsPanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const S = ctx.language === 'en' ? TEXT.en : TEXT.zh;
    const card = ctx.ui.sheet({ title: S.title, desc: S.desc });
    const status = ctx.ui.msgline(S.loading);
    card.body.append(status);

    const lastCard = ctx.ui.sheet({ title: S.lastTitle, desc: S.lastDesc });
    const refreshButton = ctx.ui.button(S.refresh, { variant: 'primary' });
    const lastMeta = ctx.ui.msgline(S.lastLoading);
    const lastBody = ctx.ui.h('pre', 'mono');
    lastBody.style.whiteSpace = 'pre-wrap';
    lastBody.style.overflow = 'auto';
    lastBody.style.maxHeight = '420px';
    lastCard.body.append(refreshButton, lastMeta, lastBody);
    ctx.root.append(card.el, lastCard.el);

    let state: State;
    try {
      state = await ctx.invoke<State>('state');
    } catch (error) {
      status.textContent = `${S.failed}: ${String(error)}`;
      status.classList.add('bad');
      lastMeta.textContent = `${S.failed}: ${String(error)}`;
      lastMeta.classList.add('bad');
      return;
    }
    status.textContent = state.coerced ? S.coerced : S.ready;
    status.classList.remove('bad');

    const boxes = {} as Record<SectionKey, WebUiCheckbox>;
    const blocked = (key: SectionKey): boolean => !KEYS.some((other) => other !== key && boxes[other]?.checked);

    let nightlyBox: WebUiCheckbox | undefined;
    let nightlyNote: HTMLDivElement | undefined;

    const updateDisabled = () => {
      for (const key of KEYS) {
        const box = boxes[key];
        if (box) box.input.disabled = box.checked && blocked(key);
      }
      if (nightlyBox && nightlyNote) {
        const nothingToSay = !boxes.showForecast?.checked && !boxes.showAlerts?.checked;
        nightlyNote.textContent = nightlyBox.checked && nothingToSay ? S.nightlyBlocked : S.nightlyTitle;
      }
    };

    const providerName = (id: string): string =>
      PROVIDER_NAMES[id]?.[ctx.language === 'en' ? 'en' : 'zh'] ?? id;
    const info = ctx.ui.msgline('');
    const renderInfo = (next: State) => {
      const parts = [
        `${S.provider}: ${providerName(next.provider)}`,
        `${S.location}: ${next.location}`,
        `${S.every}: ${next.interval}h`,
      ];
      if (next.nextFetchAt) parts.push(`${S.nextFetch}: ${next.nextFetchAt}`);
      info.textContent = parts.join(' · ');
    };
    renderInfo(state);

    const writeConfig = async (key: string, value: boolean | string): Promise<boolean> => {
      try {
        await ctx.setConfig('world:weather', { [`worlds.weather.${key}`]: value });
        status.classList.remove('bad');
        status.textContent = S.saved;
        return true;
      } catch (error) {
        status.textContent = `${S.failed}: ${String(error)}`;
        status.classList.add('bad');
        return false;
      }
    };

    const persist = async (key: SectionKey, checked: boolean) => {
      if (!checked && blocked(key)) {
        boxes[key].setChecked(true);
        status.textContent = S.blocked;
        status.classList.add('bad');
        updateDisabled();
        return;
      }
      status.classList.remove('bad');
      status.textContent = S.saving;
      if (!(await writeConfig(key, checked))) boxes[key].setChecked(!checked);
      updateDisabled();
    };

    for (const key of KEYS) {
      const box = ctx.ui.checkbox(S.labels[key], {
        checked: state[key],
        onChange: (checked) => void persist(key, checked),
      });
      boxes[key] = box;
      card.body.append(box.el);
    }

    const hint = ctx.ui.msgline(S.hint);
    card.body.append(info, hint);

    // 每晚推送不属于「至少保留一项」的三项，开关和时刻单独一组。
    const nightlyTime = ctx.ui.input({
      type: 'text',
      value: state.nightlyPushTime ?? '20:00',
      placeholder: '20:00',
      onCommit: (value) => {
        const text = value.trim();
        if (/^\d{1,2}:\d{2}$/.test(text)) void writeConfig('nightlyPushTime', text);
        else {
          status.textContent = S.nightlyBadTime;
          status.classList.add('bad');
        }
      },
    });
    nightlyBox = ctx.ui.checkbox(S.nightly, {
      checked: state.nightlyPush === true,
      title: S.nightlyTitle,
      onChange: (checked) => void writeConfig('nightlyPush', checked).then(updateDisabled),
    });
    nightlyNote = ctx.ui.msgline(S.nightlyTitle);
    card.body.append(nightlyBox.el, ctx.ui.field(S.nightlyTime, nightlyTime), nightlyNote);

    updateDisabled();

    const renderPreview = (preview: Preview) => {
      lastMeta.classList.remove('bad');
      if (!preview.available) {
        lastBody.textContent = '';
        lastMeta.textContent = preview.error ? `${S.lastError}: ${preview.error}` : S.lastEmpty;
        if (preview.error) lastMeta.classList.add('bad');
        return;
      }
      const meta = [
        `${S.lastFetched}: ${preview.fetchedAt ?? '-'}`,
        `${S.provider}: ${preview.provider}`,
        `${S.location}: ${preview.location}`,
      ];
      if (preview.coordinates) meta.push(`${S.coordinates}: ${preview.coordinates}`);
      if (preview.error) meta.push(`${S.lastError}: ${preview.error}`);
      lastMeta.textContent = meta.join(' · ');
      lastMeta.classList.toggle('bad', Boolean(preview.error));
      lastBody.textContent = [preview.now, preview.forecast, preview.alerts]
        .filter((value): value is string => Boolean(value))
        .join('\n\n');
    };

    async function loadPreview(): Promise<void> {
      try {
        renderPreview(await ctx.invoke<Preview>('preview'));
      } catch (error) {
        lastMeta.textContent = `${S.failed}: ${String(error)}`;
        lastMeta.classList.add('bad');
      }
    }

    const refresh = async () => {
      refreshButton.disabled = true;
      lastMeta.classList.remove('bad');
      lastMeta.textContent = S.refreshing;
      try {
        renderPreview(await ctx.invoke<Preview>('refresh'));
        status.classList.remove('bad');
        status.textContent = S.saved;
      } catch (error) {
        lastMeta.textContent = `${S.refreshFailed}: ${String(error)}`;
        lastMeta.classList.add('bad');
      } finally {
        refreshButton.disabled = false;
      }
    };

    refreshButton.addEventListener('click', () => void refresh(), { signal: ctx.signal });

    // 配置表单里换了数据源/位置/间隔时，同步面板与页面顶部的徽标。
    const applyState = (next: State) => {
      const changed =
        next.provider !== state.provider ||
        next.location !== state.location ||
        next.interval !== state.interval ||
        next.nightlyPush !== state.nightlyPush ||
        next.nightlyPushTime !== state.nightlyPushTime;
      state = next;
      for (const key of KEYS) {
        if (boxes[key].checked !== next[key]) boxes[key].setChecked(next[key]);
      }
      if (nightlyBox && nightlyBox.checked !== (next.nightlyPush === true)) {
        nightlyBox.setChecked(next.nightlyPush === true);
      }
      if (document.activeElement !== nightlyTime) nightlyTime.value = next.nightlyPushTime ?? '20:00';
      updateDisabled();
      renderInfo(next);
      if (changed) void ctx.refresh();
    };
    const syncState = async () => {
      try {
        applyState(await ctx.invoke<State>('state'));
      } catch {
        // 轮询失败不覆盖面板上已有的数据。
      }
    };

    void loadPreview();
    ctx.interval(() => void syncState(), 5_000);
    ctx.interval(() => void loadPreview(), 15_000);
  },
};

export default { panels: { settings: settingsPanel } };
