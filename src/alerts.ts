/** 把各家的预警对齐到中央气象台的四级体系：蓝、黄、橙、红。 */
import type { AlertLevel, WeatherAlert } from './types.ts';
import { parseLocalStamp, validText } from './location.ts';

const NMC_TYPES = [
  '暴雨', '暴雪', '寒潮', '大风', '沙尘暴', '高温', '干旱', '雷电', '冰雹', '霜冻',
  '大雾', '霾', '道路结冰', '台风', '龙卷风', '强对流', '地质灾害', '山洪', '渍涝',
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
  const title = validText(input.title);
  const type = typeFrom(input.type, title);
  const level = levelFrom(input.level ?? title);
  if (!title && type === '气象预警' && level === '未知') return null;
  const issued = parseLocalStamp(input.issuedAt, input.timezone);
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
    const contentKey = `${alert.title}|${alert.level}|${alert.issuedAtMs ?? ''}`;
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
