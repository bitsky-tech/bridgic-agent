/**
 * Scheduling domain model —— pure types + pure derivations, zero React / zero side effects.
 *
 * This is the single source of types for the scheduling feature: atoms/schedules.ts
 * (state, wired to the real daemon REST), components/schedules/* (views) and
 * lib/scheduleTemplate.ts (prefill templates) all import their types from here.
 * Splitting it into a standalone lib file (instead of stuffing it into the atom file)
 * lets the types / derivations be unit-tested without Jotai, and avoids a lib ↔ atoms
 * circular dependency.
 *
 * At the bottom, `summaryToSchedule` / `detailToSchedule` map the daemon's
 * `ScheduleSummary` / `ScheduleDetail` into this file's `Schedule`
 * shape. The backend does not provide dashboard stats aggregation yet (placeholder),
 * and run summaries carry no duration/token/failed info (to be refined in Phase 6).
 */

import type {
  ScheduleSummary,
  ScheduleDetail as BackendScheduleDetail,
  ScheduleRunSummary,
} from './amphiClient'
import { i18n } from './i18n'

/** Time bucket of the dashboard statistics. */
export const StatRange = {
  Week: '7d',
  Month: '30d',
  All: 'all',
} as const
export type StatRange = (typeof StatRange)[keyof typeof StatRange]

/** KPI snapshot for a single time bucket. */
export interface ScheduleKpi {
  /** Success rate, 0..1. */
  successRate: number
  /** Number of runs. */
  runs: number
  /** Average token consumption per run. */
  avgTok: number
  /** Average duration (seconds) per run. */
  avgSec: number
  /** Cumulative token consumption. */
  totalTok: number
}

/** Dashboard statistics across the three time buckets. */
export type ScheduleStats = Record<StatRange, ScheduleKpi>

/** Risk level of an operation awaiting approval —— decides the approval card's colors and wording strength. */
export const ApprovalRisk = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
} as const
export type ApprovalRisk = (typeof ApprovalRisk)[keyof typeof ApprovalRisk]

/** Pending-approval payload for an "outbound operation" step within one run. */
export interface RunApproval {
  /** Identifier of the tool that triggered the approval (e.g. `feishu.send`). */
  tool: string
  /** Tool category (used for category coloring inside the run drawer). */
  cat: string
  risk: ApprovalRisk
  /** One sentence explaining what this step is doing. */
  title: string
  /** Why user confirmation is needed. */
  why: string
  /** Optional: preview of the operation's content. */
  preview?: string
}

/** Status of a single run. `Finished` = ended, but the backend run summary doesn't distinguish success/failure (neutral, see mapRun). */
export const RunStatus = {
  Success: 'success',
  Failed: 'failed',
  Finished: 'finished',
  NeedsAction: 'needsAction',
  Running: 'running',
} as const
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus]

/** A single run record. */
export interface ScheduleRun {
  status: RunStatus
  /** Whether this completed Session tree may be copied into a new conversation. */
  canContinue: boolean
  /** Run time (display string, e.g. `2026-07-13 09:00`). */
  time: string
  /** Duration (seconds); 0 while needsAction / running. */
  durationSec: number
  /** Token consumption. */
  tokens: number
  /** The corresponding session id (demo string). */
  sessionId: string
  /** Failure reason (when status===failed). */
  error?: string
  /** Pending-approval payload (when status===needsAction). */
  approval?: RunApproval
}

/** Schedule task type: natural language / workflow (currently all mocks are nl). */
export const ScheduleType = {
  NaturalLanguage: 'nl',
  Workflow: 'workflow',
} as const
export type ScheduleType = (typeof ScheduleType)[keyof typeof ScheduleType]

/** A single schedule task. */
export interface Schedule {
  id: string
  name: string
  type: ScheduleType
  /** Task description (natural language). */
  desc: string
  /** Names of the bound Skills. */
  skills: string[]
  /** Names of the bound workflows (optional). */
  nlWorkflows?: string[]
  /** 6-field cron (second minute hour day month weekday). */
  cron: string
  paused: boolean
  running: boolean
  /** Number of pending approvals (when >0 this status outranks running / paused). */
  needsAction?: number
  /** Last run (display string). */
  lastRun: string
  /** Next run (display string: a time / "paused" / "running…"). */
  nextRun: string
  /** Creation time (display string). */
  created: string
  stats: ScheduleStats
  runs: ScheduleRun[]
}

/** Derived status: needsAction is highest (a run is stuck waiting for your confirmation), then running, then paused, otherwise active. */
export const ScheduleStatus = {
  NeedsAction: 'needsAction',
  Running: 'running',
  Paused: 'paused',
  Active: 'active',
} as const
export type ScheduleStatus = (typeof ScheduleStatus)[keyof typeof ScheduleStatus]

/** Derive the display status from a schedule task. */
export function getScheduleStatus(s: Schedule): ScheduleStatus {
  if ((s.needsAction ?? 0) > 0) return ScheduleStatus.NeedsAction
  if (s.running) return ScheduleStatus.Running
  if (s.paused) return ScheduleStatus.Paused
  return ScheduleStatus.Active
}

/** Get this task's currently pending (needsAction) run; undefined when there is none. */
export function getPendingRun(s: Schedule): ScheduleRun | undefined {
  return (s.runs ?? []).find((r) => r.status === RunStatus.NeedsAction)
}

/** Whether a session-completed event (daemon `session.completed`) is worth re-fetching the
 *  schedule snapshot for: only when some schedule is currently awaiting approval
 *  (needsAction>0) or running —— in that case the completion of some session may have
 *  changed its needs_action / status. A pure function, used to gate
 *  useScheduleRefreshOnCompletion, so that every ordinary chat reply doesn't hit
 *  listSchedules (§Tier1 W2: only re-fetch the snapshot, never rewrite needsAction locally). */
export function shouldRefreshSchedulesOnCompletion(schedules: Schedule[]): boolean {
  return schedules.some((s) => (s.needsAction ?? 0) > 0 || s.running)
}

/* ─── Backend mapping (daemon REST → frontend Schedule shape) ─── */

/**
 * Empty dashboard statistics —— the backend doesn't provide aggregation yet (real stats
 * aggregation is pending Phase 6), so the detail dashboard shows a placeholder for now.
 */
const EMPTY_STATS: ScheduleStats = {
  '7d': { successRate: 0, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 },
  '30d': { successRate: 0, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 },
  all: { successRate: 0, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 },
}

/** ISO timestamp → display string `YYYY-MM-DD HH:mm:ss` (second precision, one space between date and time); null → `—`. */
export function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  const [date, clock] = iso.slice(0, 19).split('T')
  // Separate the date and the time with a single non-breaking space (\u00A0): it is exactly one space wide, but keeps the timestamp
  // from wrapping between the date and the time on a narrow line (an ordinary space would become a break point).
  return `${date}\u00A0${clock}`
}

/**
 * Run status mapping (§1.24: use a helper for value mappings): `running` (the backend
 * judges it precisely per session) → running; session `awaiting` → needs action;
 * everything else → the neutral "finished" (SessionStatus has no failure
 * state, so we don't falsely report "success").
 */
function mapRunStatus(r: ScheduleRunSummary): RunStatus {
  if (r.running) return RunStatus.Running
  if (r.status === 'awaiting') return RunStatus.NeedsAction
  return RunStatus.Finished
}

/** Backend run summary → frontend ScheduleRun (the backend carries no duration/token, so they are set to 0). */
function mapRun(r: ScheduleRunSummary): ScheduleRun {
  return {
    status: mapRunStatus(r),
    canContinue: r.can_continue,
    time: formatWhen(r.created_at),
    durationSec: 0,
    tokens: 0,
    sessionId: r.session_id,
  }
}

/** Backend `ScheduleSummary` → frontend `Schedule` (for the list; runs is empty and filled in by the detail view). */
export function summaryToSchedule(s: ScheduleSummary): Schedule {
  return {
    id: s.id,
    name: s.name,
    type: ScheduleType.NaturalLanguage,
    desc: s.desc,
    // Defensive: the backend's refs should be string[], but legacy/abnormal data may be a non-array (see create_schedule's
    // refs coerce); any non-array is degraded to empty, never letting `.map` blow up in the render layer.
    skills: Array.isArray(s.refs) ? s.refs : [],
    cron: s.cron,
    paused: !s.enabled,
    // Read the standalone field instead of inferring it from status: status is a mutually exclusive priority string where
    // needsAction masks running, so a schedule with "a pending approval + a run still in flight" would be misjudged as not running.
    running: s.running,
    needsAction: s.needs_action || undefined,
    lastRun: formatWhen(s.last_run_at),
    nextRun: s.enabled ? formatWhen(s.next_run_at) : i18n.t('schedule.status.paused'),
    created: formatWhen(s.created_at),
    stats: EMPTY_STATS,
    runs: [],
  }
}

/** Backend `ScheduleDetail` → frontend `Schedule` (for the detail view; includes runs). */
export function detailToSchedule(d: BackendScheduleDetail): Schedule {
  return { ...summaryToSchedule(d), runs: d.runs.map(mapRun) }
}
