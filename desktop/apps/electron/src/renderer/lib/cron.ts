/**
 * Cron → human-readable Chinese description (6 fields: second minute hour day month
 * weekday).
 *
 * Pure functions, zero side effects — the schedule list / detail / cards use it to
 * show cron in plain words. Ported from describeCronCN in the design mockup's
 * sched-data.jsx. Responsible for "display" only: the frequency picker (CronPicker)
 * in the mockup has been replaced by real sessions, so buildCron / parseCronToState
 * were not ported.
 */

export type CronTranslator = (key: string, options?: Record<string, unknown>) => string

const CRON_WEEKDAY_KEYS = [
  'cron.weekday.sunday',
  'cron.weekday.monday',
  'cron.weekday.tuesday',
  'cron.weekday.wednesday',
  'cron.weekday.thursday',
  'cron.weekday.friday',
  'cron.weekday.saturday',
] as const

const CRON_MONTH_KEYS = [
  '',
  'cron.month.january',
  'cron.month.february',
  'cron.month.march',
  'cron.month.april',
  'cron.month.may',
  'cron.month.june',
  'cron.month.july',
  'cron.month.august',
  'cron.month.september',
  'cron.month.october',
  'cron.month.november',
  'cron.month.december',
] as const

/** Zero-pad to two digits (used for the hour:minute display). */
export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Describes a 6-field cron in Chinese. Non-6-field (or empty) input is returned
 * as-is / as `—`.
 *
 * Covers: every N seconds/minutes/hours (step syntax) · every minute · every hour ·
 * weekly · daily · quarterly · yearly · monthly.
 *
 * Key invariant: whenever any field contains syntax we can't classify (range `a-b`,
 * list `a,b`, uncommon steps) it always falls back to returning the raw cron and
 * never force-fits a template — the backend's croniter supports the full cron syntax
 * while this function only recognizes a limited set of patterns; better to show the
 * expression than to give a "plausible-looking but actually wrong" description (e.g.
 * misreading "weekdays" as "every Monday", or "every 2 hours" as "daily at 00:00").
 * The old version swallowing step / range with a bare `parseInt` was the root of
 * exactly this bug.
 */
export function describeCron(cron: string, t: CronTranslator): string {
  const parts = String(cron ?? '')
    .trim()
    .split(/\s+/)
  if (parts.length !== 6) return cron || '—'
  const [sec, min, hour, dom, mon, dow] = parts as [string, string, string, string, string, string]

  /** Whether the field is purely numeric (only then is parseInt + template safe). */
  const isNumeric = (f: string): boolean => /^\d+$/.test(f)
  /** Parse step syntax (asterisk-slash-n) → n; returns null for non-step. */
  const parseStep = (f: string): number | null => {
    const m = /^\*\/(\d+)$/.exec(f)
    return m ? parseInt(m[1] ?? '', 10) : null
  }

  // No "day / month / weekday" constraint → a period at second·minute·hour
  // granularity (including step).
  if (dom === '*' && mon === '*' && dow === '*') {
    // Second level: min·hour are both * → only the second varies.
    if (min === '*' && hour === '*') {
      if (sec === '*') return t('cron.everySecond')
      const s = parseStep(sec)
      if (s !== null) return t('cron.everyNSeconds', { n: s })
      if (isNumeric(sec)) return sec === '0' ? t('cron.everyMinute') : t('cron.everyMinuteAtSecond', { second: sec })
      return cron
    }
    // From minute granularity on, the second must be a fixed value (purely
    // numeric), otherwise fall back.
    if (!isNumeric(sec)) return cron
    // Minute level: hour is * → every N minutes / at minute N of every hour.
    if (hour === '*') {
      const m = parseStep(min)
      if (m !== null) return t('cron.everyNMinutes', { n: m })
      if (isNumeric(min)) return min === '0' ? t('cron.everyHour') : t('cron.everyHourAtMinute', { minute: min })
      return cron
    }
    // Hour level: min must be fixed; an hour step → every N hours, a fixed hour →
    // daily at HH:MM.
    if (!isNumeric(min)) return cron
    const h = parseStep(hour)
    // "Every N hours" only holds on the hour (min=0): `0 30 */2 * * *` actually fires
    // at minute 30 of every 2nd hour, and describing it as "every 2 hours" would
    // swallow the :30 offset and make people think it runs on the hour — that
    // violates the no-misreading invariant, so fall back to the raw text.
    if (h !== null) return min === '0' ? t('cron.everyNHours', { n: h }) : cron
    if (isNumeric(hour)) return t('cron.dailyAt', { time: `${pad2(parseInt(hour, 10))}:${pad2(parseInt(min, 10))}` })
    return cron
  }

  // With a "day / month / weekday" constraint → a fixed-time trigger; hour·minute
  // must both be purely numeric, otherwise fall back.
  if (!isNumeric(hour) || !isNumeric(min)) return cron
  const time = `${pad2(parseInt(hour, 10))}:${pad2(parseInt(min, 10))}`

  // Weekly: dom·mon are *, dow is a single plain number (0=Sunday … 6=Saturday).
  if (dom === '*' && mon === '*' && dow !== '*') {
    const dayKey = isNumeric(dow) ? CRON_WEEKDAY_KEYS[parseInt(dow, 10)] : undefined
    if (dayKey) return t('cron.weeklyAt', { day: t(dayKey), time })
    return cron
  }
  // Quarterly: mon is a comma list (e.g. `1,4,7,10`), dom and every month must be
  // purely numeric; dow must be * — otherwise cron's "day OR weekday" OR semantics
  // would be missed (e.g. describing "the 1st or Friday" as just "the 1st").
  if (mon.includes(',')) {
    const months = mon.split(',')
    if (!isNumeric(dom) || dow !== '*' || !months.every(isNumeric)) return cron
    const ms = months
      .map((m) => CRON_MONTH_KEYS[parseInt(m, 10)])
      .filter((key): key is NonNullable<Exclude<(typeof CRON_MONTH_KEYS)[number], ''>> => Boolean(key))
      .map((key) => t(key))
      .join(t('cron.monthSeparator'))
    return t('cron.quarterlyAt', { months: ms, day: dom, time })
  }
  // Yearly: mon·dom are both purely numeric, dow must be * (as above, to avoid
  // missing the weekday constraint).
  if (isNumeric(mon) && isNumeric(dom) && dow === '*') {
    const monthKey = CRON_MONTH_KEYS[parseInt(mon, 10)]
    if (monthKey) return t('cron.yearlyAt', { month: t(monthKey), day: dom, time })
  }
  // Monthly: dom is purely numeric, mon is *, dow must be * (as above, to avoid
  // missing the weekday constraint).
  if (isNumeric(dom) && mon === '*' && dow === '*') return t('cron.monthlyAt', { day: dom, time })

  return cron
}


/* ─── Cron picker: state ↔ 6-field cron ─── */

/** Frequency mode. Ported from CronPickerCN in the design mockup. */
export const CronPeriod = {
  Minute: 'minute',
  Hour: 'hour',
  Day: 'day',
  Week: 'week',
  Month: 'month',
  Quarter: 'quarter',
  Year: 'year',
  Custom: 'custom',
} as const
export type CronPeriod = (typeof CronPeriod)[keyof typeof CronPeriod]

/** Edit state of the frequency picker (all fields are strings, bound directly to
 *  select/number inputs). */
export interface CronState {
  period: CronPeriod
  /** Every minute: on which second. */
  second: string
  minute: string
  hour: string
  /** 0=Sunday … 6=Saturday. */
  dayOfWeek: string
  dayOfMonth: string
  /** 1..12. */
  month: string
  /** Quarter start month, 1..3. */
  quarterStart: string
  /** Raw text of a custom cron. */
  custom: string
}

/** Build a 6-field cron (second minute hour day month weekday) from the edit state. */
export function buildCron(s: CronState): string {
  const { period, second, minute, hour, dayOfWeek, dayOfMonth, month, quarterStart, custom } = s
  switch (period) {
    case CronPeriod.Minute:
      return `${second} * * * * *`
    case CronPeriod.Hour:
      return `0 ${minute} * * * *`
    case CronPeriod.Day:
      return `0 ${minute} ${hour} * * *`
    case CronPeriod.Week:
      return `0 ${minute} ${hour} * * ${dayOfWeek}`
    case CronPeriod.Month:
      return `0 ${minute} ${hour} ${dayOfMonth} * *`
    case CronPeriod.Quarter: {
      const qs = parseInt(quarterStart, 10) || 1
      const months = [qs, qs + 3, qs + 6, qs + 9].join(',')
      return `0 ${minute} ${hour} ${dayOfMonth} ${months} *`
    }
    case CronPeriod.Year:
      return `0 ${minute} ${hour} ${dayOfMonth} ${month} *`
    case CronPeriod.Custom:
    default:
      return custom
  }
}

/** Parse a 6-field cron back into the edit state. Not 6 fields, or unrecognized →
 *  custom mode. */
export function parseCronToState(cron: string): CronState {
  const base: CronState = {
    period: CronPeriod.Day,
    second: '0',
    minute: '0',
    hour: '9',
    dayOfWeek: '1',
    dayOfMonth: '1',
    month: '1',
    quarterStart: '1',
    custom: cron || '0 0 9 * * *',
  }
  const p = String(cron ?? '')
    .trim()
    .split(/\s+/)
  if (p.length !== 6) return { ...base, period: CronPeriod.Custom }
  const [sec, min, hour, dom, mon, dow] = p as [string, string, string, string, string, string]
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { ...base, period: CronPeriod.Minute, second: sec }
  }
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { ...base, period: CronPeriod.Hour, minute: min }
  }
  if (dom === '*' && mon === '*' && dow !== '*') {
    return { ...base, period: CronPeriod.Week, dayOfWeek: dow, hour, minute: min }
  }
  if (mon.includes(',')) {
    return { ...base, period: CronPeriod.Quarter, quarterStart: mon.split(',')[0] ?? '1', dayOfMonth: dom, hour, minute: min }
  }
  if (mon !== '*' && dom !== '*') {
    return { ...base, period: CronPeriod.Year, month: mon, dayOfMonth: dom, hour, minute: min }
  }
  if (dom !== '*' && mon === '*') {
    return { ...base, period: CronPeriod.Month, dayOfMonth: dom, hour, minute: min }
  }
  if (dom === '*' && mon === '*' && dow === '*') {
    return { ...base, period: CronPeriod.Day, hour, minute: min }
  }
  return { ...base, period: CronPeriod.Custom }
}
