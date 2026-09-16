import { useMemo } from 'react'
import { Repeat2, ScanText, Wrench } from 'lucide-react'
import App from '../App'
import type { DesktopAppExtensions } from '@/components/app/DesktopAppExtensions'
import { DebugSessionProvider, useDebugText } from './DebugSessionProvider'
import { DebugConversation } from './DebugConversation'
import { DebugRoundsPanel, DebugToolsPanel } from './DebugPanel'
import { DebugPromptsPanel } from './DebugPromptsPanel'
import './debug.css'

export default function DebugApp() {
  const text = useDebugText()
  const extensions = useMemo<DesktopAppExtensions>(() => ({
    ConversationHistory: DebugConversation,
    sessionSurfaces: [
      { id: 'extension:debug-tools', placement: 'agent', label: text('toolCalls'), icon: <Wrench size={17} />, Content: DebugToolsPanel },
      { id: 'extension:debug-rounds', placement: 'agent', label: text('agentRounds'), icon: <Repeat2 size={17} />, Content: DebugRoundsPanel },
      { id: 'extension:debug-prompts', placement: 'agent', label: text('promptAnalysis.title'), icon: <ScanText size={17} />, Content: DebugPromptsPanel },
    ],
  }), [text])
  return <DebugSessionProvider><App extensions={extensions} /></DebugSessionProvider>
}
