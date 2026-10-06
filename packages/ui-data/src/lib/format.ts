/**
 * Formatting helpers shared by the data components, so a number rendered in a
 * table cell matches the same number in a stat card.
 *
 * Everything is `Intl`-backed and runs unchanged in workerd.
 */

/** Formats minor units (cents) the way payment processors report them. */
export function formatMoney(
  amountInMinorUnits: number,
  currency = "usd",
  locale?: string
) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountInMinorUnits / 100)
}

export function formatNumber(value: number, locale?: string) {
  return new Intl.NumberFormat(locale).format(value)
}

/** 12_400 → "12.4K". Use in tight spaces; keep the exact value in a title. */
export function formatCompact(value: number, locale?: string) {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

export function formatPercent(
  ratio: number,
  { digits = 1, locale }: { digits?: number; locale?: string } = {}
) {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(ratio)
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
  ["second", 1000],
]

/**
 * "3 days ago", "in 2 hours". Pass `now` explicitly when rendering on the
 * server so the output does not drift between the server and the client.
 */
export function formatRelativeTime(
  date: Date | number,
  { now = Date.now(), locale }: { now?: number; locale?: string } = {}
) {
  const timestamp = typeof date === "number" ? date : date.getTime()
  const delta = timestamp - now
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })

  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= ms || unit === "second") {
      return formatter.format(Math.round(delta / ms), unit)
    }
  }

  return formatter.format(0, "second")
}

/** The date, without a time, in the viewer's locale. */
export function formatDate(
  date: Date | number,
  { locale, ...options }: Intl.DateTimeFormatOptions & { locale?: string } = {}
) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    ...options,
  }).format(date)
}

/** Delta direction for `StatDelta`, derived from two comparable values. */
export function deltaDirection(
  current: number,
  previous: number
): "up" | "down" | "flat" {
  if (current > previous) return "up"
  if (current < previous) return "down"
  return "flat"
}
