/**
 * Tests for `detectSkillRemoteSource` — the remote-import source classifier.
 *
 * Pure-logic only (no DOM). Covers the importable sources (GitHub URL forms +
 * skills.sh pages), the display-only clawhub, and the null / unknown edges that
 * gate the wizard's 「已识别为 X」hint, 导入 button, and Review source badge.
 */
import { describe, it, expect } from 'bun:test'

import { detectSkillRemoteSource } from '../skillImportSource'

describe('detectSkillRemoteSource', () => {
  it('recognises every GitHub URL form as an importable github source', () => {
    const urls = [
      'https://github.com/bitsky-tech/bridgic-browser/',
      'https://github.com/bitsky-tech/bridgic-browser.git',
      'https://github.com/anthropics/skills/tree/andibrae/create-top-level-namespace/skills/xlsx',
      'https://github.com/openai/skills/blob/main/skills/.curated/pdf/SKILL.md',
    ]
    for (const url of urls) {
      const got = detectSkillRemoteSource(url)
      expect(got).toEqual({ kind: 'github', label: 'GitHub', badge: 'GitHub', importable: true })
    }
  })

  it('recognises skills.sh pages (incl. www.) as an importable source', () => {
    expect(
      detectSkillRemoteSource(
        'https://www.skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
      ),
    ).toEqual({ kind: 'skillsSh', label: 'skills.sh', badge: 'skills.sh', importable: true })
    expect(detectSkillRemoteSource('https://skills.sh/@team/web-scraper')).toEqual({
      kind: 'skillsSh',
      label: 'skills.sh',
      badge: 'skills.sh',
      importable: true,
    })
  })

  it('marks clawhub as a recognised but non-importable source', () => {
    expect(detectSkillRemoteSource('https://clawhub.ai/s/feishu-bot')).toEqual({
      kind: 'clawhub',
      label: 'ClawHub',
      badge: 'ClawHub',
      importable: false,
    })
  })

  it('strips a www. prefix before matching the host', () => {
    expect(detectSkillRemoteSource('https://www.github.com/acme/skills')?.kind).toBe('github')
  })

  it('returns an unknown, non-importable source for other http(s) hosts', () => {
    const got = detectSkillRemoteSource('https://gitlab.com/acme/skills')
    expect(got).toEqual({ kind: 'unknown', label: 'gitlab.com', badge: 'gitlab.com', importable: false })
  })

  it('returns null for empty input, a bare path, or a non-http scheme', () => {
    expect(detectSkillRemoteSource('')).toBeNull()
    expect(detectSkillRemoteSource('   ')).toBeNull()
    expect(detectSkillRemoteSource('github.com/acme/skills')).toBeNull()
    expect(detectSkillRemoteSource('/Users/me/skills')).toBeNull()
    expect(detectSkillRemoteSource('ftp://github.com/acme/skills')).toBeNull()
  })
})
