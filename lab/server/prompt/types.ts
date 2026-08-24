export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PromptRole = "system" | "user" | "assistant" | "tool";
export type PromptUiLanguage = "Chinese" | "English";
export type PromptStage =
  | "main"
  | "child"
  | "clarify"
  | "explore"
  | "generate"
  | "verify"
  | "workflow_execute"
  | "workflow_validate";

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** JSON-ready equivalent of the Python Message objects sent to the model. */
export interface NativePromptMessage {
  role: PromptRole;
  content: string | null;
  toolCalls?: NativeToolCall[];
  toolCallId?: string;
  extras?: Record<string, unknown>;
}

export interface PromptUserInputBlock {
  type?: string;
  id?: string;
  label?: string;
  value?: unknown;
  resource?: string | null;
  group?: string;
  path?: string;
  [key: string]: unknown;
}

export interface PromptUserInput {
  text: string;
  blocks?: PromptUserInputBlock[];
}

export interface PromptSessionSnapshot {
  id: string;
  workspaceRoot: string;
  title?: string | null;
  parentSessionId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PromptTurnSnapshot {
  id: string;
  sessionId: string;
  sessionOrdinal: number;
  userInput: PromptUserInput;
  otaRecords: Record<string, unknown>[];
  agentState?: Record<string, unknown> | null;
  browserToolLoaded?: boolean;
  workspaceToolsLoaded?: boolean;
  skillsToolLoaded?: boolean;
  status?: string | null;
  error?: string | null;
  finalAnswer?: string | null;
  model?: string | null;
  executionMode?: string | null;
  createdAt?: string | null;
}

export interface PromptMountSnapshot {
  id?: string;
  absolutePath: string;
  kind?: string | null;
  label?: string | null;
}

export interface PromptEnvironmentSnapshot {
  osName?: string | null;
  osRelease?: string | null;
  architecture?: string | null;
  shell?: string | null;
  node?: string | null;
  python?: string | null;
}

export interface PromptWorkspaceSnapshot {
  workDir?: string | null;
  mounts?: PromptMountSnapshot[];
  environment?: PromptEnvironmentSnapshot;
  changedFiles?: string[];
  checkpoints?: string[];
  build?: {
    root?: string | null;
    operation?: "create" | "edit" | string;
    workflowId?: string | null;
    acceptanceReviewPresented?: boolean;
    tree?: string[];
  } | null;
  workflowRun?: {
    workflowId?: string | null;
    workflowName?: string | null;
    runId?: string | null;
    stage?: "execute" | "validate" | string;
    stepIndex?: number;
    executionSteps?: PromptWorkflowStep[];
    validationSteps?: PromptWorkflowStep[];
    currentInstruction?: string | null;
    sourceRoot?: string | null;
    packageRoot?: string | null;
    runRoot?: string | null;
    resultDir?: string | null;
    backgroundWorkDir?: string | null;
    originalInput?: string | null;
  } | null;
}

export interface PromptSkillSnapshot {
  name: string;
  description: string;
  location?: string | null;
  enabled?: boolean;
  builtin?: boolean;
}

export interface PromptScheduleSnapshot {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  nextRunAt?: string | null;
}

export interface PromptWorkflowStep {
  index: number | string;
  title: string;
  instruction?: string | null;
}

export interface PromptWorkflowSnapshot {
  id: string;
  name: string;
  entryPath?: string | null;
  description?: string | null;
}

export interface PromptWorkflowResultSnapshot {
  runId: string;
  workflowName: string;
  status: string;
  validationStatus?: string | null;
  resultDir?: string | null;
  backgroundWorkDir?: string | null;
  input?: string | null;
}

export interface PromptBrowserTabSnapshot {
  title: string;
  url: string;
  active?: boolean;
}

export interface PromptContextSnapshot {
  skills?: PromptSkillSnapshot[];
  schedules?: PromptScheduleSnapshot[] | null;
  workflows?: PromptWorkflowSnapshot[];
  workflowResults?: PromptWorkflowResultSnapshot[];
  memories?: string[];
  browserTabs?: PromptBrowserTabSnapshot[];
  artifacts?: Record<string, string>;
  /** Resolved mention id -> absolute path, after the runtime's ownership gate. */
  referencePaths?: Record<string, string>;
}

export interface PromptToolSchemaSnapshot {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  group?: string;
  advanced?: boolean;
}

export interface PromptPersonaSnapshot {
  main?: string;
  child?: string;
  clarify?: string;
  explore?: string;
  generate?: string;
  verify?: string;
  workflowExecute?: string;
  workflowValidate?: string;
  version?: string;
}

export interface PromptRebuildInput {
  session: PromptSessionSnapshot;
  turns: PromptTurnSnapshot[];
  targetTurnId: string;
  /** Zero-based index. The output reconstructs the model call before this round ran. */
  targetRoundIndex: number;
  targetRoundId?: string;
  workspace?: PromptWorkspaceSnapshot;
  context?: PromptContextSnapshot;
  toolCatalog?: PromptToolSchemaSnapshot[];
  personas?: PromptPersonaSnapshot;
  /** Exact request-scoped UI language when captured; otherwise the Lab uses its documented fallback. */
  uiLanguage?: PromptUiLanguage;
  /** Exact persisted value when known; otherwise the Lab infers it from Turn creation time. */
  promptTime?: string;
}

export type PromptComponentKind =
  | "persona"
  | "context"
  | "session_history"
  | "current_input"
  | "current_turn"
  | "tools";

export type PromptComponentFidelity = "exact" | "reconstructed" | "partial" | "unavailable";

export interface PromptComponent {
  id: string;
  kind: PromptComponentKind;
  label: string;
  content?: string;
  messageIndexes: number[];
  source: string[];
  fidelity: PromptComponentFidelity;
  limitations: string[];
  metadata?: Record<string, JsonValue>;
}

export interface PromptToolSummary {
  name: string;
  description: string;
  group: string;
  advanced: boolean;
  required: string[];
  properties: string[];
  parameters: Record<string, unknown>;
  schemaFidelity: "snapshot" | "lab_catalog" | "observed" | "name_only";
}

export interface PromptFidelity {
  level: "reconstructed" | "partial";
  /** Normalized confidence from 0 to 1. */
  score: number;
  exactComponents: number;
  totalComponents: number;
  limitations: string[];
}

/** Directly serializable response body for the Lab prompt endpoint. */
export interface PromptRebuildResult {
  sessionId: string;
  turnId: string;
  roundId: string;
  roundIndex: number;
  stage: PromptStage;
  model: string | null;
  messages: NativePromptMessage[];
  tools: PromptToolSummary[];
  components: PromptComponent[];
  fidelity: PromptFidelity;
  reconstructedAt: string;
}

export class PromptRebuildError extends Error {
  constructor(
    public readonly code: "TURN_NOT_FOUND" | "ROUND_NOT_FOUND" | "SESSION_MISMATCH" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "PromptRebuildError";
  }
}
