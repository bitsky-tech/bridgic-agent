/**
 * Node-view host — the React subtree portaled into a widget's
 * `contenteditable=false` span by RichTextInput.
 *
 * Looks the widget up by `kind` in the registry and renders its control. Unknown
 * kinds (e.g. a stale draft whose widget was never registered this session) fall
 * back to the flattened text so the sentence still reads sensibly.
 */
import { getWidgetDef, type WidgetViewProps } from './registry'

export interface WidgetHostProps {
  kind: string
  /** Current machine value (from the host's data-token-value). */
  value: string
  /** Flattened text (from data-token-flat) — used as the unregistered fallback. */
  flat: string
  /** Bubbles up to RichTextInput's commit (writes host attrs + re-serializes). */
  onChange: WidgetViewProps['onChange']
}

/** Look up `kind` in the registry and render the matching control; when unregistered (e.g. an unfamiliar kind in a historical draft) it degrades to flat text. */
export function WidgetHost({ kind, value, flat, onChange }: WidgetHostProps) {
  const def = getWidgetDef(kind)
  if (!def) {
    return <span className="text-base text-text-secondary">{flat || value}</span>
  }
  const Control = def.Component
  return <Control value={value} onChange={onChange} />
}
