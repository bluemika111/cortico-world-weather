/** 交给模型的事件正文与工具回执：只写数据源能确认的事实。 */
import type {
  DailyPoint,
  DetailMode,
  HorizonHours,
  WeatherHorizon,
  WeatherSections,
  WeatherSnapshot,
} from './types.ts';
import { formatDateKey, formatLocalDateTime, formatShortStamp, round1, tomorrowNoonMs } from './location.ts';

const num = (value: number): string => String(round1(value));

/** 数据源写的自由文本：压平空白、限长，换行与连续空格都不会带进对话。 */
function flat(text: string, limit: number): string {
  const clipped = text.replace(/\s+/gu, ' ').trim();
  return clipped.length > limit ? `${clipped.slice(0, limit)}…` : clipped;
}

/** 上面再包一层书名号，明确标出这段是对方写的原文，不是我们自己的话。 */
function quoted(text: string, limit = 120): string {
  return `「${flat(text, limit)}」`;
}

function place(snapshot: WeatherSnapshot): string {
  const name = snapshot.location.city || snapshot.location.province || '当前位置';
  // 地名可能来自数据源的字段，同样只保留压平后的短文本。
  return flat(name, 40);
}

function temperature(value: number): string {
  return `${num(value)}°C`;
}

function horizonTemperature(horizon: WeatherHorizon): string | undefined {
  const min = horizon.temperatureMinC;
  const max = horizon.temperatureMaxC;
  if (min !== undefined && max !== undefined && Math.abs(max - min) >= 0.5) {
    return `${num(min)}~${num(max)}°C`;
  }
  if (horizon.temperatureC !== undefined) return temperature(horizon.temperatureC);
  if (min !== undefined) return temperature(min);
  if (max !== undefined) return temperature(max);
  return undefined;
}

function windText(dir: string | undefined, scale: string | undefined, speed: number | undefined): string | undefined {
  const parts = [dir, scale].filter(isText).map(token);
  const base = parts.join(' ');
  if (!base) return speed !== undefined ? `${num(speed)} m/s` : undefined;
  if (speed !== undefined) return `${base}（${num(speed)} m/s）`;
  return base;
}

function publishSuffix(snapshot: WeatherSnapshot): string {
  const at = snapshot.publishedAtMs ?? snapshot.now?.observedAtMs;
  return at !== undefined ? `，发布于 ${formatLocalDateTime(at, snapshot.timezone)}` : '';
}

function granularityLabel(granularity: WeatherHorizon['granularity']): string {
  if (granularity === 'hour') return '逐小时';
  if (granularity === '3h') return '3 小时粒度';
  return '逐日';
}

/** 短时值字段（天气现象、风向等）：压平并限长，不逐条加书名号。 */
function token(text: string): string {
  return flat(text, 24);
}

const isText = (value: string | undefined): value is string => typeof value === 'string' && value.length > 0;

/** 数据源自己写的说明性文字：压平并放宽限长。 */
function prose(text: string): string {
  return flat(text, 200);
}

export function renderNow(snapshot: WeatherSnapshot, mode: DetailMode = 'detailed'): string {
  const city = place(snapshot);
  const now = snapshot.now;
  if (!now) {
    return `现在天气（${city}）：${snapshot.providerName} 没有返回当前天气。`;
  }
  const lines = [`现在天气（${city}）：`];
  if (mode === 'brief') {
    if (now.condition) lines.push(`- 天气：${token(now.condition)}`);
    if (now.temperatureC !== undefined) lines.push(`- 气温：${temperature(now.temperatureC)}`);
    if (lines.length === 1) lines.push('- 该数据源没有返回天气现象或气温。');
    lines.push(`数据源：${snapshot.providerName}${publishSuffix(snapshot)}。`);
    return lines.join('\n');
  }
  if (now.condition) lines.push(`- 天气：${token(now.condition)}`);
  if (now.temperatureC !== undefined) {
    const feel = now.feelsLikeC !== undefined ? `（体感 ${temperature(now.feelsLikeC)}）` : '';
    lines.push(`- 气温：${temperature(now.temperatureC)}${feel}`);
  } else if (now.feelsLikeC !== undefined) {
    lines.push(`- 体感：${temperature(now.feelsLikeC)}`);
  }
  if (now.humidityPct !== undefined) lines.push(`- 湿度：${Math.round(now.humidityPct)}%`);
  const wind = windText(now.windDir, now.windScale, now.windSpeedMps);
  if (wind) lines.push(`- 风：${wind}`);
  if (now.precipitationMm !== undefined) lines.push(`- 降水：${num(now.precipitationMm)} mm`);
  if (now.pressureHpa !== undefined) lines.push(`- 气压：${Math.round(now.pressureHpa)} hPa`);
  if (now.visibilityKm !== undefined) lines.push(`- 能见度：${num(now.visibilityKm)} km`);
  if (now.aqi !== undefined) lines.push(`- 空气质量：AQI ${Math.round(now.aqi)}${now.aqiText ? `（${token(now.aqiText)}）` : ''}`);
  if (lines.length === 1) lines.push('- 该数据源没有返回可用的当前天气要素。');
  lines.push(`数据源：${snapshot.providerName}${publishSuffix(snapshot)}。`);
  return lines.join('\n');
}

export function renderForecast(
  snapshot: WeatherSnapshot,
  mode: DetailMode = 'detailed',
  hours?: readonly HorizonHours[],
): string {
  const city = place(snapshot);
  const picked = hours ? snapshot.horizons.filter((horizon) => hours.includes(horizon.hours)) : snapshot.horizons;
  if (!snapshot.capabilities.forecast || picked.length === 0) {
    const limitation = snapshot.limitations[0] ?? '不提供未来预报。';
    return `未来天气（${city}）：${snapshot.providerName} ${prose(limitation)}`;
  }

  const lines = [`未来天气（${city}）：`];
  for (const horizon of picked) {
    const label = `${horizon.hours} 小时后（${formatShortStamp(horizon.targetMs, snapshot.timezone)}）`;
    const parts: string[] = [];
    if (horizon.condition) parts.push(token(horizon.condition));
    const temp = horizonTemperature(horizon);
    if (temp) parts.push(temp);
    if (horizon.precipitationProbabilityPct !== undefined) {
      parts.push(`降水概率 ${Math.round(horizon.precipitationProbabilityPct)}%`);
    }
    if (mode === 'detailed') {
      if (horizon.precipitationMm !== undefined) parts.push(`降水 ${num(horizon.precipitationMm)} mm`);
      const wind = windText(horizon.windDir, horizon.windScale, horizon.windSpeedMps);
      if (wind) parts.push(`风 ${wind}`);
    }
    const detail = parts.length ? parts.join('，') : '没有可用要素';
    const note =
      mode === 'detailed' && horizon.granularity !== 'day' && horizon.note
        ? `；${prose(horizon.note).replace(/。$/, '')}`
        : '';
    lines.push(`- ${label}：${detail}（${granularityLabel(horizon.granularity)}${note}）`);
  }

  // 简略已经逐行标注了精度，不再补整体说明。
  if (mode === 'detailed') {
    const kinds = new Set(picked.map((horizon) => horizon.granularity));
    if (kinds.has('day') && kinds.size === 1) {
      lines.push('说明：该源只提供逐日预报，以上按目标时刻所属的白天/夜间时段取值。');
    } else if (kinds.has('day')) {
      lines.push('说明：超出逐小时范围的时次使用逐日预报，按目标时刻所属的白天/夜间时段取值。');
    } else if (kinds.has('3h')) {
      lines.push('说明：该源的逐时预报是 3 小时粒度，取最接近目标时刻的时次。');
    }
  }
  lines.push(`数据源：${snapshot.providerName}${publishSuffix(snapshot)}。`);
  return lines.join('\n');
}

export function renderAlerts(snapshot: WeatherSnapshot): string {
  const city = place(snapshot);
  if (!snapshot.capabilities.alerts) {
    const note = snapshot.alertsNote ?? `${snapshot.providerName} 不提供天气预警。`;
    return `天气预警（${city}）：${prose(note)}`;
  }
  if (snapshot.alerts.length === 0) {
    const note = snapshot.alertsNote ? ` 说明：${prose(snapshot.alertsNote)}` : '';
    return `天气预警（${city}）：当前没有生效中的天气预警。${note}数据源：${snapshot.providerName}。`;
  }
  const lines = [`天气预警（${city}，中央气象台体系）：`];
  for (const alert of snapshot.alerts) {
    const level = alert.level === '未知' ? '' : `${alert.level}·`;
    const issued = alert.issuedAtMs !== undefined ? `（${formatLocalDateTime(alert.issuedAtMs, snapshot.timezone)}）` : '';
    // 类型和标题都是数据源写的原文：压平、限长，标题再加书名号标出边界。
    lines.push(`- ${level}${flat(alert.type, 12)}：${quoted(alert.title)}${issued}`);
  }
  lines.push(`共 ${snapshot.alerts.length} 条生效中；预警等级已统一为中央气象台的蓝/黄/橙/红四级。`);
  if (snapshot.alertsNote) lines.push(`说明：${prose(snapshot.alertsNote)}`);
  lines.push(`数据源：${snapshot.providerName}。`);
  return lines.join('\n');
}

function dateLabel(dateKey: string): string {
  return `${dateKey.slice(5, 7)}月${dateKey.slice(8, 10)}日`;
}

function minOf(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((value): value is number => value !== undefined);
  return nums.length ? Math.min(...nums) : undefined;
}

function maxOf(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((value): value is number => value !== undefined);
  return nums.length ? Math.max(...nums) : undefined;
}

function join(label: string, parts: string[]): string | null {
  return parts.length ? `- ${label}：${parts.join('，')}` : null;
}

/** 逐日源的一天：白天/夜间分别写，只有最高/最低温时写区间。 */
function dailyLines(day: DailyPoint, mode: DetailMode): string[] {
  const lines = [
    join('天气', [
      day.dayText ? `白天${token(day.dayText)}` : '',
      day.nightText ? `夜间${token(day.nightText)}` : '',
    ]),
  ];
  if (day.dayTempC !== undefined || day.nightTempC !== undefined) {
    lines.push(
      join('气温', [
        day.dayTempC !== undefined ? `白天 ${temperature(day.dayTempC)}` : '',
        day.nightTempC !== undefined ? `夜间 ${temperature(day.nightTempC)}` : '',
      ]),
    );
  } else {
    const min = minOf([day.minTempC, day.maxTempC]);
    const max = maxOf([day.minTempC, day.maxTempC]);
    if (min !== undefined && max !== undefined) {
      lines.push(`- 气温：${min === max ? temperature(min) : `${num(min)}~${num(max)}°C`}`);
    } else if (min !== undefined) {
      lines.push(`- 气温：${temperature(min)}`);
    }
  }
  if (day.precipitationProbabilityPct !== undefined) {
    lines.push(`- 降水概率：${Math.round(day.precipitationProbabilityPct)}%`);
  }
  if (mode === 'detailed') {
    if (day.precipitationMm !== undefined) lines.push(`- 降水：${num(day.precipitationMm)} mm`);
    lines.push(
      join('风', [
        day.dayWindDir
          ? `白天 ${[day.dayWindDir, day.dayWindScale].filter(isText).map(token).join(' ')}`
          : '',
        day.nightWindDir
          ? `夜间 ${[day.nightWindDir, day.nightWindScale].filter(isText).map(token).join(' ')}`
          : '',
      ]),
    );
    if (day.note) lines.push(`- 说明：${prose(day.note)}`);
  }
  return lines.filter((line): line is string => Boolean(line));
}

/** 没有逐日点时，把明天的逐小时点汇总成最高/最低与降水合计；只写数据源确认过的值。 */
function hourlyLines(snapshot: WeatherSnapshot, dateKey: string, mode: DetailMode): string[] {
  const points = (snapshot.hourly ?? []).filter(
    (point) => formatDateKey(point.atMs, snapshot.timezone) === dateKey,
  );
  if (!points.length) return [];
  const lines: Array<string | null> = [];
  const min = minOf(points.map((point) => point.temperatureC));
  const max = maxOf(points.map((point) => point.temperatureC));
  if (min !== undefined && max !== undefined) {
    lines.push(`- 气温：${min === max ? temperature(min) : `${num(min)}~${num(max)}°C`}`);
  }
  const probability = maxOf(points.map((point) => point.precipitationProbabilityPct));
  if (probability !== undefined) lines.push(`- 降水概率最高 ${Math.round(probability)}%`);
  if (mode === 'detailed') {
    const withPrecip = points.filter((point) => point.precipitationMm !== undefined);
    if (withPrecip.length) {
      lines.push(`- 降水：全天合计 ${num(withPrecip.reduce((sum, point) => sum + (point.precipitationMm ?? 0), 0))} mm`);
    }
  }
  const conditions = points
    .map((point) => point.condition)
    .filter((condition): condition is string => Boolean(condition))
    .map(token)
    .filter((condition, index, all) => all.indexOf(condition) === index);
  lines.push(join('天气', conditions.length ? [conditions.slice(0, 4).join('、')] : []));
  if (mode === 'detailed') {
    lines.push(
      join('风', points.some((point) => point.windScale) ? [`风力 ${points.map((point) => point.windScale).filter((scale): scale is string => Boolean(scale)).map(token).slice(0, 3).join('、')}`] : []),
    );
  }
  lines.push(`- 以上是该源 ${points.length} 个逐小时时次的汇总。`);
  return lines.filter((line): line is string => Boolean(line));
}

/**
 * 每晚推送的正文：明天的天气加当前生效中的预警。
 * 两部分各自跟随自己的开关；正文只写数据源能确认的事实。
 */
export function renderNextDay(
  snapshot: WeatherSnapshot,
  sections: WeatherSections,
  mode: DetailMode = 'detailed',
): string {
  const city = place(snapshot);
  const dateKey = formatDateKey(tomorrowNoonMs(snapshot.fetchedAtMs, snapshot.timezone), snapshot.timezone);
  const blocks: string[] = [];

  if (sections.forecast) {
    const head = `明天天气（${city}，${dateLabel(dateKey)}）：`;
    const day = (snapshot.daily ?? []).find((item) => item.date === dateKey);
    const lines = day ? dailyLines(day, mode) : hourlyLines(snapshot, dateKey, mode);
    if (lines.length) {
      blocks.push([head, ...lines, `数据源：${snapshot.providerName}${publishSuffix(snapshot)}。`].join('\n'));
    } else {
      const limitation = snapshot.limitations[0] ?? '没有明天的预报数据。';
      blocks.push(`${head}${snapshot.providerName} ${prose(limitation)}`);
    }
  }

  if (sections.alerts) {
    blocks.push(`${renderAlerts(snapshot)}\n以上预警是当前生效中的列表，数据源不预报之后才会出现的预警。`);
  }

  if (!blocks.length) {
    return `明天天气（${city}）：「未来天气」和「天气预警」都关着，每晚推送没有可投递的内容。`;
  }
  return blocks.join('\n\n');
}

export function renderWeatherError(message: string): string {
  return `天气数据获取失败：${message}`;
}
