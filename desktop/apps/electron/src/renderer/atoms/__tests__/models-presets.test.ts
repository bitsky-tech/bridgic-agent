/**
 * Tests for atoms/models-presets.ts — pure provider display + form-preset +
 * base-URL normalization helpers (no atom store needed).
 */
import { describe, it, expect } from 'bun:test'
import {
  getProviderDisplay,
  getProviderDisplayById,
  getProviderCatalogDisplayName,
  getConfiguredProviderDisplayName,
  getProviderPreset,
  normalizeBaseUrl,
} from '../models-presets'
import type { ProviderCatalogEntry } from '../../lib/amphiClient'

describe('normalizeBaseUrl', () => {
  it('returns empty for null/undefined/blank', () => {
    expect(normalizeBaseUrl(null, 'openai')).toBe('')
    expect(normalizeBaseUrl(undefined, 'anthropic')).toBe('')
    expect(normalizeBaseUrl('   ', 'openai')).toBe('')
  })

  it('strips the anthropic /v1/messages suffix', () => {
    expect(normalizeBaseUrl('https://x.com/anthropic/v1/messages', 'anthropic')).toBe(
      'https://x.com/anthropic',
    )
  })

  it('strips openai /chat/completions and /v1/chat/completions suffixes', () => {
    expect(normalizeBaseUrl('https://x.com/v1/chat/completions', 'openai')).toBe('https://x.com')
    expect(normalizeBaseUrl('https://x.com/chat/completions', 'openai')).toBe('https://x.com')
  })

  it('trims trailing slashes and leaves a clean host root untouched', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/', 'openai')).toBe('https://api.deepseek.com')
    expect(normalizeBaseUrl('https://api.anthropic.com', 'anthropic')).toBe(
      'https://api.anthropic.com',
    )
  })

  it('does not strip an anthropic suffix when protocol is openai (no cross-match)', () => {
    // /v1/messages is anthropic-only; with openai protocol it stays.
    expect(normalizeBaseUrl('https://x.com/v1/messages', 'openai')).toBe('https://x.com/v1/messages')
  })
})

describe('getProviderDisplay / getProviderDisplayById', () => {
  it('returns known brand meta for built-in providers', () => {
    expect(getProviderDisplayById('anthropic').iconLetter).toBe('A')
    expect(getProviderDisplayById('anthropic').tag).toBe('recommended')
    expect(getProviderDisplayById('deepseek').tag).toBe('domestic')
    expect(getProviderDisplayById('kimi')).toEqual({
      iconLetter: 'K',
      brandColor: '#111111',
      tag: 'domestic',
    })
  })

  it('falls back to first-letter + grey for unknown ids', () => {
    const meta = getProviderDisplayById('moonshot')
    expect(meta.iconLetter).toBe('M')
    expect(meta.brandColor).toBe('#6B7280')
    expect(meta.tag).toBeUndefined()
  })

  it('getProviderDisplay falls back via the catalog display_name', () => {
    const entry = { id: 'zhipu', display_name: 'Zhipu GLM' } as ProviderCatalogEntry
    expect(getProviderDisplay(entry).iconLetter).toBe('Z')
  })
})

describe('getProviderCatalogDisplayName', () => {
  it('uses the locale catalog for known built-in provider names', () => {
    const entry = { id: 'glm', display_name: 'GLM (Zhipu)' } as ProviderCatalogEntry
    expect(getProviderCatalogDisplayName(entry, (key) => ({ 'providers.glm': 'GLM（智谱）' })[key] ?? key))
      .toBe('GLM（智谱）')
  })

  it('preserves a catalog name when the provider has no localized override', () => {
    const entry = { id: 'custom', display_name: 'Custom gateway' } as ProviderCatalogEntry
    expect(getProviderCatalogDisplayName(entry, (key) => key)).toBe('Custom gateway')
  })
})

describe('getConfiguredProviderDisplayName', () => {
  const glm = { id: 'glm', display_name: 'GLM (Zhipu)' } as ProviderCatalogEntry
  const translate = (key: string) => ({ 'providers.glm': 'GLM（智谱）' })[key] ?? key

  it('uses the current locale for catalog defaults and historical auto-filled values', () => {
    expect(getConfiguredProviderDisplayName(glm, null, translate)).toBe('GLM（智谱）')
    expect(getConfiguredProviderDisplayName(glm, 'GLM (智谱)', translate)).toBe('GLM（智谱）')
    expect(getConfiguredProviderDisplayName(glm, 'GLM (Zhipu)', translate)).toBe('GLM（智谱）')
  })

  it('retains an explicit provider rename', () => {
    expect(getConfiguredProviderDisplayName(glm, 'Team GLM gateway', translate)).toBe('Team GLM gateway')
  })
})

describe('getProviderPreset', () => {
  it('maps a catalog entry into the 5 form fields', () => {
    const entry = {
      id: 'deepseek',
      display_name: 'DeepSeek',
      protocol: 'openai',
      default_base_url: 'https://api.deepseek.com',
      models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
    } as ProviderCatalogEntry
    const preset = getProviderPreset(entry)
    expect(preset.providerId).toBe('deepseek')
    expect(preset.displayName).toBe('DeepSeek')
    expect(preset.protocol).toBe('openai')
    expect(preset.baseUrl).toBe('https://api.deepseek.com')
    expect(preset.models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('maps the Kimi Code catalog entry to the OpenAI-compatible form', () => {
    const entry = {
      id: 'kimi',
      display_name: 'Kimi Code',
      protocol: 'openai',
      default_base_url: 'https://api.kimi.com/coding/v1',
      models: [
        { id: 'kimi-for-coding' },
        { id: 'k3' },
        { id: 'kimi-for-coding-highspeed' },
      ],
    } as ProviderCatalogEntry
    expect(getProviderPreset(entry)).toMatchObject({
      providerId: 'kimi',
      displayName: 'Kimi Code',
      protocol: 'openai',
      baseUrl: 'https://api.kimi.com/coding/v1',
      models: ['kimi-for-coding', 'k3', 'kimi-for-coding-highspeed'],
    })
  })
})
