// Re-export both types and runtime values. `export type *` (the
// previous form) elided the value exports (`DEFAULT_SETTINGS`,
// `SETTINGS_VERSION`), which callers actually need.
//
// ThemeMode goes through the value re-export (not `export type`)
// because it's now a const+type pair via declaration merging — callers
// need both the value (ThemeMode.Light etc.) and the type.
export type {
  AppSettings,
  GuiSettings,
  WindowBounds,
} from './settings'
export {
  DEFAULT_SETTINGS,
  RIGHT_PANEL_RAIL_WIDTH,
  SETTINGS_VERSION,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_MIN,
  ZOOM_LEVEL_STEP,
  ThemeMode,
  clampZoomLevel,
  zoomPercent,
} from './settings'

export type {
  AgentMessage,
  AgentMessageOptions,
  AgentTurnStatus,
  AgentMessageToolCall,
  AgentMessageSubagent,
  MessageBlock,
  SessionMeta,
  SubAgentMode,
  SessionsIndexFile,
} from './sessions'
export { AgentRole } from './sessions'
