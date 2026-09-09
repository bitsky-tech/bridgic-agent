import { createOfficeEditorBinding, type OfficeEditorLease } from './officeEditorBinding'

/** Coalesces native Sheet mutations without introducing a second workbook model. */
export function createExcelEditorBinding<TSnapshot>(options: {
  sessionId: string
  documentId: string
  onChange: (snapshot: TSnapshot) => void
  readSnapshot: () => TSnapshot | null
  flushNative: (lease: OfficeEditorLease) => void | Promise<void>
  disposeNative: () => void
}) {
  const binding = createOfficeEditorBinding<TSnapshot>({
    appKind: 'excel',
    sessionId: options.sessionId,
    documentId: options.documentId,
    onChange: options.onChange,
  })
  let pending = false
  const publishPending = (lease: OfficeEditorLease) => {
    if (!pending || !lease.isCurrent()) return
    pending = false
    const snapshot = options.readSnapshot()
    if (snapshot !== null) binding.publishChange(snapshot, lease)
  }
  binding.attach({
    readSnapshot: options.readSnapshot,
    async flush(lease) {
      await options.flushNative(lease)
      lease.assertCurrent()
      publishPending(lease)
    },
    dispose: options.disposeNative,
  })
  const lease = binding.capture()
  return {
    capture: binding.capture,
    readSnapshot: binding.readSnapshot,
    flush: binding.flush,
    publishChange(snapshot: TSnapshot) {
      if (!lease.isCurrent()) return false
      pending = false
      return binding.publishChange(snapshot, lease)
    },
    scheduleChange() {
      if (!lease.isCurrent() || pending) return
      pending = true
      queueMicrotask(() => publishPending(lease))
    },
    dispose() {
      // React cleanup is synchronous. Publish accepted model changes before invalidating
      // the driver; committing a still-open cell editor belongs to explicit flush().
      try { publishPending(lease) } finally { binding.dispose() }
    },
  }
}
