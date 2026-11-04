/** 把各家不同的逐小时/逐日数据映射到固定的 1/6/12/24/48 小时。 */
import { HORIZON_HOURS, type DailyPoint, type HourlyPoint, type WeatherHorizon } from './types.ts';
import { formatDateKey, hourOf } from './location.ts';

const HOUR_MS = 3_600_000;

export interface HorizonSource {
  nowMs: number;
  timezone: string;
  hourly: HourlyPoint[];
  daily: DailyPoint[];
}

function nearestIndex(points: readonly HourlyPoint[], targetMs: number): number {
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const diff = Math.abs(points[i].atMs - targetMs);
    if (diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }
  return best;
}

function spacingAt(points: readonly HourlyPoint[], index: number): number {
  const previous = index > 0 ? points[index].atMs - points[index - 1].atMs : Infinity;
  const next = index < points.length - 1 ? points[index + 1].atMs - points[index].atMs : Infinity;
  return Math.min(previous, next);
}

function toleranceFor(spacing: number): number {
  if (!Number.isFinite(spacing)) return 90 * 60_000;
  return Math.max(90 * 60_000, Math.min(spacing / 2 + 60_000, 6 * HOUR_MS));
}

function granularityFor(spacing: number): WeatherHorizon['granularity'] {
  if (!Number.isFinite(spacing)) return 'hour';
  if (spacing <= 1.5 * HOUR_MS) return 'hour';
  if (spacing <= 4.5 * HOUR_MS) return '3h';
  return 'day';
}

function hasDailyData(day: DailyPoint): boolean {
  return (
    day.dayText !== undefined ||
    day.nightText !== undefined ||
    day.dayTempC !== undefined ||
    day.nightTempC !== undefined ||
    day.minTempC !== undefined ||
    day.maxTempC !== undefined ||
    day.precipitationMm !== undefined
  );
}

function pickDaily(
  daily: readonly DailyPoint[],
  targetMs: number,
  timezone: string,
): { day: DailyPoint; isNight: boolean; note: string } | null {
  const usable = daily.filter(hasDailyData);
  if (!usable.length) return null;
  const targetDate = formatDateKey(targetMs, timezone);
  let chosen = usable.find((day) => day.date === targetDate);
  let rangeNote = '';
  if (!chosen) {
    chosen = usable.find((day) => day.date >= targetDate) ?? usable[usable.length - 1];
    rangeNote = '目标时刻超出逐日预报范围，取最近一天。';
  }
  const hour = hourOf(targetMs, timezone);
  const isNight = hour < 6 || hour >= 18;
  const period = isNight ? '夜间' : '白天';
  return {
    day: chosen,
    isNight,
    note: `逐日预报：按目标时刻所属的${period}时段取值。${rangeNote}${chosen.note ?? ''}`,
  };
}

function minOf(...values: Array<number | undefined>): number | undefined {
  const nums = values.filter((value): value is number => value !== undefined);
  return nums.length ? Math.min(...nums) : undefined;
}

function maxOf(...values: Array<number | undefined>): number | undefined {
  const nums = values.filter((value): value is number => value !== undefined);
  return nums.length ? Math.max(...nums) : undefined;
}

function dailyHorizon(hours: WeatherHorizon['hours'], targetMs: number, picked: ReturnType<typeof pickDaily>): WeatherHorizon {
  if (!picked) {
    return { hours, targetMs, granularity: 'day', note: '没有可用的未来预报数据。' };
  }
  const { day, isNight, note } = picked;
  const min = minOf(day.minTempC, day.dayTempC, day.nightTempC);
  const max = maxOf(day.maxTempC, day.dayTempC, day.nightTempC);
  const point = isNight ? day.nightTempC ?? min : day.dayTempC ?? max;
  const condition = isNight ? day.nightText ?? day.dayText : day.dayText ?? day.nightText;
  const windDir = isNight ? day.nightWindDir ?? day.dayWindDir : day.dayWindDir ?? day.nightWindDir;
  const windScale = isNight ? day.nightWindScale ?? day.dayWindScale : day.dayWindScale ?? day.nightWindScale;
  return {
    hours,
    targetMs,
    granularity: 'day',
    ...(condition !== undefined ? { condition } : {}),
    ...(point !== undefined ? { temperatureC: point } : {}),
    ...(min !== undefined ? { temperatureMinC: min } : {}),
    ...(max !== undefined ? { temperatureMaxC: max } : {}),
    ...(day.precipitationMm !== undefined ? { precipitationMm: day.precipitationMm } : {}),
    ...(day.precipitationProbabilityPct !== undefined
      ? { precipitationProbabilityPct: day.precipitationProbabilityPct }
      : {}),
    ...(windDir !== undefined ? { windDir } : {}),
    ...(windScale !== undefined ? { windScale } : {}),
    note,
  };
}

/** 每个时次优先取最接近的逐小时点；超出逐小时范围或没有逐小时源时回落到逐日时段。 */
export function buildHorizons(source: HorizonSource): WeatherHorizon[] {
  const hourly = [...source.hourly]
    .filter((point) => Number.isFinite(point.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  const usableHourly = hourly.filter((point) => point.atMs >= source.nowMs - HOUR_MS);
  return HORIZON_HOURS.map((hours) => {
    const targetMs = source.nowMs + hours * HOUR_MS;
    if (usableHourly.length) {
      const index = nearestIndex(usableHourly, targetMs);
      const point = usableHourly[index];
      const spacing = spacingAt(usableHourly, index);
      const tolerance = toleranceFor(spacing);
      if (point && Math.abs(point.atMs - targetMs) <= tolerance) {
        const granularity = granularityFor(spacing);
        const diffMinutes = Math.round(Math.abs(point.atMs - targetMs) / 60_000);
        return {
          hours,
          targetMs,
          granularity,
          ...(point.condition !== undefined ? { condition: point.condition } : {}),
          ...(point.temperatureC !== undefined ? { temperatureC: point.temperatureC } : {}),
          ...(point.precipitationMm !== undefined ? { precipitationMm: point.precipitationMm } : {}),
          ...(point.precipitationProbabilityPct !== undefined
            ? { precipitationProbabilityPct: point.precipitationProbabilityPct }
            : {}),
          ...(point.windDir !== undefined ? { windDir: point.windDir } : {}),
          ...(point.windScale !== undefined ? { windScale: point.windScale } : {}),
          ...(point.windSpeedMps !== undefined ? { windSpeedMps: point.windSpeedMps } : {}),
          ...(point.humidityPct !== undefined ? { humidityPct: point.humidityPct } : {}),
          ...(granularity !== 'hour' || diffMinutes > 60
            ? { note: `取最接近目标时刻的时次（相差 ${diffMinutes} 分钟）。` }
            : {}),
        };
      }
    }
    return dailyHorizon(hours, targetMs, pickDaily(source.daily, targetMs, source.timezone));
  });
}
