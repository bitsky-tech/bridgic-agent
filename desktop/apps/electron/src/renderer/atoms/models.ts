/**
 * Model + provider store — backed by the Bridgic Agent daemon's provider handlers.
 *
 * Wire contract:
 *   - `GET /providers`                         → static vendor + model catalog
 *   - `GET /me`                                → MeProfile (we only read `current_model`)
 *   - `GET /me/providers`                      → user's configured providers (with creds)
 *   - `POST /me/providers`                     → upsert credentials
 *   - `DELETE /me/providers/{id}`              → remove credentials
 *   - `POST /me/active-model`                  → switch active (provider, model) globally
 *   - `POST /me/providers/{id}/toggle`         → flip is_enabled (Phase 2.5)
 *   - `POST /me/providers/test`                → probe credentials without saving (Phase 2.5)
 *
 * Frontend shape mapping (two distinct UI surfaces):
 *
 *   ① the Settings → Model configuration list (driven directly by `configuredProvidersAtom`)
 *      — one row = one ConfiguredProvider, subtitle shows "{auth} · N models enabled".
 *      Row id = the provider id itself ("deepseek"). The delete button deletes the
 *      whole provider credential.
 *
 *   ② The model picker above the chat input (derived from `modelsAtom`, flattened)
 *      — one row = one (provider, model) tuple. So a single DeepSeek credential
 *      expands into two rows in the picker: `deepseek-chat` + `deepseek-reasoner`.
 *      The row id is the synthetic `${providerId}::${modelId}` — the backend does
 *      not store ids of this shape; never persist it, it is a pure UI join key.
 *
 *   The "credentials" behind both surfaces are the same backend data, only
 *   aggregated at a different granularity.
 *
 * Active selection (global, not per-session):
 *   Backend tracks `is_active` on the credential row + `current_model` on
 *   the User row. We mirror both: `activeProviderIdAtom` is derived from
 *   `is_active`; the active model id lives in `_currentModel` (synced from
 *   `/me.current_model`, surfaced via `activeModelAtom`). Chat uses whichever
 *   is active globally — switching never recreates per-session state.
 *
 * Hydration & write flow:
 *   `modelsHydrationStateAtom` is 'idle' → 'loading' → 'ready' | 'error'.
 *   Components that want to show the "configure a model first" must NOT trust 'loading' /
 *   'idle' (use `hasConfiguredModelAtom` which guards them).
 *
 *   Every write atom (`addProviderAtom` / `deleteProviderAtom` /
 *   `setActiveModelAtom`) does POST → `await hydrateModelsAtom` so local
 *   state always reflects the server after a write. Concurrent hydrate
 *   calls share one in-flight Promise via `_hydrationPromise` (so chained
 *   writes really do wait for fresh state, not silently skip — see H3).
 *
 *   Write errors land in `_lastActionError`. UI banner reads it via
 *   `modelsLastActionErrorAtom`, × dismiss via `clearModelsLastActionErrorAtom`.
 */
import { atom, type Getter, type Setter } from 'jotai'
import {
  type ConfiguredProvider,
  type ModelLimits,
  type ProviderCatalogEntry,
  type FetchModelsResult,
  type TestProviderResult,
} from '../lib/amphiClient'
import { buildAmphiClient } from './backend'
import { i18n } from '../lib/i18n'
import { rlog } from '../lib/logger'
import { showToastAtom } from './toast'

/**
 * Pure display meta + form presets + base-URL normalization live in
 * ./models-presets — re-exported here so existing `@/atoms/models` call sites
 * (picker / settings list / add-flow grid) keep working unchanged.
 */
export {
  getProviderDisplay,
  getProviderDisplayById,
  getProviderCatalogDisplayName,
  getConfiguredProviderDisplayName,
  getProviderPreset,
  normalizeBaseUrl,
  CUSTOM_PROTOCOL_PRESETS,
} from './models-presets'
export type { ProviderDisplayMeta, ProviderPreset } from './models-presets'

// ─── Server-mirrored state ──────────────────────────────────────────────────

const _providerCatalog = atom<ProviderCatalogEntry[]>([])
const _configuredProviders = atom<ConfiguredProvider[]>([])
/** /me.current_model — string for the active model id (e.g. "deepseek-chat"). */
const _currentModel = atom<string>('')

export type ModelsHydrationState = 'idle' | 'loading' | 'ready' | 'error'
const _hydrationState = atom<ModelsHydrationState>('idle')
const _hydrationError = atom<string | null>(null)

/**
 * Tracks the in-flight hydration Promise. When non-null, a hydrate is
 * currently running and any second caller MUST await this same Promise
 * (rather than no-op or start a parallel fetch). This is what makes
 * `setActiveModelAtom`'s chained `await set(hydrateModelsAtom)` actually
 * wait for fresh state instead of silently skipping (was the H3 regression).
 *
 * Storing a Promise inside an atom is unusual but correct here: the value
 * is a synchronization marker, not data; Jotai's identity-diff doesn't care
 * because we only read it as truthy/falsy + as something to await.
 */
const _hydrationPromise = atom<Promise<void> | null>(null)

/**
 * Last failed write action's error (add / delete / switch). Distinct from
 * `_hydrationError` (hydration is a passive read). UI banners read this
 * and offer a × to clear via `clearModelsLastActionErrorAtom`.
 */
const _lastActionError = atom<string | null>(null)

export const providerCatalogAtom = atom((get) => get(_providerCatalog))
export const configuredProvidersAtom = atom((get) => get(_configuredProviders))
export const modelsHydrationStateAtom = atom((get) => get(_hydrationState))
export const modelsHydrationErrorAtom = atom((get) => get(_hydrationError))
export const modelsLastActionErrorAtom = atom((get) => get(_lastActionError))
export const clearModelsLastActionErrorAtom = atom(null, (_get, set) => {
  set(_lastActionError, null)
})

// ─── Active selection (global, not per-session) ─────────────────────────────

/** The provider id of the row carrying `is_active: true`. Empty when none. */
export const activeProviderIdAtom = atom((get) => {
  return get(_configuredProviders).find((p) => p.is_active)?.id ?? ''
})

// ─── Display rows: flatten (provider, model) pairs for the UI ───────────────

/** One row in "Configured models" — a tuple of (configured provider, model id). */
export interface ModelRow {
  /** Synthetic UI-only id: `${providerId}::${modelId}`. */
  id: string
  providerId: string
  /** Backend model id (e.g. "deepseek-chat"). Passed verbatim to /me/active-model. */
  modelId: string
  /** Catalog display_name for the provider — for rendering only. */
  providerDisplayName: string
  /** True when this exact (provider, model) is the globally active selection. */
  isActive: boolean
}

/** Flattened display rows — chat picker's single data source.
 *
 *  Three things in Phase 2.5:
 *   1. **Skip disabled providers** — no model on a provider with
 *      `is_enabled === false` enters the picker (visible on the settings page but
 *      not selectable in chat).
 *   2. **Custom channels take part too** — display name priority:
 *      `cp.display_name` (user-chosen) > `catalog.display_name` (built-in) > `cp.id`.
 *      The picker used to take display_name from the catalog only, so a custom
 *      channel (not in the catalog) fell through the catalog miss → used `p.id`.
 *      The fix is to spell the fallback chain out explicitly.
 *   3. Order = the order of `_configuredProviders` (backend created_at ascending),
 *      matching the settings page list. */
export const modelsAtom = atom<ModelRow[]>((get) => {
  const cfg = get(_configuredProviders)
  const catalog = get(_providerCatalog)
  const activeProvider = get(activeProviderIdAtom)
  const activeModel = get(_currentModel)
  const rows: ModelRow[] = []
  for (const p of cfg) {
    if (!p.is_enabled) continue
    const catEntry = catalog.find((c) => c.id === p.id)
    const displayName = p.display_name ?? catEntry?.display_name ?? p.id
    for (const modelId of p.available_models) {
      rows.push({
        id: `${p.id}::${modelId}`,
        providerId: p.id,
        modelId,
        providerDisplayName: displayName,
        isActive: p.id === activeProvider && modelId === activeModel,
      })
    }
  }
  return rows
})

/** Convenience: the currently-active row, or null. */
export const activeModelAtom = atom<ModelRow | null>((get) => {
  return get(modelsAtom).find((r) => r.isActive) ?? null
})

/**
 * True when the user has both an active provider AND a current model.
 *
 * Hydration-state semantics:
 *   - `loading` / `idle` → returns `true` so the chat input doesn't flash
 *     the the "configure a model first" placeholder between mount and first /me fetch.
 *   - `ready`  → returns based on whether an active row exists.
 *   - `error`  → returns based on activeModelAtom too (NOT optimistic
 *     true). If hydrate failed we honestly don't know the state; better
 *     to surface the no-model placeholder so the user can spot something
 *     is wrong rather than show a normal input that fails on send.
 *     ChatInputZone reads `modelsHydrationStateAtom === 'error'` itself
 *     and overrides with a "failed to load models" banner.
 */
export const hasConfiguredModelAtom = atom((get) => {
  const state = get(_hydrationState)
  if (state === 'loading' || state === 'idle') return true
  const active = get(activeModelAtom)
  return active !== null
})


// ─── Write actions (all async; status mirrored to _hydrationState) ──────────

/**
 * Pull catalog + configured providers + current model in parallel, mirror
 * into atoms. Idempotent: re-running just refreshes. Call this:
 *   - Once on App mount (App.tsx bootstrap effect)
 *   - After any successful POST/DELETE to keep local in sync with server
 *
 * In-flight semantics: if a hydrate is already running, the second caller
 * awaits the SAME Promise rather than starting a parallel fetch or no-op'ing.
 * This keeps `await set(hydrateModelsAtom)` in chained write actions
 * (setActive / add / delete) honest: the caller really does wait for fresh
 * state before reading derived atoms (was the H3 regression bug).
 */
export const hydrateModelsAtom = atom(null, (get, set): Promise<void> => {
  const existing = get(_hydrationPromise)
  if (existing) return existing
  const promise = hydrateModelsImpl(get, set).finally(() => set(_hydrationPromise, null))
  set(_hydrationPromise, promise)
  return promise
})

/** Internal hydrate body — extracted so the outer atom can wrap it in
 *  shared-Promise bookkeeping without nesting an async function inside
 *  a `.finally`. Throws are converted to error-state writes; this
 *  function never rejects (the outer Promise always resolves).
 *
 *  After a successful fetch it ALSO self-heals a stranded selection (see the
 *  inline comment): if there are selectable models but none is active, it
 *  pins the active (provider, model) to the first available row so the chat
 *  input can never get stuck on the "configure a model first" with no GUI way out. */
async function hydrateModelsImpl(get: Getter, set: Setter): Promise<void> {
  const client = buildAmphiClient(get)
  if (!client) {
    set(_hydrationState, 'error')
    set(_hydrationError, i18n.t('error.backendNotReadyModels'))
    return
  }
  set(_hydrationState, 'loading')
  // Don't clear _hydrationError here — during a retry ChatInputZone still reads
  // this message to keep the error placeholder card visible and the button
  // disabled showing "retrying…" (L3). Only clear it once fresh state has really
  // arrived (the ready branch).
  try {
    const [catalog, configured, me] = await Promise.all([
      client.listProviderCatalog(),
      client.listMeProviders(),
      client.getMe(),
    ])
    set(_providerCatalog, catalog)
    set(_configuredProviders, configured)
    set(_currentModel, me.current_model ?? '')
    set(_hydrationError, null)
    set(_hydrationState, 'ready')

    // Self-heal a stranded selection: there ARE selectable models but none is
    // active — `current_model` fell out of the active provider's whitelist
    // (e.g. its model list was edited), or no provider is active at all. Either
    // way the chat input sticks on the "configure a model first" with NO GUI path to recover
    // (the picker only renders once a model is active). Pin the selection to
    // the first available row.
    //
    // Write via the client + mirror state locally, NOT via setActiveModelAtom:
    // that awaits hydrateModelsAtom, which re-enters this function while it
    // still holds `_hydrationPromise` → deadlock.
    const rows = get(modelsAtom)
    if (rows.length > 0 && get(activeModelAtom) === null) {
      const first = rows[0]!
      try {
        await client.setActiveModel({
          provider_id: first.providerId,
          model: first.modelId,
        })
        set(_currentModel, first.modelId)
        set(
          _configuredProviders,
          configured.map((p) => ({ ...p, is_active: p.id === first.providerId })),
        )
      } catch (err) {
        rlog.warn('[models] self-heal active selection failed', err)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    rlog.error('[models] hydrate failed', err)
    set(_hydrationState, 'error')
    set(_hydrationError, msg)
  }
}

/**
 * Add (or update) a provider's credentials.
 *
 * Two server-side behaviors worth knowing about:
 *   - First configured provider with `api_key` is auto-promoted to active
 *     and its `api_key` / `base_url` mirrored onto the User row.
 *   - `current_model` is NOT auto-set by `POST /me/providers`. If the
 *     user previously chatted with another provider, `User.current_model`
 *     keeps its old value — which the daemon's `build_llm` will happily
 *     hand to the new provider's endpoint, producing 404/422 from the
 *     wrong-model name (typical case: legacy `/me/credentials` left
 *     `current_model="qwen-plus"`, then user adds DeepSeek; chat sends
 *     `qwen-plus` to api.deepseek.com → fails).
 *
 * To keep "first time configuring this provider" UX clean, after the
 * upsert we check whether `current_model` belongs to the active
 * provider's available models. If not, we switch to its first model.
 * This matches the user's mental model: "I just configured DeepSeek,
 * so chat should now use DeepSeek."
 */
/** Input to {@link addProviderAtom}. Phase-2: the form posts 5 fields
 *  (provider_id is the slug; the unified ChannelCredentialForm collects
 *  protocol / base_url / api_key / display_name / models). `apiKey` is
 *  optional on edit to allow "rotate base_url without re-sending the key"
 *  — the backend `upsert` preserves the existing key when api_key is
 *  undefined. */
export interface AddProviderInput {
  providerId: string
  apiKey?: string
  baseUrl?: string
  protocol?: 'openai' | 'anthropic'
  displayName?: string | null
  models?: string[]
  modelLimits?: Record<string, ModelLimits>
}

export const addProviderAtom = atom(
  null,
  async (get, set, input: AddProviderInput): Promise<void> => {
    const client = buildAmphiClient(get)
    if (!client) {
      const msg = i18n.t('error.backendNotReady')
      set(_lastActionError, msg)
      throw new Error(msg)
    }

    // ── Phase 1: the real write + state refresh. A failure = the credential
    // wasn't stored = a genuine add failure.
    try {
      await client.addProvider({
        provider_id: input.providerId,
        auth_mode: 'api_key',
        api_key: input.apiKey,
        base_url: input.baseUrl,
        protocol: input.protocol,
        display_name: input.displayName,
        models: input.models,
        model_limits: input.modelLimits,
      })
      await set(hydrateModelsAtom)
      set(_lastActionError, null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rlog.error('[models] add provider failed', err)
      set(_lastActionError, i18n.t('error.providerAddFailed', { msg }))
      throw err
    }

    // ── Phase 2: fix up current_model (best-effort).
    //
    // If the legacy `current_model` is stale for the newly activated provider,
    // switch to that provider's first model. This is fallback logic and
    // **doesn't affect the "did the add succeed" semantics** — the credential is
    // already stored; if this fails, the user recovers by restarting or by
    // switching manually next time.
    //
    // Source of truth (Phase 2): configuredProvider.available_models is the
    // whitelist the user submitted (no longer relying on the catalog — the
    // catalog degraded into a prefill template, and custom channels aren't in
    // the catalog at all). Read it from the configured list after hydrate.
    //
    // Note: when setActiveModelAtom fails internally it writes
    // _lastActionError = "failed to switch model: …" itself, so after this try/catch we
    // **force one more clear**, to keep the user from seeing a misleading
    // "switch failed" banner (the add actually succeeded).
    try {
      const activeProviderId = get(activeProviderIdAtom)
      const currentModel = get(_currentModel)
      if (activeProviderId !== input.providerId) return
      const configured = get(_configuredProviders)
      const row = configured.find((p) => p.id === input.providerId)
      if (!row || row.available_models.length === 0) return
      const isCurrentValid = row.available_models.includes(currentModel)
      if (isCurrentValid) return
      const firstModel = row.available_models[0]!
      await set(setActiveModelAtom, {
        providerId: input.providerId,
        modelId: firstModel,
      })
    } catch (err) {
      rlog.warn('[models] post-add reconcile failed (cred saved OK)', err)
      set(_lastActionError, null)
    }
  },
)

/** Input to {@link setCodexModelsAtom}. */
export interface SetCodexModelsInput {
  models: string[]
  modelLimits: Record<string, ModelLimits>
}

/**
 * Update the Codex (ChatGPT subscription) channel's user-managed model list.
 *
 * Codex models are no longer auto-probed at activation — the user edits the
 * list like any API-key channel. This re-upserts the `openai` channel while
 * PRESERVING its OAuth shape (`auth_mode='oauth'`, `protocol='openai-codex'`,
 * no api_key), so the stored ~/.codex token + the channel's active state are
 * untouched; only `enabled_models` changes. Re-hydrates so the picker reflects
 * the list, then reconciles `current_model` if the user removed the active one.
 */
export const setCodexModelsAtom = atom(
  null,
  async (get, set, input: SetCodexModelsInput): Promise<void> => {
    const client = buildAmphiClient(get)
    if (!client) {
      const msg = i18n.t('error.backendNotReady')
      set(_lastActionError, msg)
      throw new Error(msg)
    }
    try {
      await client.addProvider({
        provider_id: 'openai',
        auth_mode: 'oauth',
        protocol: 'openai-codex',
        // api_key omitted → backend upsert preserves the (absent) Codex key.
        display_name: 'OpenAI',
        models: input.models,
        model_limits: input.modelLimits,
      })
      await set(hydrateModelsAtom)
      set(_lastActionError, null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rlog.error('[models] set codex models failed', err)
      set(_lastActionError, i18n.t('error.codexModelSaveFailed', { msg }))
      throw err
    }

    // Reconcile current_model: if the user removed the active model, switch to
    // the first remaining one so the picker isn't left on a now-absent id.
    // Best-effort — the save above already succeeded.
    try {
      if (get(activeProviderIdAtom) !== 'openai' || input.models.length === 0) return
      if (input.models.includes(get(_currentModel))) return
      await set(setActiveModelAtom, { providerId: 'openai', modelId: input.models[0]! })
    } catch (err) {
      rlog.warn('[models] codex current_model reconcile failed (models saved OK)', err)
    }
  },
)

/** Delete a provider's credentials. Refreshes after success. */
export const deleteProviderAtom = atom(null, async (get, set, providerId: string) => {
  const client = buildAmphiClient(get)
  if (!client) {
    const msg = i18n.t('error.backendNotReady')
    set(_lastActionError, msg)
    throw new Error(msg)
  }
  try {
    await client.deleteProvider(providerId)
    await set(hydrateModelsAtom)
    set(_lastActionError, null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    rlog.error('[models] delete provider failed', err)
    set(_lastActionError, i18n.t('error.providerDeleteFailed', { msg }))
    throw err
  }
})

/**
 * Terminal outcome of the Codex OAuth flow. `error` carries the failure
 * reason so the auth form (`CodexOAuthBody`) can render it INLINE next to the
 * authorize button — deliberately NOT via the global `_lastActionError`
 * banner, which lives on the provider LIST page. The user is on the edit page
 * when authorizing, so the failure must surface there, not one level out.
 */
export interface CodexOAuthResult {
  status: 'success' | 'failed' | 'timeout' | 'cancelled'
  error: string | null
}

/** Sleep `ms`, resolving early if `signal` aborts — so a cancel is acted on
 *  immediately instead of only after the current 2s tick elapses. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Drive the Codex (ChatGPT subscription) OAuth flow end-to-end.
 *
 * start → open the authorize URL in the system browser → poll the daemon
 * until terminal. On success the daemon has already activated the Codex
 * channel, so we refresh the provider list. Polls every 2s up to ~60s.
 *
 * **Cancellable**: the caller passes an `AbortSignal`; aborting it (user clicks
 * "Cancel authorization", or navigates away so `CodexOAuthBody` unmounts) breaks the poll
 * loop and tells the daemon to close the 1455 server. That cancel call lives
 * HERE (in the action), not in the component — so it still fires after the
 * calling component has unmounted.
 *
 * Returns the terminal outcome for inline display by the caller. Never writes
 * `_lastActionError` and never rejects.
 */
export const startCodexOAuthAtom = atom(
  null,
  async (get, set, signal: AbortSignal): Promise<CodexOAuthResult> => {
    const client = buildAmphiClient(get)
    if (!client) {
      return { status: 'failed', error: i18n.t('error.backendNotReady') }
    }
    try {
      const { auth_url, state } = await client.startCodexOAuth()
      // Electron blocks renderer-initiated external navigation; route through
      // the main process's shell.openExternal (already wired IPC).
      await window.api.shell.openExternal(auth_url)

      // Aborted sign-in → tell the daemon to close the 1455 server (best-effort)
      // and report 'cancelled'. Captures the live `state` from this flow.
      const cancelled = (): CodexOAuthResult => {
        void client.cancelCodexOAuth(state).catch(() => {})
        return { status: 'cancelled', error: null }
      }

      // 30 × 2s = 60s, interruptible at each tick boundary.
      for (let i = 0; i < 30; i++) {
        if (signal.aborted) return cancelled()
        await abortableSleep(2000, signal)
        if (signal.aborted) return cancelled()
        const { status, error } = await client.pollCodexOAuthStatus(state)
        if (status === 'success') {
          await set(hydrateModelsAtom)
          return { status: 'success', error: null }
        }
        if (status === 'failed') {
          return { status: 'failed', error: error ? i18n.t('error.codexAuthFailed', { msg: error }) : null }
        }
      }
      return { status: 'timeout', error: i18n.t('error.codexAuthTimeout') }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rlog.error('[models] codex oauth failed', err)
      return { status: 'failed', error: i18n.t('error.codexAuthFailed', { msg }) }
    }
  },
)

/**
 * Detect whether the machine already has a local Codex login (read-only).
 *
 * The local-first probe: lets the GUI offer one-click reuse before falling back to
 * OAuth. Returns `{has_local:false}` (never throws) when the backend isn't ready.
 */
export const checkCodexLocalAtom = atom(
  null,
  async (get): Promise<{ has_local: boolean; account_id: string | null }> => {
    const client = buildAmphiClient(get)
    if (!client) return { has_local: false, account_id: null }
    try {
      return await client.checkCodexLocal()
    } catch (err) {
      rlog.warn('[models] check codex local failed', err)
      return { has_local: false, account_id: null }
    }
  },
)

/**
 * Reuse the local Codex login — activate the channel directly, no OAuth.
 *
 * On success refreshes the provider list (the channel is now active). Returns
 * the backend `{ok, error?}` so the caller renders failures inline (in the
 * auth form) and can fall back to OAuth. Like the OAuth flow, it never writes
 * `_lastActionError` — auth errors stay on the edit page, not the list banner.
 */
export const useLocalCodexAtom = atom(
  null,
  async (get, set): Promise<{ ok: boolean; error?: string }> => {
    const client = buildAmphiClient(get)
    if (!client) {
      return { ok: false, error: i18n.t('error.backendNotReady') }
    }
    try {
      const res = await client.useLocalCodex()
      if (res.ok) await set(hydrateModelsAtom)
      return res
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rlog.error('[models] reuse local codex failed', err)
      return { ok: false, error: msg }
    }
  },
)

/**
 * Switch the globally-active (provider, model).
 *
 * Implementation note: re-uses `hydrateModelsAtom` instead of hand-rolling
 * a partial sync. Cost = 1 POST + 3 GET (catalog + /me/providers + /me)
 * per switch instead of the minimal 1 POST + 1 GET. On a local daemon all
 * 3 GETs together usually finish in <100ms so it's invisible; the win is
 * "after any write, full re-fetch" as the single sync pattern → no two
 * parallel state-update paths to keep in sync.
 */
export const setActiveModelAtom = atom(
  null,
  async (get, set, input: { providerId: string; modelId: string }) => {
    const previous = get(activeModelAtom)
    const client = buildAmphiClient(get)
    if (!client) {
      const msg = i18n.t('error.backendNotReady')
      set(_lastActionError, msg)
      throw new Error(msg)
    }
    try {
      await client.setActiveModel({
        provider_id: input.providerId,
        model: input.modelId,
      })
      await set(hydrateModelsAtom)
      set(_lastActionError, null)
      if (previous && (previous.providerId !== input.providerId || previous.modelId !== input.modelId)) {
        set(showToastAtom, i18n.t('toast.modelContextRecalculation', { model: input.modelId }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rlog.error('[models] set active model failed', err)
      set(_lastActionError, i18n.t('error.modelSwitchFailed', { msg }))
      throw err
    }
  },
)

/**
 * Convenience: pick by row id (`${providerId}::${modelId}`). Used by the
 * RadioGroup-driven model picker which only knows the row id.
 */
export const setActiveModelByRowIdAtom = atom(null, async (get, set, rowId: string) => {
  const rows = get(modelsAtom)
  const row = rows.find((r) => r.id === rowId)
  if (!row) return
  await set(setActiveModelAtom, { providerId: row.providerId, modelId: row.modelId })
})

// ─── Phase 2.5: provider enable toggle ──────────────────────────────────────

/**
 * Flip `is_enabled` on one configured provider.
 *
 * Backend side-effects (mirrored here via hydrate):
 *   - Disabling the **active** provider auto-promotes the next enabled
 *     row with a key (or clears mirrored User creds if none qualify).
 *     The picker / `activeProviderIdAtom` reflect this via the post-call
 *     hydrate, so the UI doesn't need a separate "active changed" event.
 *   - Enabling a previously disabled row does NOT auto-activate it; the
 *     user must `POST /me/active-model` explicitly (mirrors the design's
 *     "disabling switches you off but enabling waits for your call").
 *
 * Error UX: failure writes to `_lastActionError` so the ModelList banner
 * shows it next render; the call throws so the Toggle UI can revert its
 * optimistic state if it chose to optimistically flip.
 */
export const toggleProviderAtom = atom(
  null,
  async (get, set, input: { providerId: string; enabled: boolean }) => {
    const client = buildAmphiClient(get)
    if (!client) {
      const msg = i18n.t('error.backendNotReady')
      set(_lastActionError, msg)
      throw new Error(msg)
    }
    try {
      await client.toggleProvider(input.providerId, { enabled: input.enabled })
      await set(hydrateModelsAtom)
      set(_lastActionError, null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rlog.error('[models] toggle provider failed', err)
      set(_lastActionError, input.enabled
        ? i18n.t('error.providerEnableFailed', { msg })
        : i18n.t('error.providerDisableFailed', { msg }))
      throw err
    }
  },
)

// ─── Phase 2.5: test-connection state machine (per-form, transient) ─────────
//
// Flow: the user fills (protocol, base_url, api_key, model) in the add/edit form →
// clicks "Test connection" → the state machine goes pristine → testing → passed | failed.
// **The save button is disabled until passed** (hard user constraint: "saving may only succeed once the form has been filled
// in and the test has passed"). Any change to a key field resets the state machine
// back to pristine, forcing a re-test.
//
// Held in useState rather than an atom: the state is **purely form-local**, with no
// need to share it across components; but the testProvider call itself is an atom
// (it needs the backend client + centralized error logging). So only one write atom
// `testProviderAtom` is exposed here, and the state machine is held via useState
// inside ChannelCredentialForm. This matches the §1.12 split of "useState is
// component-local, atoms are cross-component".

/**
 * Probe `(protocol, base_url, api_key, model)` against the real provider
 * — does NOT persist anything. Returns the `{ok, latency_ms?, error?}`
 * envelope unchanged so the form can show "test passed · 245ms" or the
 * Chinese error message verbatim. Network / daemon-side bugs throw;
 * credential / 404 / auth errors land in `result.ok === false`.
 * Kimi Coding is verified through `/models`; it does not wait for K3 output.
 *
 * Not wrapped in `_lastActionError` — the form has its own inline
 * test-result indicator next to the API Key field; we don't want the
 * settings-level banner flashing on every test click.
 */
export const testProviderAtom = atom(
  null,
  async (
    get,
    _set,
    input: {
      providerId: string
      protocol: 'openai' | 'anthropic'
      apiKey: string
      baseUrl?: string
      model: string
    },
  ): Promise<TestProviderResult> => {
    const client = buildAmphiClient(get)
    if (!client) {
      return { ok: false, error: i18n.t('error.backendNotReady') }
    }
    try {
      return await client.testProvider({
        provider_id: input.providerId,
        protocol: input.protocol,
        api_key: input.apiKey,
        base_url: input.baseUrl,
        model: input.model,
      })
    } catch (err) {
      // True daemon-side bug (5xx, network). Surface as failed test
      // rather than letting the form crash — user can read the message
      // and retry. We still log so the issue shows up in main.log.
      const msg = err instanceof Error ? err.message : String(err)
      rlog.error('[models] test connection threw (daemon-side)', err)
      return { ok: false, error: i18n.t('error.connectionTestFailed', { msg }) }
    }
  },
)

/**
 * Reveal one channel's stored api_key so the edit form can prefill it.
 *
 * Returns `''` on any failure (missing daemon, 404, OAuth channel with no key)
 * rather than throwing: the form treats "no key" and "couldn't read the key"
 * identically — it just starts from an empty field, exactly like before this
 * existed. A hard failure here must never block opening the editor.
 */
export const fetchProviderApiKeyAtom = atom(
  null,
  async (get, _set, providerId: string): Promise<string> => {
    const client = buildAmphiClient(get)
    if (!client) return ''
    try {
      return (await client.getProviderApiKey(providerId)) ?? ''
    } catch (err) {
      rlog.error('[models] reveal api key failed', err)
      return ''
    }
  },
)

/**
 * Ask the provider which models it exposes, for `(protocol, base_url, api_key)`
 * — does NOT persist anything. Returns the `{ok, models?, error?}` envelope
 * unchanged so the form can render the list or the Chinese error verbatim.
 *
 * Needs no model id (unlike {@link testProviderAtom}), which is what lets the
 * form flow be enter key → fetch list → tick → test instead of forcing the user to
 * hand-type a model id before anything can be verified.
 *
 * Same rationale as `testProviderAtom` for skipping `_lastActionError`: the
 * result is shown inline next to the button, not in the settings-level banner.
 */
export const fetchProviderModelsAtom = atom(
  null,
  async (
    get,
    _set,
    input: {
      providerId: string
      // 'openai-codex' is a subscription channel: the backend sends no network
      // request and returns the static catalog directly (the Codex backend has no
      // list-models endpoint), and no apiKey is needed.
      protocol: 'openai' | 'anthropic' | 'openai-codex'
      apiKey: string
      baseUrl?: string
    },
  ): Promise<FetchModelsResult> => {
    const client = buildAmphiClient(get)
    if (!client) {
      return { ok: false, error: i18n.t('error.backendNotReady') }
    }
    try {
      return await client.fetchProviderModels({
        provider_id: input.providerId,
        protocol: input.protocol,
        api_key: input.apiKey,
        base_url: input.baseUrl,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rlog.error('[models] fetch models threw (daemon-side)', err)
      return { ok: false, error: i18n.t('error.modelListFetchFailed', { msg }) }
    }
  },
)
