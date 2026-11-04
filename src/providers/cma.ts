/**
 * 中国气象数据网 data.cma.cn 官方 API。
 * 这里接入的是它最常见的地面气象站观测接口（旧版 userId+pwd，新版 key），
 * 默认资料代码是 SURF_CHN_MUL_HOR / SURF_CHN_HOR。该资料只有实况，没有未来预报；
 * 天气预报与气象灾害预警属于另行订购的产品，本适配器不伪造。
 */
import type { ProviderRequest, WeatherLocation, WeatherNow, WeatherSnapshot } from '../types.ts';
import { parseNumber, parsePrecipitation, windDirectionFromDegree } from '../location.ts';
import { credentialIssue, resolveCredential, SECRET_NAMES } from '../credentials.ts';
import { cleanMessage, providerName, text } from './shared.ts';
import { DEFAULT_CMA_ELEMENTS } from '../config.ts';

type Json = Record<string, unknown>;

const OLD_BASE = 'http://api.data.cma.cn:8090/api';
const NEW_BASE = 'http://api.data.cma.cn/api';

function asRecord(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function stamp(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}0000`;
}

/** 新旧接口的字段名不完全一样；按别名取第一个有值的。 */
function field(row: Json, names: readonly string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== '') return row[name];
  }
  return undefined;
}

function findRows(value: unknown, depth = 0): Json[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) {
    const rows = value.map(asRecord).filter((item): item is Json => item !== null);
    return rows.length ? rows : [];
  }
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ['DS', 'ds', 'data', 'DATA', 'rows', 'list', 'result']) {
    const found = findRows(record[key], depth + 1);
    if (found.length) return found;
  }
  return [];
}

function observedAt(row: Json): number | undefined {
  const year = parseNumber(field(row, ['Year', 'year', 'YEAR']));
  const month = parseNumber(field(row, ['Mon', 'Month', 'month', 'MON']));
  const day = parseNumber(field(row, ['Day', 'day', 'DAY']));
  const hour = parseNumber(field(row, ['Hour', 'hour', 'HOUR']));
  if (year === undefined || month === undefined || day === undefined || hour === undefined) return undefined;
  const ms = Date.UTC(year, month - 1, day, hour);
  return Number.isFinite(ms) ? ms : undefined;
}

function phenomenon(value: unknown): string | undefined {
  const label = text(value);
  if (!label) return undefined;
  return /[\u4e00-\u9fa5]/.test(label) ? label : undefined;
}

function parseNow(row: Json): WeatherNow | undefined {
  const directionValue = field(row, ['WIN_D_Inst_Max', 'WIN_D_Max', 'WIN_D_Avg', 'WIN_D_Inst', 'WIN_D']);
  const directionText = text(directionValue);
  const direction =
    directionText && /[\u4e00-\u9fa5]/.test(directionText)
      ? directionText
      : windDirectionFromDegree(directionValue);
  const temperature = parseNumber(field(row, ['TEM', 'Tem', 'tem', 'TEM_Avg']));
  const humidity = parseNumber(field(row, ['RHU', 'Rhu', 'rhu', 'RHU_Avg']));
  const pressure = parseNumber(field(row, ['PRS', 'Prs', 'prs', 'PRS_Sea']));
  const precipitation = parsePrecipitation(field(row, ['PRE_1h', 'PRE_1H', 'Pre_1h', 'PRE']));
  const windSpeed = parseNumber(
    field(row, ['WIN_S_Inst_Max', 'WIN_S_Max', 'WIN_S_Avg', 'WIN_S_Inst', 'WIN_S']),
  );
  const observed = observedAt(row);
  const weather = phenomenon(field(row, ['WEP_Now', 'WEP', 'Weather', 'weather', 'WEP_Inst']));
  const now: WeatherNow = {
    ...(observed !== undefined ? { observedAtMs: observed } : {}),
    ...(weather ? { condition: weather } : {}),
    ...(temperature !== undefined ? { temperatureC: temperature } : {}),
    ...(humidity !== undefined ? { humidityPct: humidity } : {}),
    ...(pressure !== undefined ? { pressureHpa: pressure } : {}),
    ...(precipitation !== undefined ? { precipitationMm: precipitation } : {}),
    ...(direction ? { windDir: direction } : {}),
    ...(windSpeed !== undefined ? { windSpeedMps: windSpeed } : {}),
  };
  return Object.values(now).some((value) => value !== undefined) ? now : undefined;
}

function checkReturn(payload: Json): void {
  const rawCode = payload.returnCode ?? payload.code;
  const code = typeof rawCode === 'number' ? String(rawCode) : text(rawCode);
  if (code === undefined || code === '0' || code === '200') return;
  const message = text(payload.returnMessage) ?? text(payload.msg) ?? text(payload.message) ?? '未知错误';
  throw new Error(`中国气象数据网返回错误 ${code}：${cleanMessage(message)}。`);
}

function latestRow(rows: readonly Json[]): Json | undefined {
  return [...rows].sort((a, b) => (observedAt(b) ?? 0) - (observedAt(a) ?? 0))[0];
}

async function requestRows(
  req: ProviderRequest,
  userId: string,
  key: string,
  effectiveCode: string,
  station: string,
  elements: string,
): Promise<Json[]> {
  if (userId) {
    const to = Date.UTC(
      new Date(req.nowMs).getUTCFullYear(),
      new Date(req.nowMs).getUTCMonth(),
      new Date(req.nowMs).getUTCDate(),
      new Date(req.nowMs).getUTCHours(),
    );
    const from = to - 3 * 3_600_000;
    const params = new URLSearchParams({
      userId,
      pwd: key,
      dataFormat: 'json',
      interfaceId: 'getSurfEleByTimeRangeAndStaID',
      dataCode: effectiveCode,
      timeRange: `[${stamp(from)},${stamp(to)}]`,
      staIDs: station,
      elements,
    });
    const payload = await req.fetchJson<Json>(`${OLD_BASE}?${params.toString()}`);
    checkReturn(payload);
    return findRows(payload);
  }

  // 新版 key 接口按单个时次取；当前整点还没出数时往前退一小时。
  for (let back = 0; back <= 3; back += 1) {
    const at = Date.UTC(
      new Date(req.nowMs).getUTCFullYear(),
      new Date(req.nowMs).getUTCMonth(),
      new Date(req.nowMs).getUTCDate(),
      new Date(req.nowMs).getUTCHours() - back,
    );
    const params = new URLSearchParams({
      key,
      data: effectiveCode,
      staIDs: station,
      time: stamp(at),
    });
    const payload = await req.fetchJson<Json>(`${NEW_BASE}?${params.toString()}`);
    checkReturn(payload);
    const rows = findRows(payload);
    if (rows.length) return rows;
  }
  return [];
}

/** 订单可能只订了部分要素；遇到要素权限错误时逐级退到更小的集合。 */
function elementAttempts(configured: string): string[] {
  const attempts = [
    configured,
    'Station_Id_C,Year,Mon,Day,Hour,TEM,RHU',
    'Station_Id_C,Year,Mon,Day,Hour,TEM',
  ];
  return attempts.filter((item, index) => item && attempts.indexOf(item) === index);
}

function isElementError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /要素|权限|无权|元素|element|not\s+author|not\s+subscrib/i.test(message);
}

async function fetchRows(req: ProviderRequest, userId: string, key: string): Promise<Json[]> {
  const station = req.cfg.cmaStationId.trim();
  const dataCode = req.cfg.cmaDataCode.trim() || 'SURF_CHN_MUL_HOR';
  const newStyle = !userId;
  const effectiveCode = newStyle && dataCode === 'SURF_CHN_MUL_HOR' ? 'SURF_CHN_HOR' : dataCode;
  let lastError: unknown;
  for (const elements of elementAttempts(req.cfg.cmaElements.trim() || DEFAULT_CMA_ELEMENTS)) {
    try {
      return await requestRows(req, userId, key, effectiveCode, station, elements);
    } catch (error) {
      lastError = error;
      if (!isElementError(error)) throw error;
    }
  }
  throw lastError ?? new Error('中国气象数据网请求失败。');
}

export async function fetchCma(req: ProviderRequest): Promise<WeatherSnapshot> {
  const issue = credentialIssue(req.cfg, req.secret);
  if (issue) throw new Error(issue);
  const userId = resolveCredential(req.cfg.cmaUserId, SECRET_NAMES.cmaUserId, req.secret);
  const key = resolveCredential(req.cfg.cmaApiKey, SECRET_NAMES.cmaApiKey, req.secret);
  const rows = await fetchRows(req, userId, key);
  const row = latestRow(rows);
  if (!row) {
    throw new Error(
      `中国气象数据网没有返回台站 ${req.cfg.cmaStationId} 最近几小时的观测数据。请确认台站号、资料代码和要素都在订单范围内，且今日配额未用完。`,
    );
  }
  const now = parseNow(row);
  const observed = observedAt(row);
  const location: WeatherLocation = {
    province: req.cfg.province,
    city: req.cfg.city,
    latitude: req.cfg.latitude,
    longitude: req.cfg.longitude,
    stationId: req.cfg.cmaStationId,
  };
  const limitations = [
    '中国气象数据网默认接入的是地面气象站观测资料（SURF_CHN_MUL_HOR / SURF_CHN_HOR），不含未来预报。',
    '该数据网的天气预报和气象灾害预警是另行订购的产品，本扩展没有接入；要未来天气和预警请换用其他数据源。',
    '接口时间以世界时（GMT）为准；正文里的观测时间已按配置时区换算。',
  ];

  return {
    provider: 'cma',
    providerName: providerName('cma'),
    timezone: req.timezone,
    location,
    fetchedAtMs: req.nowMs,
    ...(observed !== undefined ? { publishedAtMs: observed } : {}),
    ...(now ? { now } : {}),
    horizons: [],
    alerts: [],
    capabilities: { now: true, forecast: false, hourly: false, alerts: false },
    limitations,
    alertsNote: '中国气象数据网的天气预警需要单独订购，本扩展未接入。',
  };
}
