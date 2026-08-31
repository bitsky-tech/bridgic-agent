/** Latch PowerPoint activity until its Session surface is actually visible. */
import { useLayoutEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  powerPointNeedsAttentionFamily,
  setPowerPointNeedsAttentionAtom,
} from '@/atoms/powerpoint-attention'

export interface UsePowerPointAttentionOptions {
  isPowerPointSeen: boolean
  sessionId: string | null
}

/** Return and maintain the viewed Session's persistent PowerPoint attention state. */
export function usePowerPointAttention({
  isPowerPointSeen,
  sessionId,
}: UsePowerPointAttentionOptions): boolean {
  const needsAttention = useAtomValue(powerPointNeedsAttentionFamily(sessionId ?? ''))
  const setNeedsAttention = useSetAtom(setPowerPointNeedsAttentionAtom)

  useLayoutEffect(() => {
    if (!sessionId || !isPowerPointSeen || !needsAttention) return
    setNeedsAttention({ sessionId, needsAttention: false })
  }, [isPowerPointSeen, needsAttention, sessionId, setNeedsAttention])

  return needsAttention && !isPowerPointSeen
}
