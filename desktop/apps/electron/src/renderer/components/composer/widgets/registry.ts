/**
 * Composer widget registry — the extensible core of the node-view system.
 *
 * A "widget" is an interactive inline control (dropdown / fillable slot / cron
 * picker / …) rendered into a `contenteditable=false` host span via React portal
 * (see RichTextInput + WidgetHost). Widgets are seeded by guided templates
 * (e.g. schedule creation/editing); normal chat never produces them.
 *
 * Extensibility contract: adding a NEW custom widget = `registerWidget({ kind,
 * Component })` + write the component. Core composer plumbing (segments.ts /
 * RichTextInput.tsx) never changes — it dispatches purely on `kind` through this
 * table. Register at module load (import side-effect) before the widget's `kind`
 * can be seeded.
 */
import type { ComponentType } from 'react'

/**
 * Registry keys of the built-in widgets (§4.11).
 *
 * Why this must be a single source of truth: the registration side (each widget module's `registerWidget`) and the
 * seeding side (lib/scheduleTemplate.ts building `{ type:'widget', kind }` segments) are joined **only by string equality**.
 * A single mistyped letter produces no error at all — it compiles, nothing throws at runtime, the WidgetHost lookup
 * simply misses and silently degrades to a piece of dead text, and the interactive control vanishes into thin air.
 * This is exactly the kind of silent failure §4.11 exists to prevent.
 *
 * Note: the **value domain of `kind` is closed** (we enumerate all of them ourselves), but the **read entry point is open** —
 * see the comment on getWidgetDef.
 */
export const WidgetKind = {
  /** Generic fillable slot. */
  Slot: 'slot',
  /** Schedule task-name slot. */
  SchedName: 'sched-name',
  /** Schedule frequency (cron) picker. */
  SchedFreq: 'sched-freq',
} as const
export type WidgetKind = (typeof WidgetKind)[keyof typeof WidgetKind]

/** Props every widget control receives from its node-view host. */
export interface WidgetViewProps {
  /** Current machine value (e.g. cron string / slot text). */
  value: string
  /** Report a new value + its human-readable flattened form (`flat` is what the
   *  sent message / char-accounting uses). Call on every user edit. */
  onChange: (value: string, flat: string) => void
}

/** One registered widget kind. */
export interface WidgetDef {
  /** Stable registry key, matches the seeded segment's `kind`. */
  kind: WidgetKind
  /** The interactive control. */
  Component: ComponentType<WidgetViewProps>
}

const REGISTRY = new Map<string, WidgetDef>()

/** Register a widget kind. Idempotent-overwrite (last registration wins). */
export function registerWidget(def: WidgetDef): void {
  REGISTRY.set(def.kind, def)
}

/**
 * Look up a widget kind; undefined when unregistered (host falls back to text).
 *
 * The parameter is **deliberately kept as `string` rather than WidgetKind**: the call chain is the DOM's `data-token-kind` →
 * parseSegmentsFromDOM → Segment.kind → WidgetHost, and its origin is open input (a user's historical draft may hold a kind
 * that was never registered in this session). A lookup miss → WidgetHost degrades to flat text, and that fallback branch
 * exists precisely for this. **Tightening this would destroy that design**, so do not casually change it.
 * (The write side — WidgetDef.kind — is where tightening belongs; see above.)
 */
export function getWidgetDef(kind: string): WidgetDef | undefined {
  return REGISTRY.get(kind)
}
