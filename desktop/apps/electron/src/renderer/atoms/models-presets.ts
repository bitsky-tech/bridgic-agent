/**
 * Provider display meta + form presets + base-URL normalization.
 *
 * Pure functions and constants, NO atoms — split out of atoms/models.ts so
 * the picker / settings list / add-flow grid all share one source for "what
 * does provider X look like" and how to prefill its form, and so this logic
 * is unit-testable without the atom store. Re-exported from atoms/models.ts
 * so existing `@/atoms/models` call sites keep working.
 */
import type { ModelLimits, ProviderCatalogEntry } from '../lib/amphiClient'

/** UI-only display metadata (icon letter + brand color + optional tag).
 *  Single source of truth for "what color/letter does provider X look like".
 *  Unknown ids fall back to neutral grey + first letter of `display_name`. */
export interface ProviderDisplayMeta {
  iconLetter: string
  /** Brand hex color for the icon tile (e.g. Anthropic orange). */
  brandColor: string
  /** Stable ASCII discriminator — display goes through the `modals.model.tag.*` catalog keys. */
  tag?: 'recommended' | 'domestic'
}
const FALLBACK_BRAND_COLOR = '#6B7280'
const PROVIDER_DISPLAY_NAME_KEYS: Record<string, string> = {
  glm: 'providers.glm',
}
const LEGACY_PROVIDER_DISPLAY_NAMES: Record<string, readonly string[]> = {
  // The catalog used this before provider names became locale-aware. Treat old
  // auto-filled values as defaults, not as user overrides, after an upgrade.
  glm: ['GLM (智谱)', 'GLM（智谱）'],
}
const PROVIDER_DISPLAY: Record<string, ProviderDisplayMeta> = {
  anthropic: { iconLetter: 'A', brandColor: '#D97757', tag: 'recommended' },
  openai: { iconLetter: 'O', brandColor: '#10A37F' },
  deepseek: { iconLetter: 'D', brandColor: '#4D6BFE', tag: 'domestic' },
  kimi: { iconLetter: 'K', brandColor: '#111111', tag: 'domestic' },
}

/** Look up display meta for a catalog entry. Falls back when unknown. */
export function getProviderDisplay(entry: ProviderCatalogEntry): ProviderDisplayMeta {
  const known = PROVIDER_DISPLAY[entry.id]
  if (known) return known
  return {
    iconLetter: entry.display_name[0]?.toUpperCase() ?? '?',
    brandColor: FALLBACK_BRAND_COLOR,
  }
}

/** Resolve a built-in provider's user-visible name. The backend catalog keeps
 *  a stable English wire value; locale-specific presentation belongs here. */
export function getProviderCatalogDisplayName(
  entry: ProviderCatalogEntry,
  translate: (key: string) => string,
): string {
  const key = PROVIDER_DISPLAY_NAME_KEYS[entry.id]
  return key ? translate(key) : entry.display_name
}

/** Resolve a configured provider name, retaining only explicit user overrides. */
export function getConfiguredProviderDisplayName(
  entry: ProviderCatalogEntry,
  configuredDisplayName: string | null,
  translate: (key: string) => string,
): string {
  const catalogDisplayName = getProviderCatalogDisplayName(entry, translate)
  const legacyNames = LEGACY_PROVIDER_DISPLAY_NAMES[entry.id] ?? []
  if (
    !configuredDisplayName
    || configuredDisplayName === entry.display_name
    || configuredDisplayName === catalogDisplayName
    || legacyNames.includes(configuredDisplayName)
  ) {
    return catalogDisplayName
  }
  return configuredDisplayName
}

/** Look up display meta by raw provider id (no catalog entry needed).
 *  Used in places where we only have an id string and want the brand,
 *  e.g. the model picker rendering rows for a configured provider. */
export function getProviderDisplayById(providerId: string): ProviderDisplayMeta {
  const known = PROVIDER_DISPLAY[providerId]
  if (known) return known
  return {
    iconLetter: providerId[0]?.toUpperCase() ?? '?',
    brandColor: FALLBACK_BRAND_COLOR,
  }
}

/** Strip provider-side path suffix from a Base URL so the SDK can append
 *  it itself (otherwise we get `.../v1/messages/v1/messages` → 404).
 *
 *  Why this lives in the frontend:
 *    The SDKs (Anthropic Python / OpenAI Python) all treat `base_url` as the
 *    host root and append `/v1/messages` or `/chat/completions` themselves. It
 *    is very common for users to copy-paste a full endpoint URL
 *    (`https://x.com/anthropic/v1/messages`) into the GUI, and since the
 *    problem originates in user input, normalization belongs in the
 *    input-collection layer. The backend keeps passing it through unchanged.
 *
 *  Anthropic suffix: `/v1/messages`
 *  OpenAI suffix: `/chat/completions` or `/v1/chat/completions`
 *  Any other trailing `/` is trimmed as well. */
export function normalizeBaseUrl(
  raw: string | null | undefined,
  protocol: 'openai' | 'anthropic',
): string {
  if (!raw) return ''
  let url = raw.trim().replace(/\/+$/, '') // trim trailing /
  if (protocol === 'anthropic') {
    if (url.endsWith('/v1/messages')) url = url.slice(0, -'/v1/messages'.length)
  } else {
    if (url.endsWith('/v1/chat/completions')) {
      url = url.slice(0, -'/v1/chat/completions'.length)
    } else if (url.endsWith('/chat/completions')) {
      url = url.slice(0, -'/chat/completions'.length)
    }
  }
  return url.replace(/\/+$/, '')
}

/** Form-field defaults that ChannelCredentialForm loads when the user picks a
 *  preset card in Step1. Built-in vendor presets come from the backend catalog
 *  via {@link getProviderPreset}; the static custom-protocol presets below add
 *  the "OpenAI-compatible" / "Anthropic-compatible" slots that have no catalog
 *  entry. */
export interface ProviderPreset {
  providerId: string
  /** Suggested default; user can edit before saving. */
  displayName: string
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  models: string[]
  modelLimits: Record<string, ModelLimits>
  /** Configured channel's auth method (edit mode carries it in from
   *  ConfiguredProvider so the form re-displays the right radio). Absent in
   *  add mode → form falls back to the catalog's default_auth_mode. */
  authMode?: 'oauth' | 'api_key'
}

/** Custom-protocol presets — slugs that DO NOT exist in the backend catalog,
 *  so the form starts blank except for protocol. The user edits providerId /
 *  displayName / baseUrl / models / apiKey freely. */
export const CUSTOM_PROTOCOL_PRESETS: ProviderPreset[] = [
  {
    providerId: '', // user must fill a slug for custom channels
    displayName: '',
    protocol: 'openai',
    baseUrl: '',
    models: [],
    modelLimits: {},
  },
  {
    providerId: '',
    displayName: '',
    protocol: 'anthropic',
    baseUrl: '',
    models: [],
    modelLimits: {},
  },
]

/** Resolve preset for a catalog entry. Mirrors what {@link getProviderDisplay}
 *  does for visual meta — the form uses this to populate the 5 input fields
 *  when the user clicks a built-in vendor card in Step1. */
export function getProviderPreset(entry: ProviderCatalogEntry, displayName = entry.display_name): ProviderPreset {
  return {
    providerId: entry.id,
    displayName,
    protocol: entry.protocol,
    baseUrl: entry.default_base_url,
    models: entry.models.map((m) => m.id),
    modelLimits: Object.fromEntries(
      entry.models
        .filter((model) => model.limits && Object.keys(model.limits).length > 0)
        .map((model) => [model.id, { ...model.limits, source: 'models_dev' as const }]),
    ),
  }
}
