/**
 * Minimal normalization applied to mermaid source before rendering.
 *
 * Currently it does exactly one thing: unify self-closing `<br/>` / `<br />`
 * into the slash-less `<br>`.
 *
 * Why: line breaks in mermaid `timeline` diagrams are handled by svgDraw's
 * `wrap2`, which only recognizes the exact `<br>` (`split(/(\s+|<br>)/)` +
 * `word === '<br>'`, see node_modules/mermaid `svgDraw.js`). Self-closing
 * `<br/>` doesn't match → the event text is drawn verbatim as plain text and
 * never wraps (Chinese has no spaces, so it can't fold either) → a literal
 * `<br/>` shows up in the UI along with overflowing, overlapping text.
 * flowchart/class and friends go through `createText`, whose regex
 * `/<br\s*\/?>/` accepts both spellings, so normalizing to `<br>` is safe for
 * every diagram type.
 *
 * Used by: components/markdown/MermaidBlock.tsx (called before render).
 */

/** Normalize self-closing `<br/>` / `<br />` in mermaid source into `<br>`. */
export function normalizeBreakTags(src: string): string {
  return src.replace(/<br\s*\/>/gi, '<br>')
}
