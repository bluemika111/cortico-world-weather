import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { parseHourMinute } from './location.ts';
import {
  HORIZON_HOURS,
  PROVIDER_IDS,
  type DetailMode,
  type HorizonHours,
  type ProviderId,
  type WeatherSections,
} from './types.ts';

/**
 * config.json 的 worlds.weather 段。键保持扁平；WebUI 的配置接口写不了嵌套对象。
 * 七类数据源的凭证都放在这里，只有被选中的那一类才需要填。
 */
export interface WeatherConfigSection {
  enabled: boolean;
  provider: ProviderId;

  province: string;
  city: string;
  latitude: number;
  longitude: number;
  /** 打开时按省市自动解析经纬度并回填；关闭时使用上面的手填值。 */
  autoGeocode: boolean;
  /** 中央气象台的城市代码，例如 Wqsps；留空按省市自动查找。 */
  nmcStationId: string;
  /** 和风天气控制台里的 API Host；免费版与新项目可能不同。 */
  qweatherHost: string;
  /** 每晚推送的本地时间，24 小时制 `HH:mm`。 */
  nightlyPushTime: string;
  /** 每多少小时向互联网请求一次；1–48，从本地凌晨 00:00 起算。 */
  requestEvery: number;

  showNow: boolean;
  showForecast: boolean;
  showAlerts: boolean;
  /** 到点投递一条「次日天气 + 当前预警」。 */
  nightlyPush: boolean;

  /** 「现在天气」事件的详略；工具回执不受影响，永远给全。 */
  nowDetail: DetailMode;
  /** 「未来天气」事件与每晚推送的详略。 */
  forecastDetail: DetailMode;

  /** 五个未来时次各自是否投递；至少留一个。 */
  horizon1h: boolean;
  horizon6h: boolean;
  horizon12h: boolean;
  horizon24h: boolean;
  horizon48h: boolean;

  cmaUserId: string;
  cmaApiKey: string;
  cmaStationId: string;
  cmaDataCode: string;
  cmaElements: string;

  apihzId: string;
  apihzKey: string;
  qweatherKey: string;
  pirateWeatherKey: string;
}

export const DEFAULT_CMA_ELEMENTS =
  'Station_Id_C,Year,Mon,Day,Hour,TEM,RHU,PRE_1h,PRS,WIN_S_Inst_Max,WIN_D_Inst_Max';

export const WEATHER_DEFAULTS: WeatherConfigSection = {
  enabled: false,
  provider: 'nmc',
  province: '北京市',
  city: '北京',
  latitude: 39.9042,
  longitude: 116.4074,
  autoGeocode: true,
  nmcStationId: '',
  qweatherHost: 'devapi.qweather.com',
  nightlyPushTime: '20:00',
  requestEvery: 6,
  showNow: true,
  showForecast: true,
  showAlerts: true,
  nightlyPush: false,
  nowDetail: 'detailed',
  forecastDetail: 'detailed',
  horizon1h: true,
  horizon6h: true,
  horizon12h: true,
  horizon24h: true,
  horizon48h: true,
  cmaUserId: '',
  cmaApiKey: '',
  cmaStationId: '54511',
  cmaDataCode: 'SURF_CHN_MUL_HOR',
  cmaElements: DEFAULT_CMA_ELEMENTS,
  apihzId: '',
  apihzKey: '',
  qweatherKey: '',
  pirateWeatherKey: '',
};

export function parseProvider(value: unknown): ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId) ? (value as ProviderId) : 'nmc';
}

/** 请求间隔归一化：只接受 1–48 的整数小时，其余回到默认的 6 小时。 */
export function parseRefreshHours(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 48 ? n : 6;
}

const NIGHTLY_FALLBACK = { hour: 20, minute: 0 };

/** 每晚推送的时刻：认不出 `HH:mm` 时用 20:00。 */
export function parseNightlyTime(value: unknown): { hour: number; minute: number } {
  const parsed = parseHourMinute(value);
  return parsed ?? NIGHTLY_FALLBACK;
}

/** 字符串配置统一去掉首尾空白（含全角空格）：多打一个空格不该让城市查不到。 */
export function trimText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^[\s\u3000]+|[\s\u3000]+$/gu, '') : '';
}

/**
 * 读写配置仍用共享的原对象；这里只产出 cleaned 的读视图，
 * 交给地名查找、经纬度解析、缓存键和报错文案。
 */
export function withTrimmedText(cfg: WeatherConfigSection): WeatherConfigSection {
  return {
    ...cfg,
    provider: trimText(cfg.provider) as ProviderId,
    province: trimText(cfg.province),
    city: trimText(cfg.city),
    nmcStationId: trimText(cfg.nmcStationId),
    qweatherHost: trimText(cfg.qweatherHost),
    nightlyPushTime: trimText(cfg.nightlyPushTime),
    cmaUserId: trimText(cfg.cmaUserId),
    cmaApiKey: trimText(cfg.cmaApiKey),
    cmaStationId: trimText(cfg.cmaStationId),
    cmaDataCode: trimText(cfg.cmaDataCode),
    cmaElements: trimText(cfg.cmaElements),
    apihzId: trimText(cfg.apihzId),
    apihzKey: trimText(cfg.apihzKey),
    qweatherKey: trimText(cfg.qweatherKey),
    pirateWeatherKey: trimText(cfg.pirateWeatherKey),
  };
}

/** 三项至少留一项：全关时恢复「现在天气」，并标记这次是强制恢复的。 */
export function normalizeSections(cfg: Pick<WeatherConfigSection, 'showNow' | 'showForecast' | 'showAlerts'>): WeatherSections {
  const now = cfg.showNow === true;
  const forecast = cfg.showForecast === true;
  const alerts = cfg.showAlerts === true;
  if (now || forecast || alerts) return { now, forecast, alerts, coerced: false };
  return { now: true, forecast: false, alerts: false, coerced: true };
}

/** 详略模式：只认 brief，其余一律按 detailed。 */
export function parseDetailMode(value: unknown): DetailMode {
  return value === 'brief' ? 'brief' : 'detailed';
}

type HorizonFlags = Pick<
  WeatherConfigSection,
  'horizon1h' | 'horizon6h' | 'horizon12h' | 'horizon24h' | 'horizon48h'
>;

const horizonKey = (hours: HorizonHours): keyof HorizonFlags =>
  `horizon${hours}h` as keyof HorizonFlags;

export interface HorizonSelection {
  hours: HorizonHours[];
  /** 五个时次全被关掉时为 true，此时按 24 小时档兜底。 */
  coerced: boolean;
}

/** 时次开关：至少留一个；全关时保留 24 小时档，与三项开关的兜底思路一致。 */
export function normalizeHorizons(cfg: HorizonFlags): HorizonSelection {
  const hours = HORIZON_HOURS.filter((value) => cfg[horizonKey(value)] === true);
  if (hours.length > 0) return { hours, coerced: false };
  return { hours: [24], coerced: true };
}

export function needsCoordinates(provider: ProviderId): boolean {
  return provider === 'qweather' || provider === 'openmeteo' || provider === 'pirate';
}

export function needsPlaceNames(provider: ProviderId): boolean {
  return provider === 'apihz' || provider === 'tencent' || provider === 'nmc';
}

const PROVIDER_LABELS: Record<ProviderId, { zh: string; en: string }> = {
  nmc: { zh: '中央气象台（nmc.cn，免密钥）', en: 'CMA/NMC · nmc.cn (no key)' },
  cma: { zh: '中国气象数据网（data.cma.cn，需实名注册/订购）', en: 'China Meteorological Data (data.cma.cn, account)' },
  apihz: { zh: '接口盒子（apihz.cn，免费，需 ID + KEY）', en: 'APIHZ (apihz.cn, free, ID + KEY)' },
  tencent: { zh: '腾讯天气（免密钥，公开页面接口）', en: 'Tencent Weather (no key, public endpoint)' },
  qweather: { zh: '和风天气（QWeather，需 KEY）', en: 'QWeather (KEY required)' },
  openmeteo: { zh: 'Open-Meteo（免密钥，无天气预警）', en: 'Open-Meteo (no key, no alerts)' },
  pirate: { zh: 'Pirate Weather（需 KEY）', en: 'Pirate Weather (KEY required)' },
};

export function providerLabel(provider: ProviderId, language: Language): string {
  return PROVIDER_LABELS[provider][language === 'en' ? 'en' : 'zh'];
}

export function providerOptions(language: Language): Array<{ value: string; label: string }> {
  return PROVIDER_IDS.map((provider) => ({ value: provider, label: providerLabel(provider, language) }));
}

/** 详略模式下拉；文案跟着界面语言。 */
export function detailOptions(language: Language): Array<{ value: string; label: string }> {
  const t = language === 'en' ? EN : ZH;
  return [
    { value: 'brief', label: t.detailBrief },
    { value: 'detailed', label: t.detailDetailed },
  ];
}

const ZH = {
  title: '天气',
  description:
    '现在天气、未来 1/6/12/24/48 小时天气、天气预警各有开关，至少保留一项；三项都关时自动恢复「现在天气」。现在天气与未来天气还能选简略或详细，未来的五个时次可以逐个开关，至少留一个。先选数据源，再填对应的位置与凭证。公开接口都是轮询，不是主动推送：启动时先取一次，之后从本地凌晨 00:00 起按间隔排整点取最新发布。另可打开「每晚推送」，到点递一次明天的天气和当前预警。',
  provider: '数据源',
  providerDescription:
    '主选：中央气象台（免密钥，逐日预报）、中国气象数据网（需实名注册并订购，默认只有观测资料）、接口盒子（免费，需 ID+KEY，3 小时粒度）。备选：腾讯天气（免密钥）、和风天气（需 KEY）。兜底：Open-Meteo（免密钥，无预警）、Pirate Weather（需 KEY）。',
  province: '省 / 直辖市',
  provinceDescription: '例：北京市、甘肃省。中央气象台、腾讯天气、接口盒子按名称查找。',
  city: '城市 / 区县',
  cityDescription: '例：北京、兰州、酒泉。精确到区县时，中央气象台的城市列表通常也能找到。',
  latitude: '纬度',
  latitudeDescription:
    'Open-Meteo、Pirate Weather 与和风天气使用。开启「自动解析经纬度」时会按省市回填；关闭后以这里为准。北京约 39.9042。',
  longitude: '经度',
  longitudeDescription: '与纬度配合使用；开启自动解析时会按省市回填。北京约 116.4074。',
  autoGeocode: '自动解析经纬度',
  autoGeocodeDescription:
    '打开时用 Open-Meteo 的地理编码按省市取经纬度，并回填到上面两项；改地址后不会再沿用旧城市的经纬度。解析失败会明确报错，可在关闭后手填。',
  qweatherHost: '和风天气 · API Host',
  qweatherHostDescription:
    '和风天气控制台里这个项目的 API Host，例如 devapi.qweather.com 或 https://xxxx.re.qweatherapi.com。免费版与商业版地址不同；403 时优先检查这里。可只填域名。',
  nmcStationId: '中央气象台城市代码（可选）',
  nmcStationIdDescription:
    '留空时按上面的省市自动查找，例如北京是 Wqsps。自动查找失败时可从 nmc.cn 城市页的接口地址里复制这个代码。',
  requestEvery: '请求间隔（小时，从凌晨 00:00 起算）',
  requestEveryDescription:
    '从本地凌晨 00:00 起按间隔排整点时次：6 小时即 00:00、06:00、12:00、18:00 各取一次；7 小时即 00:00、07:00、14:00、21:00，之后回到次日 00:00。范围 1–48，默认 6；大于 24 时每天只在 00:00 取一次。启动时无论如何先取一次。中央气象台等公开接口不是推送，本扩展取的是最新发布。',
  nightlyPush: '每晚推送次日天气与预警',
  nightlyPushDescription:
    '到设定时刻投递一条「明天天气 + 当前生效中的预警」，每天一次。明天天气跟随「未来天气」开关，预警跟随「天气预警」开关；两项都关时这条推送没有内容，不会投递。',
  nightlyPushTime: '每晚推送时刻（HH:mm）',
  nightlyPushTimeDescription:
    '本地 24 小时制，例如 20:00。到点时若十分钟内有取过数据就用它，否则先重新请求再投递。',
  showNow: '现在天气',
  showNowDescription: '投递当前天气，并保留 weather_now 工具。',
  showForecast: '未来天气（1/6/12/24/48 小时）',
  showForecastDescription: '投递五个未来时次，并保留 weather_forecast 工具。',
  showAlerts: '天气预警',
  showAlertsDescription: '投递生效中的预警。预警只在新增、解除或等级变化时投递，避免每轮重复报警。',
  nowDetail: '现在天气的详细程度',
  nowDetailDescription:
    '简略只写天气现象与气温（不含体感）；详细照旧，包含湿度、风、降水、气压、能见度与空气质量。weather_now 工具的回执不受这里影响，永远给全。',
  forecastDetail: '未来天气的详细程度',
  forecastDetailDescription:
    '简略每个时次写天气现象、气温与降水概率；详细照旧，再加降水量与风。每晚推送的明天天气跟随这里。weather_forecast 工具的回执不受这里影响，永远给全。',
  horizons: '投递哪些未来时次',
  horizonsDescription: '1/6/12/24/48 小时各自开关，至少留一个；五个都关时自动保留 24 小时。',
  horizon1h: '1 小时后',
  horizon6h: '6 小时后',
  horizon12h: '12 小时后',
  horizon24h: '24 小时后',
  horizon48h: '48 小时后',
  detailBrief: '简略',
  detailDetailed: '详细',
  cmaUserId: '中国气象数据网 · 用户 ID',
  cmaUserIdDescription:
    '先在 https://data.cma.cn/ 实名注册，再到「气象 API 服务」订购资料；用户 ID 从订单或用户中心获取。旧版接口与密钥一起用；新版接口可只填密钥。',
  cmaApiKey: '中国气象数据网 · 密钥 / 密码',
  cmaApiKeyDescription:
    '旧版接口填订单里的 pwd，新版接口填 key。密钥也可放在部署 .env 的 WEATHER_CMA_API_KEY 里。',
  cmaStationId: '中国气象数据网 · 台站号',
  cmaStationIdDescription: '地面观测站号，北京 54511。必须与订购资料里的站点一致。',
  cmaDataCode: '中国气象数据网 · 资料代码',
  cmaDataCodeDescription:
    '默认 SURF_CHN_MUL_HOR（逐小时地面观测）。新版 key 接口会自动改用 SURF_CHN_HOR。是否含预报取决于你订购的资料，本扩展目前只解析观测要素。',
  cmaElements: '中国气象数据网 · 要素列表',
  cmaElementsDescription:
    '逗号分隔。默认取温湿度、降水和风；只能填订单里订过的要素，否则接口会报权限错误。',
  apihzId: '接口盒子 · 用户 ID',
  apihzIdDescription:
    '到 https://www.apihz.cn/ 免费注册；登录后到用户中心复制数字 ID。它和通讯密钥一起填。',
  apihzKey: '接口盒子 · 通讯密钥',
  apihzKeyDescription:
    '接口盒子用户中心里的 key。也可以放在部署 .env 的 WEATHER_APIHZ_KEY 里；ID 对应 WEATHER_APIHZ_ID。',
  qweatherKey: '和风天气 · API KEY',
  qweatherKeyDescription:
    '到 https://dev.qweather.com/ 注册并创建项目，复制 API KEY。也可放在部署 .env 的 WEATHER_QWEATHER_KEY 里。',
  pirateWeatherKey: 'Pirate Weather · API KEY',
  pirateWeatherKeyDescription:
    '到 https://pirateweather.net/ 免费注册，在控制台生成 API KEY。也可放在部署 .env 的 WEATHER_PIRATE_KEY 里。',
} as const;

const EN = {
  title: 'Weather',
  description:
    'Current conditions, 1/6/12/24/48-hour forecasts and alerts each have a switch; at least one stays on, and all-off falls back to current conditions. Current and forecast text can be brief or detailed, and each forecast horizon can be switched off as long as one stays on. Pick a provider, then fill its location and credentials. Public endpoints are polled, not pushed: one fetch at startup, then the latest publication on slots counted from local midnight. A nightly push can deliver tomorrow weather and the alerts in force.',
  provider: 'Provider',
  providerDescription:
    'Primary: NMC (no key, daily forecast), China Meteorological Data (real-name account; observations by default), APIHZ (free, ID + KEY, 3-hour steps). Backup: Tencent Weather (no key), QWeather (KEY). Fallback: Open-Meteo (no key, no alerts), Pirate Weather (KEY).',
  province: 'Province / municipality',
  provinceDescription: 'e.g. 北京市, 甘肃省. NMC, Tencent and APIHZ look it up by name.',
  city: 'City / district',
  cityDescription: 'e.g. 北京, 兰州, 酒泉. NMC also has district-level entries.',
  latitude: 'Latitude',
  latitudeDescription:
    'Used by Open-Meteo, Pirate Weather and QWeather. Auto-geocoding fills it from province/city; turn that off to use this value. Beijing is about 39.9042.',
  longitude: 'Longitude',
  longitudeDescription: 'Used with latitude; auto-geocoding fills it from province/city. Beijing is about 116.4074.',
  autoGeocode: 'Auto-resolve coordinates',
  autoGeocodeDescription:
    'Resolve latitude/longitude from province and city through Open-Meteo geocoding and write them back, so changing the address does not keep the old city coordinates. A failed lookup is reported; turn this off to enter coordinates manually.',
  qweatherHost: 'QWeather · API Host',
  qweatherHostDescription:
    'The API Host shown in the QWeather console for this project, e.g. devapi.qweather.com or https://xxxx.re.qweatherapi.com. Free and commercial plans use different hosts; check this first on 403. A bare domain is fine.',
  nmcStationId: 'NMC city code (optional)',
  nmcStationIdDescription:
    'Leave empty to resolve from province and city (Beijing is Wqsps). If lookup fails, copy the code from an nmc.cn city page request.',
  requestEvery: 'Refresh interval (hours, from local midnight)',
  requestEveryDescription:
    'Fetches are scheduled on slots counted from local 00:00: every 6 hours means 00:00, 06:00, 12:00 and 18:00; every 7 hours means 00:00, 07:00, 14:00, 21:00, then the next 00:00. Range 1–48, default 6; above 24 collapses to one fetch a day at 00:00. One fetch always happens at startup. Public endpoints are polled, not pushed.',
  nightlyPush: 'Nightly next-day weather and alerts',
  nightlyPushDescription:
    'At the set time, deliver one event with tomorrow weather plus the alerts in force, once a day. Tomorrow weather follows the forecast switch and alerts follow the alert switch; with both off there is nothing to say, so nothing is delivered.',
  nightlyPushTime: 'Nightly push time (HH:mm)',
  nightlyPushTimeDescription:
    'Local 24-hour time, e.g. 20:00. At that moment the last fetch is reused when it is under ten minutes old; otherwise weather is requested again first.',
  showNow: 'Current weather',
  showNowDescription: 'Deliver current conditions and keep the weather_now tool.',
  showForecast: 'Forecast (1/6/12/24/48 h)',
  showForecastDescription: 'Deliver five future horizons and keep the weather_forecast tool.',
  showAlerts: 'Weather alerts',
  showAlertsDescription: 'Deliver active alerts. Alerts are delivered only when they appear, clear or change level.',
  nowDetail: 'Detail level of current weather',
  nowDetailDescription:
    'Brief gives the condition and temperature only (no feels-like); detailed keeps humidity, wind, precipitation, pressure, visibility and AQI. The weather_now tool always returns everything.',
  forecastDetail: 'Detail level of the forecast',
  forecastDetailDescription:
    'Brief gives condition, temperature and precipitation probability per horizon; detailed adds precipitation amount and wind. The nightly next-day push follows this. The weather_forecast tool always returns everything.',
  horizons: 'Which forecast horizons to deliver',
  horizonsDescription: 'Switch 1/6/12/24/48 hours individually; at least one stays on, and all-off falls back to 24 hours.',
  horizon1h: '1 hour ahead',
  horizon6h: '6 hours ahead',
  horizon12h: '12 hours ahead',
  horizon24h: '24 hours ahead',
  horizon48h: '48 hours ahead',
  detailBrief: 'Brief',
  detailDetailed: 'Detailed',
  cmaUserId: 'China Meteorological Data · user ID',
  cmaUserIdDescription:
    'Register with real-name verification at https://data.cma.cn/ and subscribe to a meteorological API product; the user ID comes from the order or account centre. Old API uses it with the password; the new key API can use only the key.',
  cmaApiKey: 'China Meteorological Data · key / password',
  cmaApiKeyDescription:
    'For the old API put the order password (pwd); for the new API put the key. May also live in the deployment .env as WEATHER_CMA_API_KEY.',
  cmaStationId: 'China Meteorological Data · station ID',
  cmaStationIdDescription: 'Surface station number; Beijing is 54511. It must match the subscribed data.',
  cmaDataCode: 'China Meteorological Data · data code',
  cmaDataCodeDescription:
    'Defaults to SURF_CHN_MUL_HOR (hourly surface observations). The new key API switches to SURF_CHN_HOR automatically. Forecast data depends on your subscription; this adapter parses observations only.',
  cmaElements: 'China Meteorological Data · elements',
  cmaElementsDescription:
    'Comma separated. Defaults cover temperature, humidity, precipitation and wind; only elements in your order are allowed.',
  apihzId: 'APIHZ · user ID',
  apihzIdDescription: 'Register free at https://www.apihz.cn/ and copy the numeric ID from the account centre.',
  apihzKey: 'APIHZ · key',
  apihzKeyDescription:
    'The communication key from the APIHZ account centre. May also live in the deployment .env as WEATHER_APIHZ_KEY (ID: WEATHER_APIHZ_ID).',
  qweatherKey: 'QWeather · API KEY',
  qweatherKeyDescription:
    'Register at https://dev.qweather.com/, create a project and copy the API KEY. May also live in .env as WEATHER_QWEATHER_KEY.',
  pirateWeatherKey: 'Pirate Weather · API KEY',
  pirateWeatherKeyDescription:
    'Register free at https://pirateweather.net/ and create an API KEY in the dashboard. May also live in .env as WEATHER_PIRATE_KEY.',
} as const;

export function weatherConfigGroup(language: Language): ConfigGroup {
  const t = language === 'en' ? EN : ZH;
  const group: ConfigGroup = {
    id: 'world:weather',
    owner: 'world:weather',
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        'worlds.weather.provider': {
          type: 'string',
          title: t.provider,
          description: t.providerDescription,
          'x-options': 'weatherProvider',
          'x-hot': true,
        },
        'worlds.weather.province': {
          type: 'string',
          title: t.province,
          description: t.provinceDescription,
          'x-hot': true,
        },
        'worlds.weather.city': {
          type: 'string',
          title: t.city,
          description: t.cityDescription,
          'x-hot': true,
        },
        'worlds.weather.latitude': {
          type: 'number',
          title: t.latitude,
          description: t.latitudeDescription,
          minimum: -90,
          maximum: 90,
          'x-hot': true,
        },
        'worlds.weather.longitude': {
          type: 'number',
          title: t.longitude,
          description: t.longitudeDescription,
          minimum: -180,
          maximum: 180,
          'x-hot': true,
        },
        'worlds.weather.autoGeocode': {
          type: 'boolean',
          title: t.autoGeocode,
          description: t.autoGeocodeDescription,
          'x-hot': true,
        },
        'worlds.weather.qweatherHost': {
          type: 'string',
          title: t.qweatherHost,
          description: t.qweatherHostDescription,
          'x-hot': true,
        },
        'worlds.weather.nmcStationId': {
          type: 'string',
          title: t.nmcStationId,
          description: t.nmcStationIdDescription,
          'x-hot': true,
        },
        'worlds.weather.nightlyPushTime': {
          type: 'string',
          title: t.nightlyPushTime,
          description: t.nightlyPushTimeDescription,
          'x-hot': true,
        },
        'worlds.weather.requestEvery': {
          type: 'integer',
          title: t.requestEvery,
          description: t.requestEveryDescription,
          minimum: 1,
          maximum: 48,
          'x-hot': true,
        },
        'worlds.weather.showNow': {
          type: 'boolean',
          title: t.showNow,
          description: t.showNowDescription,
          'x-hot': true,
        },
        'worlds.weather.showForecast': {
          type: 'boolean',
          title: t.showForecast,
          description: t.showForecastDescription,
          'x-hot': true,
        },
        'worlds.weather.showAlerts': {
          type: 'boolean',
          title: t.showAlerts,
          description: t.showAlertsDescription,
          'x-hot': true,
        },
        'worlds.weather.nowDetail': {
          type: 'string',
          title: t.nowDetail,
          description: t.nowDetailDescription,
          'x-options': 'weatherDetail',
          'x-hot': true,
        },
        'worlds.weather.forecastDetail': {
          type: 'string',
          title: t.forecastDetail,
          description: t.forecastDetailDescription,
          'x-options': 'weatherDetail',
          'x-hot': true,
        },
        'worlds.weather.horizon1h': {
          type: 'boolean',
          title: t.horizon1h,
          description: `${t.horizons} · ${t.horizonsDescription}`,
          'x-hot': true,
        },
        'worlds.weather.horizon6h': {
          type: 'boolean',
          title: t.horizon6h,
          description: `${t.horizons} · ${t.horizonsDescription}`,
          'x-hot': true,
        },
        'worlds.weather.horizon12h': {
          type: 'boolean',
          title: t.horizon12h,
          description: `${t.horizons} · ${t.horizonsDescription}`,
          'x-hot': true,
        },
        'worlds.weather.horizon24h': {
          type: 'boolean',
          title: t.horizon24h,
          description: `${t.horizons} · ${t.horizonsDescription}`,
          'x-hot': true,
        },
        'worlds.weather.horizon48h': {
          type: 'boolean',
          title: t.horizon48h,
          description: `${t.horizons} · ${t.horizonsDescription}`,
          'x-hot': true,
        },
        'worlds.weather.nightlyPush': {
          type: 'boolean',
          title: t.nightlyPush,
          description: t.nightlyPushDescription,
          'x-hot': true,
        },
        'worlds.weather.cmaUserId': {
          type: 'string',
          title: t.cmaUserId,
          description: t.cmaUserIdDescription,
          'x-hot': true,
        },
        'worlds.weather.cmaApiKey': {
          type: 'string',
          title: t.cmaApiKey,
          description: t.cmaApiKeyDescription,
          'x-hot': true,
        },
        'worlds.weather.cmaStationId': {
          type: 'string',
          title: t.cmaStationId,
          description: t.cmaStationIdDescription,
          'x-hot': true,
        },
        'worlds.weather.cmaDataCode': {
          type: 'string',
          title: t.cmaDataCode,
          description: t.cmaDataCodeDescription,
          'x-hot': true,
        },
        'worlds.weather.cmaElements': {
          type: 'string',
          title: t.cmaElements,
          description: t.cmaElementsDescription,
          'x-hot': true,
        },
        'worlds.weather.apihzId': {
          type: 'string',
          title: t.apihzId,
          description: t.apihzIdDescription,
          'x-hot': true,
        },
        'worlds.weather.apihzKey': {
          type: 'string',
          title: t.apihzKey,
          description: t.apihzKeyDescription,
          'x-hot': true,
        },
        'worlds.weather.qweatherKey': {
          type: 'string',
          title: t.qweatherKey,
          description: t.qweatherKeyDescription,
          'x-hot': true,
        },
        'worlds.weather.pirateWeatherKey': {
          type: 'string',
          title: t.pirateWeatherKey,
          description: t.pirateWeatherKeyDescription,
          'x-hot': true,
        },
      },
    },
  };
  return group;
}
