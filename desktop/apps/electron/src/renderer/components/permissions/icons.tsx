/**
 * Small icons + presentation helpers for the permission-gate UI (risk badge /
 * decided chip / category mapping / risk derivation).
 *
 * The project's `Icons.tsx` has no shield/ban/category icons, so they are
 * inlined here following the `TPIcons`/`TP_CATEGORY` design mock to avoid a
 * cross-file dependency. Risk colors / categories are **purely presentational**
 * (the kernel has no notion of risk); they are derived from capability +
 * boundary + label.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExecutionMode } from '@/atoms/permissions'
import { cn } from '@/lib/cn'

const S = { stroke: 'currentColor', fill: 'none' } as const

/** Inline icon set (each entry is `(size?) => svg`). */
export const PIcon = {
  shield: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <path d="M8 1.5l5 2v4c0 3-2.2 5.2-5 6.5-2.8-1.3-5-3.5-5-6.5v-4l5-2z" {...S} strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  ),
  alert: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <path d="M8 2l6.2 11H1.8L8 2z" {...S} strokeWidth={1.4} strokeLinejoin="round" />
      <path d="M8 6.5v3.2M8 11.6v.01" {...S} strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  ),
  ban: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" {...S} strokeWidth={1.4} />
      <path d="M4 4l8 8" {...S} strokeWidth={1.4} />
    </svg>
  ),
  check: (s = 13) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <path d="M3 8.5L6.5 12L13 4.5" {...S} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  x: (s = 12) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <path d="M4 4l8 8M12 4l-8 8" {...S} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  ),
  chevron: (s = 11) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <path d="M4 6l4 4 4-4" {...S} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  globe: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" {...S} strokeWidth={1.3} />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" {...S} strokeWidth={1.1} />
    </svg>
  ),
  folder: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <path d="M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-7z" {...S} strokeWidth={1.3} strokeLinejoin="round" />
    </svg>
  ),
  terminal: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <rect x="2" y="3" width="12" height="10" rx="1.5" {...S} strokeWidth={1.3} />
      <path d="M5 7l2 2-2 2M8.5 11H11" {...S} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  robot: (s = 14) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <rect x="3" y="5" width="10" height="7" rx="2" {...S} strokeWidth={1.3} />
      <circle cx="6" cy="8.5" r="0.9" fill="currentColor" />
      <circle cx="10" cy="8.5" r="0.9" fill="currentColor" />
      <path d="M8 3v2" {...S} strokeWidth={1.3} strokeLinecap="round" />
    </svg>
  ),
  hand: (s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <path d="M5 7V3.4a1 1 0 012 0V7m0 0V2.6a1 1 0 012 0V7m0 0V3.4a1 1 0 012 0V8.5c0 2.8-1.6 5-4.3 5-1.6 0-2.7-.7-3.5-2L3 8.6a1 1 0 011.6-1.1L5 8" {...S} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  agent: (s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <rect x="2.5" y="4.5" width="11" height="8.5" rx="3" {...S} strokeWidth={1.3} />
      <circle cx="6" cy="8.5" r="1" fill="currentColor" />
      <circle cx="10" cy="8.5" r="1" fill="currentColor" />
      <path d="M8 2.5v2" {...S} strokeWidth={1.3} strokeLinecap="round" />
    </svg>
  ),
  alertCircle: (s = 15) => (
    <svg width={s} height={s} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" {...S} strokeWidth={1.4} />
      <path d="M8 4.8v3.6M8 10.6v.2" {...S} strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  ),
}

export type Risk = 'high' | 'med' | 'low'

/** Backend-provided facts carried by one approval (passed through from Judgement; old daemons / old persisted rows default to false). */
export interface RiskFacts {
  capability: string
  boundary: string
  sensitive?: boolean
  deletion?: boolean
  regenerable?: boolean
  uncertainDestruction?: boolean
  touchesRiskSurface?: boolean
}

/** Kept in sync with the backend `Capability` / `Boundary` enums (security/_types.py).
 *  When the backend adds a new value that is not mirrored here, deriveRisk conservatively returns med — it never silently downgrades to low and gets folded into "allow all".
 *  The contract is pinned by tests/test_permission_contract.py: changing the backend enum turns CI red. */
const KNOWN_CAPABILITIES = new Set([
  'read', 'edit', 'network', 'execute', 'mcp', 'manage', 'manage_write', 'control',
])
// Trusted = deleting it is still recoverable (the workspace has checkpoints, the temp dir is disposable by
// definition, mounts are the user's own turf, the app data dir can be rebuilt). The backend's `in_app_builtin`
// (built-in skills inside the product install dir) is **deliberately excluded**: it is trusted for read /
// execute, but deleting it is unrecoverable product damage, so it must still be judged high and kept out of "allow all".
const TRUSTED_BOUNDARIES = new Set(['in_workspace', 'in_temp', 'in_mount', 'in_app_home'])

/**
 * Presentation-level risk tier — **reads only the backend's objective fact flags, never parses the label**.
 *
 * On the auto path the label is free-form Chinese text generated on the spot by the safety classifier
 * (`[category] one-sentence reason`); substring-matching it is undefined behaviour: in practice
 * "this edit touches no sensitive file, it only changes .gitignore"
 * gets judged high-risk merely because it contains the word "sensitive", which is the exact opposite
 * of the backend's verdict.
 *
 * The only meaning of `high`: **irreversible, and with no checkpoint / version-control safety net**, hence
 * excluded from "allow all".
 * Note: `hard_deny` always resolves to DENY (it never reaches an approval card), so it is not needed here.
 */
export function deriveRisk(f: RiskFacts): Risk {
  // Deletion with an unresolvable target ($VAR / command substitution / unknown cwd) — the one class whose blast radius the backend cannot bound.
  if (f.uncertainDestruction) return 'high'
  // Deleting credentials / sensitive files: all three backend modes always confirm; even full access is not exempt.
  if (f.sensitive && f.deletion) return 'high'
  // Deleting a real file (not a cache / dependency / build artifact) outside a trusted directory — no workspace checkpoint to fall back on.
  if (f.deletion && !f.regenerable && !TRUSTED_BOUNDARIES.has(f.boundary)) return 'high'
  if (f.sensitive) return 'med'
  if (f.touchesRiskSurface) return 'med' // privilege escalation / outbound network carrying data / global install / pushing a remote release
  if (f.boundary === 'out_of_bounds') return 'med'
  if (!KNOWN_CAPABILITIES.has(f.capability)) return 'med' // the backend added a new capability → do not silently loosen
  return 'low'
}

/** Category icon + colors (capability → presentation). */
export function categoryMeta(capability: string): { icon: (s?: number) => ReactNode; tint: string; bg: string } {
  if (capability === 'execute') return { icon: PIcon.terminal, tint: 'text-status-warning', bg: 'bg-status-warning-bg' }
  if (capability === 'network') return { icon: PIcon.globe, tint: 'text-brand-blue', bg: 'bg-accent-blue-subtle' }
  if (capability === 'mcp') return { icon: PIcon.robot, tint: 'text-brand-blue', bg: 'bg-accent-blue-subtle' }
  if (capability === 'read' || capability === 'edit' || capability === 'manage'
    || capability === 'manage_write' || capability === 'control') {
    return { icon: PIcon.folder, tint: 'text-brand-purple', bg: 'bg-accent-purple-subtle' }
  }
  // Unknown capability (added by the backend, not yet mirrored on the frontend): use a neutral warning style, do not draw the most harmless-looking folder.
  return { icon: PIcon.alert, tint: 'text-status-warning', bg: 'bg-status-warning-bg' }
}

// Action-oriented labels, with the word "risk" removed: the dialog usually means "the system is unsure"
// rather than "definitely dangerous". The goal is to explain what this step is and encourage the user to
// read it and approve carefully, not to scare them off. Red is reserved for high — genuinely destroying existing content.
const RISK_BADGE: Record<Risk, { labelKey: string; cls: string }> = {
  high: { labelKey: 'permission.risk.high', cls: 'text-status-error bg-status-error-bg' },
  med: { labelKey: 'permission.risk.med', cls: 'text-status-warning bg-status-warning-bg' },
  low: { labelKey: 'permission.risk.low', cls: 'text-brand-blue bg-accent-blue-subtle' },
}

/** Tier badge (shows "what this step is", no danger narrative). */
export function RiskBadge({ risk }: { risk: Risk }) {
  const { t } = useTranslation()
  const b = RISK_BADGE[risk]
  return <span className={cn('text-[10px] font-semibold px-1.5 py-px rounded shrink-0', b.cls)}>{t(b.labelKey)}</span>
}

/** Decided-record chip (allowed / denied). */
export function DecidedChip({ allow }: { allow: boolean }) {
  const { t } = useTranslation()
  if (allow) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-status-success shrink-0">
        {PIcon.check(12)} {t('permission.decided.allowed')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-status-error shrink-0">
      {PIcon.x(12)} {t('permission.decided.denied')}
    </span>
  )
}

/** Execution-mode icon (shared by the settings card and the composer pill). */
export function modeIcon(id: ExecutionMode): (s?: number) => ReactNode {
  if (id === 'request') return PIcon.hand
  if (id === 'full') return PIcon.alertCircle
  return PIcon.agent
}

/** Execution-mode accent color (selection / icon). */
export function modeTint(id: ExecutionMode): string {
  if (id === 'full') return 'text-status-warning'  // warning (use with care) rather than danger red — full still keeps the system red lines and the credential-deletion block
  if (id === 'request') return 'text-status-info'
  return 'text-brand-blue'
}
