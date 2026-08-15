/**
 * Unified presentation piece for schedule timestamps — every "last / next / created / run time" goes through it, guaranteeing
 * that timestamps in different places share the same font, character width and spacing (previously the config summary used the
 * default sans while the run history used mono, so the same timestamp had different widths in the two places).
 *
 * A monospaced font (font-mono) makes fixed-length time strings align to the same width anywhere; the string format (including
 * seconds and the double space between date and time) has its single source of truth in the domain layer's `formatWhen`, and this
 * component only handles visual consistency.
 * `value` may also be a non-time state such as "paused" or "—" (the degraded strings of nextRun/lastRun), which is rendered as-is.
 *
 * Color and width are not hard-coded: they are injected by the call site through `className` (e.g. the brand blue of "next run" in
 * the config summary, or the fixed column width in the run-history column), so the component does not couple itself to business state.
 */
import { cn } from '@/lib/cn'

export interface SchedTimeProps {
  /** Display string: the time string produced by `formatWhen`, or a status string such as "paused", "running…" or "—". */
  value: string
  /** Extra class names — the call site controls color / column width / font size. */
  className?: string
}

/** Render one schedule timestamp (or its degraded status string) in a monospaced font. */
export function SchedTime({ value, className }: SchedTimeProps) {
  return <span className={cn('font-mono', className)}>{value}</span>
}
