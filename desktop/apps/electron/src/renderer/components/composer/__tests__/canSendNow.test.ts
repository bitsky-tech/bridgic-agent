/**
 * `canSendNow` send gate: editable input does not necessarily mean sendable input.
 *
 * The composer deliberately remains editable during execution so users can prepare their next
 * message, but the serial-chat backend rejects another chat before the prior turn finishes.
 * Enabling input must therefore keep sending blocked here.
 */
import { describe, expect, it } from 'bun:test'
import { canSendNow } from '../canSendNow'

const SESSION = 's-1'

describe('canSendNow', () => {
  it('只允许已有会话的空闲状态发送', () => {
    expect(canSendNow(SESSION, false, false)).toBe(true)
    // Regression: after removing streaming from ChatInputZone's disabled state, this is the only
    // guard preventing an invalid send to the serial-chat daemon.
    expect(canSendNow(SESSION, false, true)).toBe(false)
    expect(canSendNow(SESSION, true, false)).toBe(false)
    expect(canSendNow(null, false, false)).toBe(false)
    expect(canSendNow(null, true, true)).toBe(false)
    expect(canSendNow(SESSION, true, true)).toBe(false)
    expect(canSendNow(null, false, true)).toBe(false)
  })
})
