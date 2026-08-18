/**
 * Amphi UI primitives — foundation components used by every other amphi/ file.
 *
 * Styling: **Tailwind className first** (per §1.22). Static styles are className;
 * dynamic prop-derived values (e.g. `size: number`) stay inline. Token bridge
 * in `index.css` (`@theme inline`) means classes like `bg-bg-app`, `text-xs`,
 * `rounded-md` resolve to the exact same px / color as the previous inline
 * `style={{ fontSize: 'var(--text-xs)' }}` form did.
 *
 * Refactored from pure-inline-style in the GUI design handoff port.
 * Public API (exported names, prop shapes, function signatures) unchanged —
 * only the implementation switched. e2e screenshot baselines verified.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { useAtomValue } from 'jotai'
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'
import { cn } from '@/lib/cn'
import { themeAtom } from '@/atoms/theme'
import iconLightUrl from '@/assets/icon-light.svg'
import iconDarkUrl from '@/assets/icon-dark.svg'
import wordmarkLightUrl from '@/assets/logo.svg'
import wordmarkDarkUrl from '@/assets/logo-dark.svg'

/* ─── Button ─── */

const btnStyles = cva(
  'inline-flex items-center justify-center gap-1.5 cursor-pointer font-sans font-medium rounded-md transition-all duration-150',
  {
    variants: {
      variant: {
        default: 'bg-bg-hover text-text-primary border border-border-default',
        primary: 'text-text-on-brand border-0 bg-[image:var(--brand-gradient)]',
        danger: 'bg-status-error-bg text-status-error border-0',
        ghost: 'bg-transparent text-text-secondary border-0',
      },
      size: {
        xs: 'px-2 py-1 text-xs',
        sm: 'px-3 py-1.5 text-sm',
        md: 'px-4 py-2 text-base',
        lg: 'px-5 py-2.5 text-md',
      },
    },
    defaultVariants: { variant: 'default', size: 'sm' },
  },
)

export type BtnVariant = NonNullable<VariantProps<typeof btnStyles>['variant']>
export type BtnSize = NonNullable<VariantProps<typeof btnStyles>['size']>

export interface BtnProps extends HTMLAttributes<HTMLDivElement> {
  variant?: BtnVariant
  size?: BtnSize
}

export function Btn({
  children,
  variant = 'default',
  size = 'sm',
  className,
  onClick,
  onKeyDown,
  role,
  tabIndex,
  ...rest
}: BtnProps) {
  // Btn renders a <div>, so it gets none of a real button's behaviour for free.
  // That was survivable while every Btn had a mouse-reachable alternative; it
  // stopped being survivable when the gateway version-mismatch screen started
  // blocking the entire UI behind two Btns — a keyboard-only user's only escape
  // from that screen would have been killing the process.
  //
  // `pointer-events-none` is this project's convention for a simulated-disabled
  // Btn, and several call sites pair it
  // with an unconditional onClick. It blocks the mouse but NOT focus or key
  // events, so making every Btn focusable would have made those buttons
  // Enter-activatable while looking disabled — e.g. importing 0 skills, or
  // double-submitting an in-flight import. Honour the convention here rather
  // than fixing it call site by call site; a real `disabled` prop is the proper
  // follow-up.
  const looksDisabled = (className ?? '').includes('pointer-events-none')
  const interactive = Boolean(onClick) && !looksDisabled

  // Defaults, not overrides, for role/tabIndex. `onKeyDown` is different: the
  // caller's handler runs FIRST and can suppress ours with preventDefault().
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || !interactive || !onClick) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onClick(event as unknown as ReactMouseEvent<HTMLDivElement>)
  }
  return (
    <div
      className={cn(btnStyles({ variant, size }), className)}
      role={role ?? (interactive ? 'button' : undefined)}
      tabIndex={tabIndex ?? (interactive ? 0 : undefined)}
      aria-disabled={looksDisabled && onClick ? true : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {children}
    </div>
  )
}

/**
 * Style-object form of Btn for sites that need to spread it into a style prop.
 * Kept for backward compatibility; prefer using `<Btn variant size />`.
 */
export const getBtnStyle = (variant: BtnVariant = 'default', size: BtnSize = 'sm'): CSSProperties => {
  const sizeMap: Record<BtnSize, CSSProperties> = {
    xs: { padding: '4px 8px', fontSize: 'var(--text-xs)' },
    sm: { padding: '6px 12px', fontSize: 'var(--text-sm)' },
    md: { padding: '8px 16px', fontSize: 'var(--text-base)' },
    lg: { padding: '10px 20px', fontSize: 'var(--text-md)' },
  }
  const variantMap: Record<BtnVariant, CSSProperties> = {
    default: { background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' },
    primary: { background: 'var(--brand-gradient)', color: 'var(--text-on-brand)' },
    danger: { background: 'var(--status-error-bg)', color: 'var(--status-error)' },
    ghost: { background: 'transparent', color: 'var(--text-secondary)' },
  }
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    borderRadius: 'var(--r-md)',
    transition: 'all .15s',
    ...sizeMap[size],
    ...variantMap[variant],
  }
}

/* ─── Badge ─── */

const badgeStyles = cva(
  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold font-sans',
  {
    variants: {
      color: {
        default: 'bg-bg-hover text-text-secondary',
        success: 'bg-status-success-bg text-status-success',
        error: 'bg-status-error-bg text-status-error',
        warning: 'bg-status-warning-bg text-status-warning',
        info: 'bg-status-info-bg text-status-info',
        brand: 'bg-accent-blue-subtle text-text-accent',
      },
    },
    defaultVariants: { color: 'default' },
  },
)

export type BadgeColor = NonNullable<VariantProps<typeof badgeStyles>['color']>

export function Badge({
  children,
  color = 'default',
  style,
}: {
  children: ReactNode
  color?: BadgeColor
  style?: CSSProperties
}) {
  return (
    <span className={badgeStyles({ color })} style={style}>
      {children}
    </span>
  )
}

/* ─── Tag ─── */

export function Tag({
  children,
  style,
  onClick,
}: {
  children: ReactNode
  style?: CSSProperties
  onClick?: () => void
}) {
  return (
    <span
      onClick={onClick}
      className="inline-flex items-center px-2.5 py-[3px] rounded-full text-xs font-medium bg-bg-hover text-text-secondary border border-border-subtle"
      style={style}
    >
      {children}
    </span>
  )
}

/* ─── Card ─── */

export function Card({
  children,
  style,
  className,
  ...rest
}: { children: ReactNode; style?: CSSProperties } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('bg-bg-elevated border border-border-subtle rounded-lg overflow-hidden', className)}
      style={style}
      {...rest}
    >
      {children}
    </div>
  )
}

/* ─── Status dot ─── */

type DotStatus = 'success' | 'error' | 'warning' | 'pending' | 'idle' | 'running'

const dotColor: Record<DotStatus, string> = {
  success: 'bg-status-success',
  error: 'bg-status-error',
  warning: 'bg-status-warning',
  pending: 'bg-status-pending',
  idle: 'bg-text-tertiary',
  running: 'bg-brand-blue',
}

export function StatusDot({ status = 'idle', size = 8 }: { status?: DotStatus; size?: number }) {
  return (
    <span
      className={cn('rounded-full inline-block flex-shrink-0', dotColor[status])}
      style={{ width: size, height: size }}
    />
  )
}

/* ─── Avatar ─── */

export function Avatar({
  name = 'U',
  size = 32,
  style,
}: {
  name?: string
  size?: number
  style?: CSSProperties
}) {
  return (
    <div
      className="rounded-md flex items-center justify-center text-white font-semibold flex-shrink-0 bg-[image:var(--brand-gradient)]"
      style={{ width: size, height: size, fontSize: size * 0.4, ...style }}
    >
      {name[0]}
    </div>
  )
}

/* ─── Logo ─── */

export interface BridgicLogoProps {
  /** Pixel size. For `square`, controls width=height. For `wordmark`, controls height (width auto-scales by SVG viewBox 510:120 ≈ 4.25:1). */
  size?: number
  /** `square` → app-icon style box (used as message-avatar). `wordmark` → horizontal logo with brand text (currently unused — landing switched to square). */
  variant?: 'square' | 'wordmark'
}

/**
 * Brand logo. Reads the resolved theme and swaps to the dark / light SVG so the
 * mark stays readable on both bg-app=white and bg-app=#0b0b0c.
 *
 * Sources:
 *   - square:   assets/icon-light.svg (white bg)        / icon-dark.svg   (gradient bg, white glyph)
 *   - wordmark: assets/logo.svg       (dark glyph+text) / logo-dark.svg   (light glyph+text)
 */
export function BridgicLogo({ size = 24, variant = 'square' }: BridgicLogoProps) {
  const { resolved } = useAtomValue(themeAtom)
  const isDark = resolved === 'dark'

  if (variant === 'wordmark') {
    // SVG viewBox 510×120 — fix height, let width auto-scale.
    const src = isDark ? wordmarkDarkUrl : wordmarkLightUrl
    return (
      <img
        src={src}
        height={size}
        alt="Bridgic"
        draggable={false}
        className="flex-shrink-0 select-none"
        style={{ height: size, width: 'auto' }}
      />
    )
  }

  const src = isDark ? iconDarkUrl : iconLightUrl
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt="Bridgic"
      draggable={false}
      className="flex-shrink-0 select-none"
    />
  )
}

/* ─── Tab bar ─── */

export function TabBar({
  tabs,
  active = 0,
  onChange,
}: {
  tabs: string[]
  active?: number
  onChange?: (i: number) => void
}) {
  return (
    <div className="flex gap-0 border-b border-border-subtle px-5">
      {tabs.map((t, i) => (
        <div
          key={i}
          data-testid={`tab-${t}`}
          onClick={() => onChange?.(i)}
          className={cn(
            'px-4 py-2.5 text-sm cursor-pointer border-b-2',
            i === active
              ? 'font-semibold text-text-primary border-brand-blue'
              : 'font-normal text-text-secondary border-transparent',
          )}
        >
          {t}
        </div>
      ))}
    </div>
  )
}

/* ─── Toggle ─── */

export function Toggle({
  on = false,
  size = 18,
  onClick,
}: {
  on?: boolean
  size?: number
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'flex items-center cursor-pointer transition-colors duration-200',
        on ? 'bg-brand-blue' : 'bg-border-strong',
      )}
      // Dimensions derived from `size` prop — must stay inline
      style={{ width: size * 1.8, height: size, borderRadius: size, padding: 2 }}
    >
      <div
        className="rounded-full bg-white transition-transform duration-200"
        style={{
          width: size - 4,
          height: size - 4,
          transform: on ? `translateX(${size * 0.8}px)` : 'translateX(0)',
        }}
      />
    </div>
  )
}

/* ─── Selection / radio item ─── */

export function SelectItem({
  label,
  desc,
  selected = false,
  style,
  onClick,
}: {
  label: string
  desc?: string
  selected?: boolean
  style?: CSSProperties
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      // §LS1: 1px transparent border always-on; selected swaps it to brand-blue + bg tint.
      // Canonical reference implementation for the project's "selected" state.
      className={cn(
        'flex items-center gap-3 px-3.5 py-2.5 rounded-md cursor-pointer border border-transparent bg-bg-surface transition-colors',
        selected && 'border-brand-blue bg-accent-blue-subtle',
      )}
      style={style}
    >
      <div
        className={cn(
          'w-4 h-4 rounded-full box-border',
          selected ? 'border-[5px] border-brand-blue' : 'border-2 border-border-strong',
        )}
      />
      <div className="flex-1">
        <div className="text-sm font-medium text-text-primary">{label}</div>
        {desc && <div className="text-xs text-text-secondary mt-0.5">{desc}</div>}
      </div>
    </div>
  )
}

/* ─── Divider ─── */

export function Divider({ style }: { style?: CSSProperties }) {
  return <div className="h-px bg-border-subtle my-2" style={style} />
}

/* ─── Shared input style helper ─── */

/**
 * NOTE: kept as a `CSSProperties` export because several sibling amphi files
 * still spread it via `style={inputStyle}`. Migrating those consumers is part
 * of the same incremental refactor; until then, this matches the className
 * equivalent `inputClasses` below pixel-for-pixel.
 */
export const inputStyle: CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 'var(--r-md)',
  border: '1px solid var(--border-default)',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-base)',
  fontFamily: 'var(--font-sans)',
  outline: 'none',
}

/** Tailwind equivalent of `inputStyle` — prefer this for new code. */
export const inputClasses =
  'w-full px-3 py-2 rounded-md border border-border-default bg-bg-input text-text-primary text-base font-sans outline-none'
