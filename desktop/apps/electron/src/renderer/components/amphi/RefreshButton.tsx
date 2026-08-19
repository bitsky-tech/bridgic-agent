/**
 * The "refresh" action in a center page's header, with the spin that makes it
 * legible.
 *
 * The problem it solves: a local daemon usually answers in tens of milliseconds,
 * so clearing the pending flag the moment the promise settles let the icon turn
 * a few degrees and stop. That reads as a twitch, not as a refresh — worse than
 * no feedback, because something moved and said nothing. Racing the work against
 * MIN_SPIN_MS guarantees at least one full revolution; slower requests still
 * spin for as long as they actually take, since Promise.all waits for both.
 *
 * Kept as the refresh arrow rather than a neutral spinner: a turning refresh
 * glyph states which operation is running, where a bare ring only says "busy".
 */
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { Btn } from './Primitives'
import { Icons } from './Icons'

/** One period of Tailwind's `animate-spin`, so the icon always lands where it started. */
const MIN_SPIN_MS = 1000

export function RefreshButton({
  onRefresh,
  label,
  testId,
}: {
  onRefresh: () => Promise<unknown>
  label: string
  testId?: string
}) {
  const [spinning, setSpinning] = useState(false)

  const handleClick = async () => {
    if (spinning) return
    setSpinning(true)
    await Promise.all([
      onRefresh(),
      new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS)),
    ])
    setSpinning(false)
  }

  return (
    <Btn variant="default" size="md" data-testid={testId} onClick={() => void handleClick()}>
      <span className={cn('flex', spinning && 'animate-spin')}>{Icons.refresh(14)}</span>
      {label}
    </Btn>
  )
}
