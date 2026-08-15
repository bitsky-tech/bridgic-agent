/**
 * Reads the workflow market data published at showcase.bridgic.ai.
 *
 * Stateless on purpose — caching, throttling and fallback live in
 * `atoms/workflow-market.ts`, so this module only knows how to fetch and
 * validate. Callers are expected to treat every function here as "may throw":
 * the atom keeps whatever list is already on screen instead of surfacing an
 * error, since the market grid is optional decoration on the home page.
 */

import { z } from 'zod'
import { i18n } from './i18n'

/** Primary origin. */
const SHOWCASE_BASE = 'https://showcase.bridgic.ai'

/**
 * Mirrors are split by resource type because JSON and images want opposite
 * things, and no single jsDelivr endpoint provides both.
 *
 * JSON → `cdn.jsdelivr.net`, the only endpoint jsDelivr's purge API clears
 * (purge reports `providers: {CF, FY}`). Measured after a publish: cdn served the
 * new commit immediately while gcore was still handing out a hours-old copy. For
 * data that must be current, being purgeable outweighs everything else, and cdn
 * only rewrites *image* requests.
 *
 * Images → `gcore.jsdelivr.net`, because cdn/fastly answer image requests with a
 * 301 to raw.githubusercontent.com, which measured less reliable than either
 * origin.
 *
 * Note the `/docs/public` segment: jsDelivr serves repository paths, and the
 * showcase site is built, so what is `/api/x.json` online lives at
 * `docs/public/api/x.json` in the repo. Omitting it produces a 404 only on the
 * fallback path — that is, precisely when the primary origin is already down.
 */
const SHOWCASE_REPO = 'bitsky-tech/showcase'
const JSON_MIRROR = `https://cdn.jsdelivr.net/gh/${SHOWCASE_REPO}@main/docs/public`
const ASSET_MIRROR = `https://gcore.jsdelivr.net/gh/${SHOWCASE_REPO}@main/docs/public`

/**
 * Short on purpose: the market grid is optional decoration on the home page, so
 * the primary origin gets one quick attempt before falling back. The observed
 * failure mode for GitHub Pages is a transfer cut mid-stream rather than a
 * refused connection, so without a timeout a request can hang for a long time.
 */
const PRIMARY_TIMEOUT_MS = 3_000
const MIRROR_TIMEOUT_MS = 10_000

/** The entry point clients hardcode; every other path is discovered from it. */
const INDEX_PATH = 'api/index.json'

export type ShowcaseLang = 'zh' | 'en'

// Passthrough everywhere: the payloads are hand-edited and may gain fields
// (tags, author, cover) at any time, and a shipped build must ignore unknown
// fields rather than fail validation.
//
// `status` is a plain string rather than an enum for the same reason — adding a
// third status upstream must not break older builds. Branch on
// `status === 'verified'` at the render site, which is what the card already does.
const workflowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    desc: z.string(),
    domain: z.string(),
    status: z.string(),
    path: z.string(),
  })
  .passthrough()

const workflowsManifestSchema = z
  .object({ lang: z.string(), workflows: z.array(workflowSchema) })
  .passthrough()

const indexManifestSchema = z
  .object({ endpoints: z.record(z.string(), z.record(z.string(), z.string())) })
  .passthrough()

/**
 * Hand-written rather than `z.infer<typeof workflowSchema>`: `.passthrough()` adds
 * an `[x: string]: unknown` index signature to the inferred type, and TypeScript
 * refuses to assign a plain interface (such as the card's own type) to anything
 * carrying one. The runtime behaviour that matters -- unknown fields surviving
 * validation -- comes from the schema and is unaffected by describing the known
 * fields explicitly here.
 */
export interface ShowcaseWorkflow {
  id: string
  name: string
  desc: string
  domain: string
  status: string
  path: string
}

/** Absolute URLs for one published file: primary origin plus mirror fallback. */
export interface ShowcaseUrls {
  url: string
  mirror: string
}

export class ShowcaseHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ShowcaseHttpError'
  }
}

/**
 * Parse `data` with `schema`, throwing a labelled boundary error on mismatch.
 *
 * Duplicated from `amphiClient.ts`, where the same helper is private. Worth
 * lifting into a shared module if a third caller appears; not worth touching the
 * gateway client for the second.
 */
function parseResponse<T>(schema: z.ZodTypeAny, data: unknown, label: string): T {
  const r = schema.safeParse(data)
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')
    throw new Error(i18n.t('error.responseShapeInvalid', { label, detail }))
  }
  return r.data as T
}

const stripLeadingSlash = (path: string): string => path.replace(/^\/+/, '')

/** Resolve a site-relative path to the primary origin plus the asset mirror. */
export function showcaseAssetUrls(path: string): ShowcaseUrls {
  const clean = stripLeadingSlash(path)
  return { url: `${SHOWCASE_BASE}/${clean}`, mirror: `${ASSET_MIRROR}/${clean}` }
}

/**
 * Absolute page URL for a workflow.
 *
 * The path already carries the language prefix (`zh/...` / `en/...`) because the
 * payload was fetched per language, so the page opens in the language in effect
 * without anything extra here.
 *
 * `embed` adds the two parameters the site understands: chrome-less rendering and
 * a forced theme, so the embedded page matches the surrounding app instead of
 * following the OS. Both are prefixed `bridgic-` — VitePress claims no query
 * parameters today, but `theme` is a name it could plausibly take later.
 *
 * Note `SHOWCASE_BASE` is a constant and the path is appended after its leading
 * slashes are stripped, so a hostile `path` from the payload (`//evil.com`) becomes
 * `showcase.bridgic.ai/evil.com` rather than another origin. That property is what
 * lets the caller open this URL without the external-link confirmation.
 */
export function showcasePageUrl(
  path: string,
  embed?: { theme: 'light' | 'dark' },
): string {
  const url = `${SHOWCASE_BASE}/${stripLeadingSlash(path)}`
  if (!embed) return url
  return `${url}?bridgic-embed=1&bridgic-theme=${embed.theme}`
}

/**
 * Primary origin first; on timeout or network error, retry against the mirror.
 *
 * `cache: 'no-cache'` because this is API data: every read revalidates against
 * the origin. Deliberately not `no-store` — the origin sends an ETag, so a
 * revalidation that finds nothing new costs a 304 with an empty body instead of
 * re-transferring the payload. It matters most on the mirror, which advertises
 * `max-age=604800`: one fallback response would otherwise sit in the HTTP cache
 * for a week, which is longer than any staleness this feature should have.
 */
async function fetchWithMirror(primary: string, mirror: string): Promise<Response> {
  const init: RequestInit = { cache: 'no-cache' }
  try {
    return await fetch(primary, { ...init, signal: AbortSignal.timeout(PRIMARY_TIMEOUT_MS) })
  } catch {
    return fetch(mirror, { ...init, signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS) })
  }
}

async function getJson<T>(path: string, schema: z.ZodTypeAny, label: string): Promise<T> {
  const clean = stripLeadingSlash(path)
  const url = `${SHOWCASE_BASE}/${clean}`
  const res = await fetchWithMirror(url, `${JSON_MIRROR}/${clean}`)
  // A missing path is answered with a ~9KB HTML body, not JSON, so status has to
  // be checked before parsing or res.json() throws an opaque SyntaxError.
  if (!res.ok) throw new ShowcaseHttpError(res.status, `GET ${url} failed with ${res.status}`)
  return parseResponse<T>(schema, await res.json(), label)
}

/**
 * Fetch the workflow list for one language.
 *
 * Two requests rather than one: the language-specific path comes out of
 * `api/index.json` instead of being assembled here, so the publisher stays free
 * to rename or relocate the payloads without shipping a new desktop build.
 */
export async function fetchShowcaseWorkflows(lang: ShowcaseLang): Promise<ShowcaseWorkflow[]> {
  const index = await getJson<z.infer<typeof indexManifestSchema>>(
    INDEX_PATH,
    indexManifestSchema,
    'showcase index',
  )
  const path = index.endpoints.workflows?.[lang]
  if (path === undefined) {
    throw new Error(`showcase index advertises no workflows endpoint for '${lang}'`)
  }
  const manifest = await getJson<z.infer<typeof workflowsManifestSchema>>(
    path,
    workflowsManifestSchema,
    `showcase workflows.${lang}`,
  )
  return manifest.workflows
}
