/**
 * Normalize `$$` math fences into a shape remark-math understands — runs **before** remarkMath parses.
 *
 * ## Why it is needed
 *
 * remark-math's block syntax copies code fences: content **on the same line** after the opening `$$` is treated as **meta**
 * (just like the `js` in ```` ```js ````) and **discarded**, and the closing fence must be **on a line of its own**. So the
 * form models commonly write
 *
 * ```
 * $$\begin{pmatrix}
 * a & b \\
 * c & d
 * \end{pmatrix}$$
 * ```
 *
 * will: ① evaporate `\begin{pmatrix}` as meta; ② fail to treat the trailing `$$` as a closing fence because it is not alone
 * on its line → **this block swallows everything to the end of the document**. The consequences are wildly asymmetric: one
 * non-conforming spot collapses the entire reply into one giant katex error block (even `###` headings become literal text).
 * In one real reply we measured, only 6 of 27 formulas survived.
 *
 * And this form renders fine in GitHub / Typora and other renderers — it is not the model's fault, our pipeline is just stricter.
 *
 * ## Rules (deliberately kept very tight, touching only forms that **are broken today**)
 *
 * - `$$` at the start of a line followed immediately by content, with **no further** `$$` on that line → split into `$$` + newline + content
 * - `$$` at the end of a line preceded by content, with **no further** `$$` on that line → split into content + newline + `$$`
 *
 * The "no further `$$` on that line" condition is the key one: it guarantees that **complete single-line formulas are never touched**
 * (`$$x = 1$$`, `$$a$$ text`, `$$a$$ text $$b$$`). Those currently go through **inline math** and render correctly; splitting them into
 * block level would turn inline styling into display styling — that is a visual regression, not a fix.
 *
 * Content inside fenced code blocks (``` / ~~~) is skipped verbatim, otherwise it would break code samples that are explaining `$$` syntax.
 */

/** How many times `$$` occurs in one line. */
function countDollarFences(line: string): number {
  return (line.match(/\$\$/g) ?? []).length
}

/**
 * Normalize `$$` math fences in markdown so that multi-line formulas are recognized correctly by remark-math.
 *
 * For already-conforming input this is a **no-op** (the original string is returned verbatim). Content inside fenced code blocks is not processed.
 */
export function normalizeMathFences(md: string): string {
  // Fast exit: no `$$` means there is nothing to do (the vast majority of messages take this path).
  if (!md.includes('$$')) return md

  const lines = md.split('\n')
  const out: string[] = []
  // Opening marker of a fenced code block (``` or ~~~); null = not inside a code block.
  let fence: string | null = null

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (fence === null) {
        fence = marker[0]! // remember whether it was ` or ~
      } else if (marker[0] === fence) {
        fence = null
      }
      out.push(line)
      continue
    }
    if (fence !== null) {
      out.push(line) // keep lines inside a code block verbatim
      continue
    }

    // `$$` at line start + content on the same line (and no second `$$` on this line to close it) → the content would be swallowed as meta, so split it.
    const open = /^(\s{0,3})\$\$(\S.*)$/.exec(line)
    if (open && countDollarFences(line) === 1) {
      out.push(`${open[1]}$$`, open[2]!)
      continue
    }

    // `$$` at line end + content before it on the same line (and no second `$$` on this line) → it does not count as a closing fence, so split it.
    const close = /^(.*\S)\$\$(\s*)$/.exec(line)
    if (close && countDollarFences(line) === 1) {
      out.push(close[1]!, '$$')
      continue
    }

    out.push(line)
  }

  return out.join('\n')
}
