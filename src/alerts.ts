/** 把各家的预警对齐到中央气象台的四级体系：蓝、黄、橙、红。 */
import type { AlertLevel, WeatherAlert } from './types.ts';
import { parseLocalStamp, validText } from './location.ts';

const NMC_TYPES = [
  '暴雨', '暴雪', '寒潮', '大风', '沙尘暴', '高温', '干旱', '雷电', '冰雹', '霜冻',
  '大雾', '霾', '道路结冰', '道路冰雪', '台风', '龙卷风', '强对流', '地质灾害', '山洪', '渍涝',
  '雪灾', '低温', '海上大风', '森林火险', '草原火险', '臭氧', '重污染',
] as const;

const ENGLISH_TYPES: Array<[RegExp, string]> = [
  [/rain|flood/i, '暴雨'],
  [/snow|winter storm|blizzard/i, '暴雪'],
  [/thunder|lightning/i, '雷电'],
  [/hail/i, '冰雹'],
  [/wind|gale/i, '大风'],
  [/cold|freeze|chill/i, '寒潮'],
  [/frost/i, '霜冻'],
  [/ice/i, '道路结冰'],
  [/fog/i, '大雾'],
  [/heat/i, '高温'],
  [/dust|sand/i, '沙尘暴'],
  [/typhoon|hurricane|cyclone/i, '台风'],
  [/drought/i, '干旱'],
  [/tornado/i, '龙卷风'],
];

const LEVEL_RANK: Record<AlertLevel, number> = { 红色: 5, 橙色: 4, 黄色: 3, 蓝色: 2, 未知: 1 };

export function levelFrom(value: unknown): AlertLevel {
  if (typeof value !== 'string') return '未知';
  const text = value.trim().toLowerCase();
  if (!text) return '未知';
  if (/红|red|extreme/.test(text)) return '红色';
  if (/橙|orange|severe/.test(text)) return '橙色';
  if (/黄|yellow|moderate/.test(text)) return '黄色';
  if (/蓝|blue|minor/.test(text)) return '蓝色';
  return '未知';
}

export function typeFrom(value: unknown, title?: string): string {
  const supplied = validText(value);
  if (supplied && !/^\d+$/.test(supplied) && !/^20\d{2}/.test(supplied)) {
    const known = NMC_TYPES.find((type) => supplied.includes(type));
    if (known) return known;
    if (supplied.length <= 12) return supplied;
  }
  const source = `${supplied ?? ''} ${title ?? ''}`;
  const known = NMC_TYPES.find((type) => source.includes(type));
  if (known) return known;
  for (const [pattern, type] of ENGLISH_TYPES) {
    if (pattern.test(source)) return type;
  }
  return supplied ?? '气象预警';
}

export function senderFromTitle(title: string): string | undefined {
  const match = title.match(/^(.{2,40}?(?:气象台|预警中心|气象局))发布/);
  return match?.[1];
}

const CN_STAMP = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})时(?:\s*(\d{1,2})分)?/;
const ISO_STAMP = /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?/;
const pad2 = (value: string): string => value.padStart(2, '0');

/**
 * 中央气象台同一份预警在两个接口里措辞不同：站点接口的标题里嵌着发报时间，列表接口没有。
 * 把那段时间摘掉，标题才能对齐去重；摘下来的时间在没有 issuetime 时当发报时间用。
 */
export function normalizeAlertTitle(title: string, timezone: string): { title: string; at?: number } {
  for (const pattern of [CN_STAMP, ISO_STAMP]) {
    const match = title.match(pattern);
    if (!match) continue;
    const cleaned = title.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
    // 整条标题只有时间时别切，否则会变成空标题。
    if (cleaned.length < 6) continue;
    const wall = `${match[1]}-${pad2(match[2] ?? '')}-${pad2(match[3] ?? '')} ${pad2(match[4] ?? '')}:${pad2(match[5] ?? '0')}`;
    return { title: cleaned, at: parseLocalStamp(wall, timezone) };
  }
  return { title: title.trim() };
}

export function makeAlert(input: {
  id?: unknown;
  type?: unknown;
  level?: unknown;
  title?: unknown;
  issuedAt?: unknown;
  expiresAt?: unknown;
  description?: unknown;
  sender?: unknown;
  url?: unknown;
  timezone: string;
}): WeatherAlert | null {
  const rawTitle = validText(input.title);
  const stamped = rawTitle === undefined ? undefined : normalizeAlertTitle(rawTitle, input.timezone);
  const title = stamped?.title;
  const type = typeFrom(input.type, title);
  const level = levelFrom(input.level ?? title);
  if (!title && type === '气象预警' && level === '未知') return null;
  const issued = parseLocalStamp(input.issuedAt, input.timezone) ?? stamped?.at;
  const expires = parseLocalStamp(input.expiresAt, input.timezone);
  const description = validText(input.description);
  const sender = validText(input.sender) ?? senderFromTitle(title ?? '');
  const url = validText(input.url);
  const id = validText(input.id) ?? `${type}|${level}|${title ?? ''}|${issued ?? ''}`;
  return {
    id,
    type,
    level,
    title: title ?? `${type}${level === '未知' ? '' : level}预警`,
    ...(issued !== undefined ? { issuedAtMs: issued } : {}),
    ...(expires !== undefined ? { expiresAtMs: expires } : {}),
    ...(description ? { description } : {}),
    ...(sender ? { sender } : {}),
    ...(url ? { url } : {}),
  };
}

export function dedupeAlerts(alerts: readonly WeatherAlert[]): WeatherAlert[] {
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  const out: WeatherAlert[] = [];
  for (const alert of alerts) {
    // 标题里已含发布单位和类别，同类型同等级的同一标题就是同一条预警；
    // 不把发报时间放进键里，两个接口给的时间偶尔会差一分钟。
    const contentKey = `${alert.type}|${alert.level}|${alert.title}`;
    if (seenIds.has(alert.id) || seenContent.has(contentKey)) continue;
    seenIds.add(alert.id);
    seenContent.add(contentKey);
    out.push(alert);
  }
  return out;
}

export function sortAlerts(alerts: readonly WeatherAlert[]): WeatherAlert[] {
  return [...alerts].sort((a, b) => {
    const rank = LEVEL_RANK[b.level] - LEVEL_RANK[a.level];
    if (rank !== 0) return rank;
    return (b.issuedAtMs ?? 0) - (a.issuedAtMs ?? 0);
  });
}

export function alertsSignature(alerts: readonly WeatherAlert[]): string {
  return sortAlerts(alerts)
    .map((alert) => `${alert.id}|${alert.type}|${alert.level}|${alert.title}`)
    .join('\n');
}
