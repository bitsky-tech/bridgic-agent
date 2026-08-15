/**
 * Splits a piece of markdown into an array of "top-level blocks", so streaming rendering can memo block by block (see MarkdownMessage).
 *
 * Why: react-markdown has no incremental API, so rendering the whole text re-parses everything and re-runs shiki/mermaid for every
 * token during streaming → screen flicker. After splitting, together with `React.memo` + index keys, only "the last block being written"
 * re-renders while completed blocks are frozen (see the explanation in MarkdownMessage's file header).
 *
 * Invariants:
 *  - marked's lexer splits on CommonMark/GFM boundaries (code fences / tables / lists each become one block, and blank lines
 *    inside a block do not split it); concatenating `token.raw` losslessly reconstructs the original text.
 *  - marked does not understand `$$` math → a block-level formula containing a blank line would be split into two blocks.
 *    `coalesceMath` balances by counting `$$` and merges an unclosed math block back together across blocks, so formulas do not break apart (see the unit tests).
 *  - Pure-whitespace blocks are discarded (block spacing is handled by CSS; an empty ReactMarkdown is unnecessary).
 */
import { marked } from 'marked'

/** Balance by the number of `$$` occurrences: while inside an unclosed math block, merge following blocks in so that `$$…$$` stays within one block. */
function coalesceMath(blocks: string[]): string[] {
  const out: string[] = []
  let buf = ''
  let openDollars = 0
  for (const b of blocks) {
    buf += b
    openDollars += b.match(/\$\$/g)?.length ?? 0
    // Even = the math fences are balanced (we are not inside an unclosed block) → emit a block.
    if (openDollars % 2 === 0) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) out.push(buf)
  return out
}

/** Split into top-level markdown blocks (math already balanced, whitespace blocks already removed). An empty string returns `[]`. */
export function splitMarkdownBlocks(md: string): string[] {
  if (!md) return []
  const raw = marked.lexer(md, { gfm: true }).map((t) => t.raw)
  return coalesceMath(raw).filter((b) => b.trim() !== '')
}
