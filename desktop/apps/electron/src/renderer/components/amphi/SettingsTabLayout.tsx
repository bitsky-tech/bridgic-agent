/**
 * Root container for one settings tab's content.
 *
 * The dialog around it already fixes the frame (`px-6 py-5` header, then a
 * `px-6 pb-6` scroll area), so a tab only owns the rhythm between its own
 * sections. That was the part that had drifted: gap-4 here, gap-3 there,
 * hand-written mb-3 / mb-4 somewhere else — and About wrapped everything in an
 * extra `p-5`, which stacked on the dialog's own padding and indented that one
 * tab 20px further than its neighbours. Switching tabs moved the content.
 *
 * Only the container is shared. The tabs' insides stay their own: a model form,
 * a gateway status readout and a contact list have nothing structural in common,
 * and forcing them through one shape would be an abstraction that has to be
 * fought rather than used.
 */
import type { ReactNode } from 'react'

export function SettingsTabLayout({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>
}
