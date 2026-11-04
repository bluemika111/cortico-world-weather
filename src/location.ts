/** 时间、地名与数字的小工具：纯函数，方便单测。 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, format);
  }
  return format;
}

export function localParts(at: number, timezone: string): LocalParts {
  const fields: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(at))) {
    if (part.type !== 'literal') fields[part.type] = part.value;
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  };
}

function offsetAt(at: number, timezone: string): number {
  const p = localParts(at, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
}

/** 把「某地墙上时间」换算成绝对时刻；夏令时用两轮逼近。 */
export function wallTimeToMs(
  wall: Pick<LocalParts, 'year' | 'month' | 'day' | 'hour' | 'minute'> & { second?: number },
  timezone: string,
): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
  const first = naive - offsetAt(naive, timezone);
  return naive - offsetAt(first, timezone);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function formatLocalDateTime(at: number, timezone: string): string {
  const p = localParts(at, timezone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function formatShortStamp(at: number, timezone: string): string {
  const p = localParts(at, timezone);
  return `${pad2(p.month)}月${pad2(p.day)}日 ${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function formatDateKey(at: number, timezone: string): string {
  const p = localParts(at, timezone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function hourOf(at: number, timezone: string): number {
  return localParts(at, timezone).hour;
}

const HOUR_MS = 3_600_000;

function midnightOn(at: number, timezone: string, dayOffset: number): number {
  const p = localParts(at, timezone);
  return wallTimeToMs({ year: p.year, month: p.month, day: p.day + dayOffset, hour: 0, minute: 0 }, timezone);
}

/**
 * 从本地凌晨 00:00 起算的下一个取数时次，结果一定晚于 `nowMs`。
 * 间隔 6 小时即 00:00、06:00、12:00、18:00；间隔不能整除一天时，回到次日 00:00 重新排。
 * 间隔大于一天时每天只在 00:00 取一次。
 */
export function nextSlotAt(nowMs: number, timezone: string, everyHours: number): number {
  const hours = Math.max(1, Math.floor(Number.isFinite(everyHours) ? everyHours : 1));
  const step = hours * HOUR_MS;
  const today = midnightOn(nowMs, timezone, 0);
  const tomorrow = midnightOn(nowMs, timezone, 1);
  const index = Math.floor((nowMs - today) / step);
  const slot = today + (index + 1) * step;
  return slot < tomorrow ? slot : tomorrow;
}

/** 下一个本地 `HH:mm` 时刻，结果一定晚于 `nowMs`。 */
export function nextWallClockAt(nowMs: number, timezone: string, hour: number, minute: number): number {
  const p = localParts(nowMs, timezone);
  const todayAt = wallTimeToMs({ year: p.year, month: p.month, day: p.day, hour, minute }, timezone);
  if (todayAt > nowMs) return todayAt;
  const tomorrow = localParts(midnightOn(nowMs, timezone, 1), timezone);
  return wallTimeToMs({ year: tomorrow.year, month: tomorrow.month, day: tomorrow.day, hour, minute }, timezone);
}

/** 次日正午的绝对时刻，用于按本地日期取「明天」。 */
export function tomorrowNoonMs(nowMs: number, timezone: string): number {
  const p = localParts(nowMs, timezone);
  return wallTimeToMs({ year: p.year, month: p.month, day: p.day + 1, hour: 12, minute: 0 }, timezone);
}

function validParts(wall: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}): boolean {
  return (
    Number.isFinite(wall.year) &&
    wall.month >= 1 &&
    wall.month <= 12 &&
    wall.day >= 1 &&
    wall.day <= 31 &&
    wall.hour >= 0 &&
    wall.hour <= 23 &&
    wall.minute >= 0 &&
    wall.minute <= 59
  );
}

/**
 * 读取数据源常见的几种时间写法：
 * `2026-11-02 20:15`、`2026/11/02 20:05`、`202611022030`、`2026-11-02T20:45`、
 * 以及带 Z / +08:00 的 ISO。空串、`9999` 与无法识别的值返回 undefined。
 */
export function parseLocalStamp(value: unknown, timezone: string): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text === '9999' || text === '9999-99-99') return undefined;

  if (/^\d{14}$/.test(text)) {
    const wall = {
      year: Number(text.slice(0, 4)),
      month: Number(text.slice(4, 6)),
      day: Number(text.slice(6, 8)),
      hour: Number(text.slice(8, 10)),
      minute: Number(text.slice(10, 12)),
      second: Number(text.slice(12, 14)),
    };
    return validParts(wall) ? wallTimeToMs(wall, timezone) : undefined;
  }
  if (/^\d{12}$/.test(text)) {
    const wall = {
      year: Number(text.slice(0, 4)),
      month: Number(text.slice(4, 6)),
      day: Number(text.slice(6, 8)),
      hour: Number(text.slice(8, 10)),
      minute: Number(text.slice(10, 12)),
    };
    return validParts(wall) ? wallTimeToMs(wall, timezone) : undefined;
  }

  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const wall = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4] ?? 0),
      minute: Number(match[5] ?? 0),
      second: Number(match[6] ?? 0),
    };
    return validParts(wall) ? wallTimeToMs(wall, timezone) : undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

export function parseHourMinute(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

/** 去掉行政区后缀，方便「北京市」与「北京」、「酒泉市」与「酒泉」对上。 */
export function stripAdminSuffix(name: string): string {
  return name
    .trim()
    .replace(/(特别行政区|自治区|自治州|地区|省|市|盟|区|县|旗)$/u, '')
    .trim();
}

export function namesMatch(a: string, b: string): boolean {
  const match = (left: string, right: string): boolean =>
    left === right || left.includes(right) || right.includes(left);
  const left = stripAdminSuffix(a);
  const right = stripAdminSuffix(b);
  if (!left || !right) return false;
  if (match(left, right)) return true;
  return cityCores(a).some((core) => cityCores(b).some((other) => match(core, other)));
}

/**
 * 一个地名可能包含的行政核心：
 * 「南宁市武鸣区」→ 南宁市武鸣、武鸣；「北京市」→ 北京。
 * 用于优先匹配区县，而不是一上来就退回地级市。
 */
export function cityCores(name: string): string[] {
  const raw = name.trim();
  const cores = new Set<string>([stripAdminSuffix(raw)]);
  const afterCity = raw.split('市').slice(1).join('市');
  if (afterCity) cores.add(stripAdminSuffix(afterCity));
  return [...cores].filter(Boolean);
}

/** 省级名称的短写法：广西壮族自治区 → 广西，北京市 → 北京。 */
export function shortProvince(name: string): string {
  return name
    .trim()
    .replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市)$/u, '')
    .trim();
}

/** 区县名前面的地级市：南宁市武鸣区 → 南宁市；已经是地级市时返回 undefined。 */
export function prefectureCity(city: string): string | undefined {
  const trimmed = city.trim();
  const match = trimmed.match(/^(.+?(?:市|自治州|地区|盟)).*$/u);
  if (!match) return undefined;
  return match[1] === trimmed ? undefined : match[1];
}

export interface PlaceCandidate {
  province: string;
  city: string;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return values
    .map((value) => value?.trim() ?? '')
    .filter((value, index, all) => value !== '' && all.indexOf(value) === index);
}

/**
 * 接口盒子和腾讯天气只认到地级市。把「广西壮族自治区 / 南宁市武鸣区」
 * 展开成几组可尝试的名称，顺序从最贴近配置到最宽松。
 */
export function placeCandidates(province: string, city: string): PlaceCandidate[] {
  const rawProvince = province.trim();
  const short = shortProvince(rawProvince);
  const rawCity = city.trim();
  const prefecture = prefectureCity(rawCity);
  const stripped = stripAdminSuffix(rawCity);
  const withCitySuffix =
    /[市州盟]$/u.test(rawCity) || /[区县旗]$/u.test(rawCity) ? undefined : `${rawCity}市`;
  const provinces = uniqueStrings([rawProvince, short]);
  const cities = uniqueStrings([rawCity, prefecture, stripped, withCitySuffix]);

  const preferred: Array<PlaceCandidate | null> = [
    rawProvince && rawCity ? { province: rawProvince, city: rawCity } : null,
    rawProvince && prefecture ? { province: rawProvince, city: prefecture } : null,
    short && prefecture ? { province: short, city: prefecture } : null,
    short && rawCity ? { province: short, city: rawCity } : null,
    rawProvince && stripped ? { province: rawProvince, city: stripped } : null,
    short && stripped ? { province: short, city: stripped } : null,
  ];
  for (const provinceName of provinces) {
    for (const cityName of cities) preferred.push({ province: provinceName, city: cityName });
  }
  const seen = new Set<string>();
  return preferred.filter((pair): pair is PlaceCandidate => {
    if (!pair) return false;
    const key = `${pair.province}|${pair.city}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const WIND_DIRECTIONS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'] as const;

export function windDirectionFromDegree(value: unknown): string | undefined {
  const deg = parseNumber(value);
  if (deg === undefined) return undefined;
  const normalized = ((deg % 360) + 360) % 360;
  return `${WIND_DIRECTIONS[Math.round(normalized / 45) % 8]}风`;
}

const MISSING_NUMBERS = new Set([9999, 99999, 999999, 9999999, -9999]);

/** 解析 `8.5`、`"5.4℃"`、`"3.3m/s"`、`"74.2%"` 这类带单位的数字；缺测哨兵值当作没有。 */
export function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return MISSING_NUMBERS.has(value) ? undefined : value;
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/,/g, '');
  if (!text || text === '9999' || text === '999999') return undefined;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || MISSING_NUMBERS.has(n)) return undefined;
  return n;
}

export function parsePrecipitation(value: unknown): number | undefined {
  if (typeof value === 'string' && /无降水|无雨|无雪|无/.test(value)) return 0;
  return parseNumber(value);
}

export function validText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text === '9999' || text === '-' || text === '—' || text === 'null') return undefined;
  return text;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
