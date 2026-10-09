/** Renderer HTML names are also the packaged Electron host entry points. */
export const RENDERER_ENTRY_FILES = {
  main: 'index.html',
  powerpoint: 'powerpoint.html',
  word: 'word.html',
  excel: 'excel.html',
} as const

export const RENDERER_ENTRY_ENV = 'AMPHI_RENDERER_ENTRY'
export type RendererEntry = keyof typeof RENDERER_ENTRY_FILES

export function parseRendererEntry(value: string | undefined): RendererEntry | undefined {
  if (value === undefined) return undefined
  if (!Object.hasOwn(RENDERER_ENTRY_FILES, value)) {
    throw new Error(`Unknown renderer entry: ${value}`)
  }
  return value as RendererEntry
}

export function rendererBuildEnvironment(entry: RendererEntry, environment: Record<string, string | undefined>): Record<string, string | undefined> {
  const options = environment.NODE_OPTIONS ?? ''
  // Excel's Univer/ExcelJS graph still needs a larger heap when built alone.
  // Keep caller-supplied limits; do not change the heap of the app at runtime.
  const hasHeapLimit = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s|$)/.test(options)
  const heapOptions = `--max-old-space-size=${entry === 'excel' ? 4096 : 2048}`
  return {
    ...environment,
    [RENDERER_ENTRY_ENV]: entry,
    NODE_OPTIONS: hasHeapLimit ? options : `${options} ${heapOptions}`.trim(),
  }
}
