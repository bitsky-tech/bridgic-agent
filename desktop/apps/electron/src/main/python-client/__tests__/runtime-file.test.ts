/**
 * Tests for runtime-file.ts.
 *
 * Covers:
 *  - missing file → null (common case: daemon not running)
 *  - malformed JSON → null (best-effort)
 *  - missing v1 required fields → null (defensive)
 *  - v2 file → all fields parsed, snake_case → camelCase
 *  - v1 file (no M1 fields) → required fields present, M1 fields all null
 *  - empty-string M1 values → null (treated as absent)
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildEndpoint, readRuntimeFile, tokenRotated, type RuntimeFile } from '../runtime-file'
import type { StatusJson } from '../types'

// Per-test temp dirs — bun:test does not have a tmp_path fixture, so we
// roll our own with mkdtemp and clean up in afterEach.
let tmpDirs: string[] = []

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-file-test-'))
  tmpDirs.push(dir)
  const file = path.join(dir, name)
  writeFileSync(file, contents)
  return file
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

describe('readRuntimeFile', () => {
  it('returns null when the file does not exist', () => {
    const phantom = path.join(os.tmpdir(), 'nonexistent-' + Math.random(), 'runtime.json')
    expect(readRuntimeFile(phantom)).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    const file = tmpFile('runtime.json', 'not json {{')
    expect(readRuntimeFile(file)).toBeNull()
  })

  it('returns null when required v1 fields are missing', () => {
    const file = tmpFile('runtime.json', JSON.stringify({ host: 'x' }))
    expect(readRuntimeFile(file)).toBeNull()
  })

  it('parses a full v2 file with all M1 fields', () => {
    const file = tmpFile(
      'runtime.json',
      JSON.stringify({
        host: '127.0.0.1',
        port: 7421,
        pid: 12345,
        started_at: '2026-05-28T12:00:00',
        token: 'I8MWXTcg__abc',
        lock_file: '/Users/foo/.bridgic/AmphiAgent/gateway.lock',
        ws_path: '/ws',
        version: '0.1.0',
        log_file: '/Users/foo/.bridgic/AmphiAgent/server.log',
      }),
    )
    const info = readRuntimeFile(file)
    expect(info).not.toBeNull()
    if (!info) return
    expect(info.host).toBe('127.0.0.1')
    expect(info.port).toBe(7421)
    expect(info.pid).toBe(12345)
    expect(info.startedAt).toBe('2026-05-28T12:00:00')
    expect(info.token).toBe('I8MWXTcg__abc')
    expect(info.lockFile).toBe('/Users/foo/.bridgic/AmphiAgent/gateway.lock')
    expect(info.wsPath).toBe('/ws')
    expect(info.version).toBe('0.1.0')
    expect(info.logFile).toBe('/Users/foo/.bridgic/AmphiAgent/server.log')
  })

  it('parses a v1 file (no M1 fields) with all M1 fields null', () => {
    const file = tmpFile(
      'runtime.json',
      JSON.stringify({
        host: '127.0.0.1',
        port: 7421,
        pid: 12345,
        started_at: '2026-05-28T12:00:00',
      }),
    )
    const info = readRuntimeFile(file)
    expect(info).not.toBeNull()
    if (!info) return
    expect(info.host).toBe('127.0.0.1')
    expect(info.port).toBe(7421)
    expect(info.token).toBeNull()
    expect(info.lockFile).toBeNull()
    expect(info.wsPath).toBeNull()
    expect(info.version).toBeNull()
    expect(info.logFile).toBeNull()
  })

  it('exports RuntimeFile type', () => {
    // Compile-time-only assertion that the shape is importable.
    const _shape: RuntimeFile = {
      host: 'x', port: 1, pid: 1, startedAt: 'x',
      token: null, lockFile: null, wsPath: null, version: null, logFile: null,
    }
    expect(_shape.host).toBe('x')
  })

  it('treats empty-string M1 values as null', () => {
    const file = tmpFile(
      'runtime.json',
      JSON.stringify({
        host: '127.0.0.1',
        port: 7421,
        pid: 12345,
        started_at: '2026-05-28T12:00:00',
        token: '',
        lock_file: '',
        ws_path: '',
        version: '',
      }),
    )
    const info = readRuntimeFile(file)
    expect(info).not.toBeNull()
    if (!info) return
    expect(info.token).toBeNull()
    expect(info.lockFile).toBeNull()
    expect(info.wsPath).toBeNull()
    expect(info.version).toBeNull()
    expect(info.logFile).toBeNull()
  })
})

// ─── buildEndpoint enrichment ────────────────────────────────────────────────

function mkStatus(
  overrides: Partial<Extract<StatusJson, { status: 'running' }>> = {},
): Extract<StatusJson, { status: 'running' }> {
  return {
    status: 'running',
    host: '127.0.0.1',
    port: 7421,
    base_url: 'http://127.0.0.1:7421',
    pid: 12345,
    started_at: '2026-05-28T12:00:00',
    runtime_file: '/tmp/runtime.json',
    ...overrides,
  }
}

function mkRuntime(overrides: Partial<RuntimeFile> = {}): RuntimeFile {
  return {
    host: '127.0.0.1',
    port: 7421,
    pid: 12345,
    startedAt: '2026-05-28T12:00:00',
    token: 'tok_abc',
    lockFile: '/tmp/gateway.lock',
    wsPath: '/ws',
    version: '0.1.0',
    logFile: null,
    ...overrides,
  }
}

describe('buildEndpoint', () => {
  it('uses runtime fields when host/port/pid match status', () => {
    const ep = buildEndpoint(mkStatus(), mkRuntime())
    expect(ep.baseUrl).toBe('http://127.0.0.1:7421')
    expect(ep.token).toBe('tok_abc')
    expect(ep.wsPath).toBe('/ws')
    expect(ep.version).toBe('0.1.0')
    expect(ep.startedAt).toBe('2026-05-28T12:00:00')
  })

  it('logFile prefers runtime.json, then status, then null', () => {
    const ep = buildEndpoint(mkStatus(), mkRuntime({ logFile: '/from/runtime/server.log' }))
    expect(ep.logFile).toBe('/from/runtime/server.log')

    const statusOnly = buildEndpoint(
      { ...mkStatus(), log_file: '/from/status/server.log' },
      null,
    )
    expect(statusOnly.logFile).toBe('/from/status/server.log')

    expect(buildEndpoint(mkStatus(), null).logFile).toBeNull()
  })

  it('discards runtime fields when daemon identity mismatches (pid race)', () => {
    // Same host/port but different pid — daemon must have restarted.
    const ep = buildEndpoint(mkStatus(), mkRuntime({ pid: 99999 }))
    expect(ep.token).toBeNull()
    expect(ep.wsPath).toBeNull()
  })

  it('discards runtime fields when started_at mismatches despite a reused pid', () => {
    const ep = buildEndpoint(mkStatus(), mkRuntime({ startedAt: '2026-05-28T12:00:01' }))
    expect(ep.token).toBeNull()
    expect(ep.wsPath).toBeNull()
  })

  it('falls back to status when runtime is null (file missing)', () => {
    const status = mkStatus({ version: '0.2.0', ws_path: '/ws' })
    const ep = buildEndpoint(status, null)
    expect(ep.token).toBeNull()
    expect(ep.version).toBe('0.2.0')
    expect(ep.wsPath).toBe('/ws')
  })

  it('falls back to all-null when both status and runtime are minimal (v1)', () => {
    const ep = buildEndpoint(mkStatus(), null)
    expect(ep.token).toBeNull()
    expect(ep.version).toBeNull()
    expect(ep.wsPath).toBeNull()
  })

  it('prefers runtime version over status version when both present', () => {
    const status = mkStatus({ version: '0.2.0' })
    const runtime = mkRuntime({ version: '0.1.0' })
    const ep = buildEndpoint(status, runtime)
    // Runtime wins (it's the authoritative on-disk record).
    expect(ep.version).toBe('0.1.0')
  })

  it('treats runtime as authoritative even when its token is null', () => {
    // A v2 daemon could in principle write token=null (degenerate, but
    // possible if auth is disabled by config). buildEndpoint must not
    // somehow merge with status's `token_set` flag — status never
    // contains the token value itself, only a boolean.
    const status = mkStatus({ token_set: true })
    const runtime = mkRuntime({ token: null })
    const ep = buildEndpoint(status, runtime)
    expect(ep.token).toBeNull()
  })
})

// ─── tokenRotated — daemon-restart detection on the health probe ─────────────

describe('tokenRotated', () => {
  // Endpoint currently in use carries token 'tok_abc'.
  const candidate = buildEndpoint(mkStatus(), mkRuntime())
  if (candidate.token === null) throw new Error('test fixture must carry a token')
  const current = { ...candidate, token: candidate.token }

  it('is false when runtime.json still carries the same token', () => {
    expect(tokenRotated(current, mkRuntime({ token: 'tok_abc' }))).toBe(false)
  })

  it('is true when runtime.json carries a NEW token (daemon restarted)', () => {
    expect(tokenRotated(current, mkRuntime({ token: 'tok_NEW_after_restart' }))).toBe(true)
  })

  it('is false when runtime is null (file missing / mid-rewrite — not a rotation)', () => {
    expect(tokenRotated(current, null)).toBe(false)
  })

  it('is false when runtime token is null (degenerate — keep the good token)', () => {
    expect(tokenRotated(current, mkRuntime({ token: null }))).toBe(false)
  })
})
