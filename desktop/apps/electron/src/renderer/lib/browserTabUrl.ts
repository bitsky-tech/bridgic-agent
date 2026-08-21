/** Whether a tab currently shows nothing, so the renderer owns the canvas. */
export function isBlankTabUrl(url: string | null | undefined): boolean {
  return !url || url === 'about:blank'
}
