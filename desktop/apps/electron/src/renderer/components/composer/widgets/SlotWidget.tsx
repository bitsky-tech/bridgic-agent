/**
 * `slot` widget family — inline, auto-sizing fillable text fields (Doubao-style [fill-in] slots).
 *
 * The simplest node-view: value IS the text, so `flat === value`. A `<textarea>`
 * (not `<input>`) so long content SOFT-WRAPS onto multiple lines instead of
 * scrolling a fixed single line — while keeping clean form-control focus (no
 * nested-contenteditable risk). `field-sizing: content` auto-sizes width→height
 * to the content (CJK-accurate, no `ch` estimate / mirror). Enter is blocked so a
 * name stays logically single-line (soft-wrap only, no hard newlines); keydown is
 * stopped so Enter/arrows don't reach the composer's send/menu logic.
 *
 * Per-instance placeholder is carried by the widget KIND (via `makeSlotWidget`),
 * not a segment field — cheap, and keeps the segment/serialization lean. Register
 * a new configured slot kind here when a template needs a distinct placeholder.
 */
import { useState, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import { registerWidget, WidgetKind, type WidgetViewProps } from './registry'

/** Build a slot control with a fixed placeholder (shown + sizes to it when empty). */
export function makeSlotWidget(placeholderKey: string): FC<WidgetViewProps> {
  return function Slot({ value, onChange }: WidgetViewProps) {
    const { t } = useTranslation()
    const [text, setText] = useState(value)
    return (
      <textarea
        value={text}
        placeholder={t(placeholderKey)}
        rows={1}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          onChange(next, next) // slot: flat === value
        }}
        onKeyDown={(e) => {
          // A name produces no hard newline (soft wrapping only); also do not bubble Enter/↑↓/Esc to the composer's send/menu logic.
          if (e.key === 'Enter') e.preventDefault()
          e.stopPropagation()
        }}
        className="inline-block align-bottom resize-none overflow-hidden [field-sizing:content] max-w-full bg-accent-blue-subtle text-text-accent rounded-sm px-1.5 py-0.5 text-xs outline-none border-0 placeholder:text-text-accent/50"
      />
    )
  }
}

/** Generic slot. */
export const SlotWidget = makeSlotWidget('composer.slot.genericPlaceholder')
registerWidget({ kind: WidgetKind.Slot, Component: SlotWidget })

/** Schedule task-name slot. */
registerWidget({ kind: WidgetKind.SchedName, Component: makeSlotWidget('composer.slot.scheduleNamePlaceholder') })
