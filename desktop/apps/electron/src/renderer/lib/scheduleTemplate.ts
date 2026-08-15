/**
 * Builds the Doubao-style template for a schedule session —— turning a
 * create/edit intent into a composer Segment[]: fixed phrasing (text) + a description slot
 * (field: an @-capable fillable area) + a name slot (field: a fillable area) +
 * a frequency picker (sched-freq widget). On send, segmentsToText naturally flattens
 * widget/field into text, assembling a complete instruction sentence (see openScheduleSessionAtom).
 *
 * The description uses a `field` segment (rather than plain text) to get the slot feel of
 * "placeholder when empty, gone as soon as you type", while keeping the main input's ability to
 * @-reference workflows (fields get flattened into the main text stream by parse).
 *
 * Pure functions, depending only on composer/segments types —— bun:test-able.
 */
import { describeCron } from './cron'
import { i18n } from './i18n'
import type { Schedule } from './schedule'
import type { Segment } from '@/components/composer/segments'
// The kind of a seeded widget segment must share its source with the registry side, otherwise WidgetHost's lookup misses and it silently degrades into dead text.
import { WidgetKind } from '@/components/composer/widgets/registry'

/** Default frequency on create: every day at 09:00. */
const DEFAULT_CRON = '0 0 9 * * *'
/** Id of the description field —— the caret lands in it after seeding (focusField). */
const DESC_FIELD_ID = 'sched-desc'
/** Id of the name field. Like the description, it is an editable fill-in area the keyboard caret can travel through naturally (see the segment-construction comments below). */
const NAME_FIELD_ID = 'sched-name'

/** The template's two intents (§4.11): create new or edit existing. Assigned across 5 components; it is the discriminator of the discriminated union. */
export const ScheduleTemplateMode = {
  Create: 'create',
  Edit: 'edit',
} as const
export type ScheduleTemplateMode =
  (typeof ScheduleTemplateMode)[keyof typeof ScheduleTemplateMode]

/** Argument of create / edit a scheduled task —— create may optionally carry the workflow that initiated it; edit must carry the original task. */
export type ScheduleTemplateArg =
  | { mode: typeof ScheduleTemplateMode.Create; workflow?: { id: string; name: string } }
  | { mode: typeof ScheduleTemplateMode.Edit; schedule: Schedule }

/**
 * Builds the template segments + the id of the description field to focus (the caret lands in it after seeding, so you can type straight away when it is empty).
 *
 * @returns `segments` to seed into the composer; `focusFieldId` handed to focusField to place the caret.
 */
export function buildScheduleTemplateSegments(arg: ScheduleTemplateArg): {
  segments: Segment[]
  focusFieldId: string
} {
  const isEdit = arg.mode === ScheduleTemplateMode.Edit
  const name = isEdit ? arg.schedule.name : ''
  const cron = isEdit ? arg.schedule.cron : DEFAULT_CRON
  // Edit must carry the schedule id —— the agent uses it to call update_schedule and modify the
  // **original** task (otherwise only create_schedule runs and creates a duplicate task).
  // The id is written straight into the instruction sentence ("id sched_…").
  const lead = isEdit
    ? i18n.t('schedule.template.updateLead', { id: arg.schedule.id })
    : i18n.t('schedule.template.createLead')

  // Initial value of the description slot: edit carries the original description; create started from a workflow prefills one intent sentence; otherwise empty (showing the placeholder).
  let descValue = ''
  if (arg.mode === ScheduleTemplateMode.Edit) {
    descValue = arg.schedule.desc ?? ''
  } else if (arg.workflow) {
    descValue = i18n.t('schedule.template.runWorkflow', { name: arg.workflow.name })
  }

  const segments: Segment[] = [
    { type: 'text', value: lead },
    { type: 'field', id: DESC_FIELD_ID, placeholder: i18n.t('schedule.template.descPlaceholder'), value: descValue },
    // The name slot matches the description slot: both use a colon-terminated lead-in
    // ("content: " / "named as: ") plus a fillable field.
    { type: 'text', value: i18n.t('schedule.template.nameLead') },
    // The name uses a field (editable fill-in area) rather than a widget: a widget is an atomic
    // contenteditable=false block that arrow keys skip over as a whole — you can neither enter
    // nor leave it, only click it with the mouse; a field inherits the editor's
    // contenteditable, so the caret travels through it like ordinary text and, like the
    // description slot, it supports Tab to jump in (see FreeFormInput).
    { type: 'field', id: NAME_FIELD_ID, placeholder: i18n.t('schedule.template.namePlaceholder'), value: name },
    { type: 'text', value: i18n.t('schedule.template.frequencyLead') },
    {
      type: 'widget',
      kind: WidgetKind.SchedFreq,
      id: 'sched-freq',
      value: cron,
      // `flat` is the form that goes **on the wire** (segmentsToBlocks sends it verbatim),
      // while the widget renders through `t()`. Pinning it to Chinese made an English user
      // see "Daily at 09:00" and the daemon receive the Chinese rendering — visible only until the
      // user touches the picker, whose onChange rewrites `flat` through `t()`.
      flat: describeCron(cron, (key, options) => String(i18n.t(key, options))),
    },
    { type: 'text', value: i18n.t('schedule.template.ending') },
  ]
  return { segments, focusFieldId: DESC_FIELD_ID }
}
