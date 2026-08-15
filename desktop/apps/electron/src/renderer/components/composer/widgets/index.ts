/**
 * Public barrel for the composer widget (node-view) system.
 *
 * Importing this barrel also runs each widget module's `registerWidget(...)`
 * side-effect (via the re-exports below), so a `kind` is registered before it
 * can be seeded. RichTextInput imports `WidgetHost` from here, which is what
 * keeps the registrations in the bundle.
 */
export * from './registry'
export { WidgetHost } from './WidgetHost'
// Built-in widgets — the re-export runs their module → registerWidget(...).
export { SlotWidget } from './SlotWidget'
export { SchedFreqWidget } from './SchedFreqWidget'
