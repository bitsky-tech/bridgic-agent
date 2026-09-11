import { useMemo } from 'react'
import { Repeat2, Wrench } from 'lucide-react'
import App from '../App'
import type { DesktopAppExtensions } from '@/components/app/DesktopAppExtensions'
import { DebugSessionProvider, useDebugText } from './DebugSessionProvider'
import { DebugConversation } from './DebugConversation'
import { DebugRoundsPanel, DebugToolsPanel } from './DebugPanel'
import './debug.css'

export default function DebugApp() {
  const text = useDebugText()
  const extensions = useMemo<DesktopAppExtensions>(() => ({
    ConversationHistory: DebugConversation,
    sessionSurfaces: [
      { id: 'extension:debug-tools', placement: 'agent', label: text('工具调用', 'Tool calls'), icon: <Wrench size={17} />, Content: DebugToolsPanel },
      { id: 'extension:debug-rounds', placement: 'agent', label: text('Agent 循环', 'Agent rounds'), icon: <Repeat2 size={17} />, Content: DebugRoundsPanel },
    ],
  }), [text])
  return <DebugSessionProvider><App extensions={extensions} /></DebugSessionProvider>
}
