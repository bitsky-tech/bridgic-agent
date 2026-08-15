/**
 * Skeleton for full-screen overlay backdrops — the **only** implementation of
 * "how the backdrop is drawn" in this project.
 *
 * It exists because of a real incident: backdrop logic used to be written three
 * separate times, in `Modal.tsx`, in `Modals.tsx`'s SettingsModal, and in
 * `RunLogDrawer.tsx`. When fixing occlusion of the Windows caption area only
 * two of them got changed — SettingsModal used `absolute` rather than `fixed`,
 * so even a search missed it, and the user had to hit it in practice to notice
 * the settings dialog was still the old way. From now on a new dialog that does
 * not wrap this component simply has no backdrop, so missing an update is
 * physically impossible.
 *
 * Four invariants (understand why before changing anything):
 *
 *   1. **Portal to body**. An `absolute` backdrop only covers the nearest
 *      positioned ancestor — a dialog opened from inside the composer would
 *      appear to have "no overlay at all".
 *   2. **The inset is applied to the container itself**
 *      (`top-[var(--titlebar-win-inset-top)]`); the background is just an
 *      independent child layer filling that container. On Windows the three
 *      caption buttons are composited by the system **above** the WebContents,
 *      so no z-index can cover them, and there are two ways to leak: a
 *      **background** that reaches the top leaves an isolated un-dimmed
 *      rectangle in the top-right corner; and **content** flush to the top (a
 *      drawer's `h-full`) pushes its own buttons underneath the system's three
 *      buttons where they cannot be clicked. Insetting only the background
 *      layer fixes just the former — which is why RunLogDrawer was missed for
 *      one round (its header at one point absorbed `--titlebar-win-inset`
 *      horizontally on its own, treating the symptom, not the cause). Hoisting
 *      the inset onto the container protects centered cards and edge-anchored
 *      drawers alike. On non-win32 / fullscreen the variable is always 0, which
 *      is equivalent to filling the screen, so consumers never branch on
 *      platform.
 *   3. The background layer is **`-z-10`**, landing below the content. This
 *      container already establishes a stacking context via `z-[100]` +
 *      `fixed`, so the negative value is confined inside it and cannot fall
 *      below body. Safer than adding `relative` to the content — that would
 *      change the positioning origin of absolutely positioned descendants
 *      inside the content.
 *   4. The background layer is **`pointer-events-none`**, otherwise the click
 *      target becomes the background layer itself and the
 *      `e.target === e.currentTarget` "click backdrop to close" test stops
 *      working.
 *   5. Dismissal requires **both** the press and the release to land on the
 *      container itself, which is why this listens on mousedown + mouseup
 *      rather than click. `click` is dispatched on the nearest common ancestor
 *      of the mousedown and mouseup targets, so a drag that starts inside the
 *      panel and ends over the dim area (resizing RunLogDrawer by its left
 *      edge, or simply selecting text and overshooting) lands on this container
 *      with `target === currentTarget` — a plain click handler would read that
 *      as "clicked the empty area" and throw away whatever the user was doing.
 *      The reverse drag (press on the dim area, release inside the panel) is
 *      excluded by the same pair. Both handlers filter on `e.button === 0`, because that
 *      pair — unlike `click` — also fires for the right and middle buttons: without the
 *      filter, right-clicking the dim area (reaching for a paste menu and missing the
 *      input) would dismiss the dialog.
 *
 * Not responsible for: closing on Esc (consumers use `useEscapeToClose`
 * themselves), or content layout and animation.
 */

import { createPortal } from 'react-dom'
import { useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface ModalBackdropProps {
  /** Content above the backdrop (card / drawer panel). */
  children: ReactNode
  /** Fired when the empty area of the backdrop is clicked; omit it to make the backdrop non-dismissible. */
  onClose?: () => void
  /**
   * How the content is arranged inside the backdrop; centered by default. Drawer-style consumers pass `justify-end` to hug the right edge.
   * Layout classes only — do not pass a background; the background is this component's job.
   */
  className?: string
  /** Backdrop base color. Neutral black by default; drawers and similar cases can pass their own value. */
  backdropClassName?: string
  'data-testid'?: string
}

/** Full-screen backdrop + centering container, portaled to body. See the four invariants in the file header. */
export function ModalBackdrop({
  children,
  onClose,
  className,
  backdropClassName = 'bg-[rgba(0,0,0,0.55)]',
  'data-testid': testId,
}: ModalBackdropProps) {
  // Where the current press started; see invariant 5 in the file header.
  const pressedOnBackdrop = useRef(false)
  return createPortal(
    <div
      data-testid={testId}
      className={cn(
        'fixed inset-x-0 bottom-0 top-[var(--titlebar-win-inset-top)] z-[100] flex items-center justify-center',
        className,
      )}
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.button === 0 && e.target === e.currentTarget
      }}
      onMouseUp={(e) => {
        const startedOnBackdrop = pressedOnBackdrop.current
        pressedOnBackdrop.current = false
        if (e.button === 0 && startedOnBackdrop && e.target === e.currentTarget) onClose?.()
      }}
    >
      <div className={cn('absolute inset-0 pointer-events-none -z-10', backdropClassName)} />
      {children}
    </div>,
    document.body,
  )
}
