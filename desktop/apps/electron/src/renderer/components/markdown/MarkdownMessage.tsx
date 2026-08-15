/**
 * Markdown renderer for the body of an LLM reply.
 *
 * Capabilities: GFM (tables/task lists/strikethrough/autolinks), math formulas (remark-math +
 * rehype-katex), syntax highlighting for code blocks (CodeBlock/shiki), mermaid diagrams
 * (MermaidBlock), embedded HTML (rehype-raw + rehype-sanitize allow-list).
 *
 * ## How streaming flicker is avoided (per-block memo + multi-pass rendering)
 *
 * react-markdown has no incremental API, so rendering the whole body would fully re-parse every token
 * during streaming and re-run shiki/mermaid → screen flicker. The body is therefore split by top-level
 * markdown block (splitMarkdownBlocks), each block is a `React.memo`ed `MarkdownBlock`, and they use
 * an **index key** (`block-${i}`):
 *  - a stable index key → React updates props instead of unmounting and rebuilding, so a finished
 *    block's DOM and its children's internal state (shiki HTML / mermaid svg / already-loaded images)
 *    stay in place; when content is unchanged the memo skips the whole block → no re-parsing, no
 *    re-highlighting. **Never use a content hash as the key** (the last block would remount on every
 *    change → more flicker, not less).
 *  - only "the last block currently being written" (streaming and i===last) re-renders per token.
 *  - multi-pass rendering: an active block gets `defer=true` → code/mermaid are treated as plain text
 *    first, and shiki/mermaid only run once the block closes (a next block appears or the stream
 *    ends), upgrading exactly once and eliminating the re-embedding flicker inside the active block.
 *
 * ## Other invariants
 *  - **Embedded HTML must go through the rehype-sanitize allow-list**: LLM output is rendered inside
 *    an Electron renderer, and no sanitising = XSS. SANITIZE_SCHEMA lets benign tags + className
 *    through (so katex math nodes survive) and strips script/style/on* handlers/iframe. Plugin order
 *    is raw → sanitize → katex: katex runs after sanitize so its output (with positioning inline
 *    style) is not stripped, while math **input** nodes survive thanks to className being on the
 *    allow-list.
 *  - code blocks are routed by a custom `code` component: mermaid → MermaidBlock, everything else →
 *    CodeBlock; inline code → a lightweight inline style. `pre` is passed through to avoid a doubled <pre>.
 *  - `a`/`img` hand click handling to custom components (external-link confirmation dialog / image
 *    lightbox), which is why the components map is useMemo'd inside MarkdownBlock (capturing the
 *    stable atom setter + defer, without breaking the memo).
 */
import 'katex/dist/katex.min.css'
import { memo, useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { useSetAtom } from 'jotai'
import { cn } from '@/lib/cn'
import { normalizeMathFences } from './normalizeMathFences'
import { splitMarkdownBlocks } from './markdownBlocks'
import { rlog } from '@/lib/logger'
import { openImageAtom } from '@/atoms/lightbox'
import { requestExternalLinkAtom } from '@/atoms/external-link'
import { CodeBlock } from './CodeBlock'
import { MermaidBlock } from './MermaidBlock'
import { fileUrlToTarget } from './fileUrl'
import { FileLink } from './FileLink'
import { LocalResourcePreview } from './LocalResourceView'
import {
  LOCAL_RESOURCE_PREVIEW_TITLE,
  parseLocalResourceReference,
  rewriteBareLocalPaths,
} from './localResource'

export interface MarkdownMessageProps {
  /** The markdown source to render (may be a half-finished chunk mid-stream). */
  content: string
  className?: string
  /** Card-sized content keeps Markdown readable without message-scale spacing. */
  density?: 'normal' | 'compact' | 'inline'
  /** This body belongs to an in-flight streaming turn: the last block degrades to the "plain text first,
   *  upgrade once closed" multi-pass rendering, preventing code/mermaid inside the active block from
   *  re-running per token and flickering. Defaults to false (finalised messages render fully). */
  streaming?: boolean
}

/** rehype-sanitize allow-list: on top of defaultSchema (GitHub's rules, which already include benign
 *  tags such as table/details/mark/sub/sup and forbid script, on* handlers, style and iframe), it
 *  additionally allows:
 *   - `className` on every element — so the `<span class="math math-inline">` math input nodes
 *     produced by remark-math survive to rehype-katex (className is not itself an XSS vector).
 *   - `data:` / `file:` src on img — allowing inline images and local result images; images are
 *     still only displayed in an `<img>` with clicks taken over by the lightbox, never as executable content. */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  // defaultSchema does not include <mark> (highlight); it is benign, so add it.
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark'],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className'],
  },
  protocols: {
    ...defaultSchema.protocols,
    // file:// local file links inside LLM body text: allow the file protocol on href so the link survives
    // sanitize, then let the custom `a` component below take over the click and route it through openPath
    // (see fileUrlToTarget). file: as an href is not an XSS vector, and the click preventDefaults so it
    // never really navigates, which makes allowing it safe.
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'data', 'file'],
  },
}

/** react-markdown's urlTransform: the default (defaultUrlTransform) blanks out hrefs with
 *  non-allow-listed protocols such as file: — and that cleaning happens before sanitize and before
 *  the custom `a` component. Allow file:// through (local file links, whose clicks the `a` component
 *  below routes to openPath) and keep the default cleaning for every other URL. */
function transformUrl(url: string): string {
  return fileUrlToTarget(url) ? url : defaultUrlTransform(url)
}

/** Rendering of a single markdown block — the smallest unit of the per-block memo (see the
 *  anti-flicker rationale in the file header). `defer` (an active streaming block) is passed down to
 *  code/mermaid: plain text first, highlighted/rendered once closed. */
const MarkdownBlock = memo(function MarkdownBlock({
  content,
  defer,
}: {
  content: string
  defer: boolean
}) {
  const requestExternalLink = useSetAtom(requestExternalLinkAtom)
  const openImage = useSetAtom(openImageAtom)

  // The atom setter is stable + defer → the map object is only rebuilt when defer flips (once in a block's lifetime), which does not break the memo.
  const components = useMemo<Components>(
    () => ({
      a: ({ href, title, children }) => {
        // file:// local file links go to FileLink: the click goes through the openPath channel (confirmation
        // dialog + remembering + failure toast), and on hover it additionally exposes "reveal in file manager
        // / copy path" plus a full-path tooltip. It does not widen openExternal's scheme allow-list.
        const fileTarget = href ? fileUrlToTarget(href) : null
        if (fileTarget) {
          const previewReference = title === LOCAL_RESOURCE_PREVIEW_TITLE
            ? parseLocalResourceReference(href!)
            : null
          if (
            previewReference &&
            (previewReference.kind === 'video' || previewReference.kind === 'audio')
          ) {
            return <LocalResourcePreview reference={previewReference}>{children}</LocalResourcePreview>
          }
          return <FileLink target={fileTarget}>{children}</FileLink>
        }
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!href) return
              // http(s) external links: show a confirmation first (with a "don't ask again this session" option)
              // and only open in the system browser after agreeing. Everything else (mailto / relative anchors,
              // etc.) is handed straight to the system.
              if (/^https?:\/\//i.test(href)) {
                void requestExternalLink(href).then((ok) => {
                  if (ok) {
                    void window.api.shell
                      .openExternal(href)
                      .catch((err: unknown) => rlog.warn('[markdown] openExternal failed', err))
                  }
                })
              } else {
                void window.api.shell
                  .openExternal(href)
                  .catch((err: unknown) => rlog.warn('[markdown] openExternal failed', err))
              }
            }}
          >
            {children}
          </a>
        )
      },
      // Clicking an image → open the yet-another-react-lightbox viewer (zoom/pan/download/fullscreen).
      // The inline size constraint still comes from the `[&_img]` descendant class below.
      img: ({ src, alt }) => {
        const url = typeof src === 'string' ? src : undefined
        const localReference = url ? parseLocalResourceReference(url) : null
        if (localReference) {
          return <LocalResourcePreview reference={localReference}>{alt}</LocalResourcePreview>
        }
        return (
          <img
            src={url}
            alt={alt}
            onClick={(event) => {
              event.stopPropagation()
              if (url) openImage(url)
            }}
            className="cursor-zoom-in"
          />
        )
      },
      // Pass <pre> through so the code component decides block-level rendering entirely (otherwise block code ends up wrapped in two <pre>s).
      pre: ({ children }) => <>{children}</>,
      code: ({ className: codeClass, children }) => {
        const text = String(children ?? '')
        const match = /language-(\w+)/.exec(codeClass ?? '')
        // A language-* marker, or containing a newline → treat as block level; otherwise inline.
        const isBlock = match !== null || text.includes('\n')
        if (!isBlock) {
          return (
            <code className="px-1 py-0.5 rounded bg-bg-hover font-mono text-[0.85em]">
              {children}
            </code>
          )
        }
        const lang = match?.[1] ?? 'text'
        const code = text.replace(/\n$/, '')
        if (lang === 'mermaid') return <MermaidBlock code={code} defer={defer} />
        return <CodeBlock code={code} lang={lang} defer={defer} />
      },
    }),
    [requestExternalLink, openImage, defer],
  )

  return (
    <ReactMarkdown
      urlTransform={transformUrl}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeKatex]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  )
})

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  className,
  density = 'normal',
  streaming = false,
}: MarkdownMessageProps) {
  // Normalise the `$$` fences before feeding remark-math (see normalizeMathFences), then split into
  // top-level blocks. The normalisation must run over the whole body **before** splitting, otherwise the
  // splitter's math balancing (coalesceMath) does not line up.
  const normalized = useMemo(
    () => {
      // While streaming, the unterminated final line is still provisional. Waiting for its newline
      // (or turn completion) avoids repeatedly changing `/` -> `/tmp` -> `image.png` from text to
      // FileLink to image as tokens arrive. Already-closed lines can upgrade immediately.
      let stableContent = content
      let provisionalTail = ''
      if (streaming && !content.endsWith('\n')) {
        const lastNewline = content.lastIndexOf('\n')
        stableContent = lastNewline >= 0 ? content.slice(0, lastNewline + 1) : ''
        provisionalTail = lastNewline >= 0 ? content.slice(lastNewline + 1) : content
      }
      return normalizeMathFences(rewriteBareLocalPaths(stableContent) + provisionalTail)
    },
    [content, streaming],
  )
  const blocks = useMemo(() => splitMarkdownBlocks(normalized), [normalized])
  const lastIndex = blocks.length - 1

  return (
    <div
      className={cn(
        'text-sm leading-relaxed text-text-primary break-words',
        '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
        '[&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2',
        '[&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5',
        '[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1',
        '[&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc',
        '[&_ol]:my-2 [&_ol]:pl-5 [&_ol]:list-decimal',
        '[&_li]:my-0.5',
        '[&_a]:text-brand-blue [&_a]:underline [&_a]:underline-offset-2 [&_a]:cursor-pointer',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border-default [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary [&_blockquote]:my-2',
        '[&_hr]:my-3 [&_hr]:border-border-subtle',
        '[&_strong]:font-semibold',
        '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
        '[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto',
        '[&_th]:border [&_th]:border-border-subtle [&_th]:bg-bg-hover [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium',
        '[&_td]:border [&_td]:border-border-subtle [&_td]:px-2 [&_td]:py-1',
        '[&_a]:break-all [&_pre]:max-w-full [&_pre]:overflow-x-auto',
        // Images are capped at 320px height and scaled proportionally (w-auto) so a large image cannot fill the entire message bubble.
        '[&_img]:max-w-full [&_img]:max-h-80 [&_img]:w-auto [&_img]:rounded',
        density === 'compact' && [
          'text-sm leading-6',
          '[&_p]:my-1 [&_h1]:my-2 [&_h1]:text-base',
          '[&_h2]:my-1.5 [&_h2]:text-sm [&_h3]:my-1 [&_h3]:text-sm',
          '[&_ul]:my-1 [&_ol]:my-1 [&_blockquote]:my-1 [&_table]:my-1',
          '[&_img]:max-h-48',
        ],
        density === 'inline' && [
          'inline text-sm leading-5',
          '[&_p]:m-0 [&_p]:inline',
          '[&_h1]:m-0 [&_h1]:inline [&_h1]:text-sm',
          '[&_h2]:m-0 [&_h2]:inline [&_h2]:text-sm',
          '[&_h3]:m-0 [&_h3]:inline [&_h3]:text-sm',
          '[&_ul]:m-0 [&_ul]:inline [&_ul]:p-0 [&_ul]:list-none',
          '[&_ol]:m-0 [&_ol]:inline [&_ol]:p-0 [&_ol]:list-none',
          '[&_li]:m-0 [&_li]:inline',
          '[&_blockquote]:m-0 [&_blockquote]:inline [&_blockquote]:border-0 [&_blockquote]:p-0',
          '[&_hr]:hidden [&_table]:my-0 [&_img]:inline [&_img]:max-h-8',
        ],
        className,
      )}
    >
      {blocks.map((block, i) => (
        // index key: append-only streaming only changes the last block and never reorders, so the index is stable → finished blocks do not remount (see the file header).
        <MarkdownBlock key={`block-${i}`} content={block} defer={streaming && i === lastIndex} />
      ))}
    </div>
  )
})
