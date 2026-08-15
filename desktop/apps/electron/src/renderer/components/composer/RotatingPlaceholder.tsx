/**
 * Wheel-style rotation of the input box's placeholder text — the old text moves out upwards while the new text fills in from below.
 *
 * Why two nodes must exist at once: if only the new text is rendered (relying on a key change to remount and trigger the entry
 * animation), React unmounts the old text outright, which on screen amounts to "appearing out of nowhere" with none of the
 * continuity of a roll. The essence of the wheel effect is that both lines move together.
 *
 * The leaving node is absolutely positioned and takes no layout space — otherwise the container would stretch to two lines tall at the moment of the switch.
 *
 * State is synchronized **during render** (React's official "adjusting state when props change"), not via useEffect: an effect only
 * runs after a commit, so that frame would first paint the new text without the leaving node, the animation would start from the
 * second frame, and the first frame would flicker. This does not violate §1.17 either — that rule forbids deriving state with an
 * effect, not this kind of in-render self-adjustment.
 *
 * The parent must be `overflow-hidden`, otherwise text moving out of the container shows outside it.
 */
import { useState } from 'react'

export interface RotatingPlaceholderProps {
  /** The text that should currently be shown; any change triggers one roll. */
  text: string
}

/** Placeholder text with wheel-style switching. */
export function RotatingPlaceholder({ text }: RotatingPlaceholderProps) {
  const [shown, setShown] = useState(text)
  const [leaving, setLeaving] = useState<string | null>(null)

  if (text !== shown) {
    // In-render self-adjustment: within the same frame, lay out both the leaving old text and the entering new text.
    setLeaving(shown)
    setShown(text)
  }

  return (
    <>
      {leaving !== null && (
        <span
          key={`leave:${leaving}`}
          aria-hidden
          className="absolute inset-x-0 top-0 block animate-tip-leave"
          // Unmount only after the animation finishes, otherwise the leaving node would stay mounted forever (and there would be two of them on the next switch).
          onAnimationEnd={() => setLeaving(null)}
        >
          {leaving}
        </span>
      )}
      {/* key changes → remount → the entry animation replays. A CSS animation only fires on mount or when the
          animation property changes; merely changing the text content does not re-run it. */}
      <span key={`enter:${shown}`} className="block animate-tip-rise">
        {shown}
      </span>
    </>
  )
}
