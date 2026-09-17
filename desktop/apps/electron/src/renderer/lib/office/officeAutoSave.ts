/** Debounce edits, drain newer revisions, and keep failures retryable without a retry loop. */
export function createOfficeAutoSave(save: () => Promise<void>, status: (state: 'saving' | 'saved' | 'error', error?: string) => void = () => undefined) {
  let key = ''
  let completed = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | null = null
  let disposed = false
  const flush = (): Promise<void> => {
    clearTimeout(timer)
    if (running) return running
    if (disposed || !key) return Promise.resolve()
    running = Promise.resolve().then(async () => {
      do {
        const revision = key
        status('saving')
        await save()
        completed = revision
      } while (!disposed && key && key !== completed)
      status('saved')
    }).catch((error) => {
      status('error', error instanceof Error ? error.message : String(error))
      throw error
    }).finally(() => { running = null })
    return running
  }
  return {
    schedule(revision: string) {
      if (disposed || revision === key) return
      key = revision
      clearTimeout(timer)
      if (!key) { if (!running) status('saved'); return }
      status('saving')
      timer = setTimeout(() => { void flush().catch(() => undefined) }, 600)
    },
    flush,
    dispose() { disposed = true; clearTimeout(timer) },
  }
}
