/** Bound Agent-authored text animation work while always ending on the exact source text. */
export function buildPresentationTextRevealFrames(text: string, maxFrames = 24): string[] {
  const characters = Array.from(text)
  if (characters.length === 0) return ['']
  const step = Math.max(1, Math.ceil(characters.length / Math.max(1, maxFrames)))
  const frames = Array.from({ length: Math.ceil(characters.length / step) }, (_, index) => (
    characters.slice(0, Math.min(characters.length, (index + 1) * step)).join('')
  ))
  if (frames.at(-1) !== text) frames.push(text)
  return frames
}
