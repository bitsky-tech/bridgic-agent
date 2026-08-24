import {
  PERSONA_SOURCE_SHA256,
  PERSONA_SOURCE_SNAPSHOT,
  PERSONA_SOURCE_VERSION,
} from "./personas.generated";
import type { PromptPersonaSnapshot, PromptStage, PromptUiLanguage } from "./types";

const MAIN_TOOL_NAMES_PLACEHOLDER = "__AMPHI_MAIN_TOOL_NAMES__";
const STAGE_TOOL_NAMES_PLACEHOLDER = "__AMPHI_STAGE_TOOL_NAMES__";
const SUB_AGENT_GUIDANCE_PLACEHOLDER = "__AMPHI_SUB_AGENT_GUIDANCE__";
const UI_LANGUAGE_PLACEHOLDER = "__AMPHI_UI_LANGUAGE__";
const DEFAULT_UI_LANGUAGE = "Chinese";
const SUB_AGENT_TOOL_NAMES = new Set(["run_subagent", "start_subagent"]);

export const DEFAULT_PERSONAS: Required<Omit<PromptPersonaSnapshot, "version">> & { version: string } = {
  main: PERSONA_SOURCE_SNAPSHOT.main,
  child: PERSONA_SOURCE_SNAPSHOT.child,
  clarify: PERSONA_SOURCE_SNAPSHOT.clarify,
  explore: PERSONA_SOURCE_SNAPSHOT.explore,
  generate: PERSONA_SOURCE_SNAPSHOT.generate,
  verify: PERSONA_SOURCE_SNAPSHOT.verify,
  workflowExecute: PERSONA_SOURCE_SNAPSHOT.workflowExecute,
  workflowValidate: PERSONA_SOURCE_SNAPSHOT.workflowValidate,
  version: PERSONA_SOURCE_VERSION,
};

export { PERSONA_SOURCE_SHA256, PERSONA_SOURCE_VERSION };
export const PROMPT_HISTORY_CONTRACT = PERSONA_SOURCE_SNAPSHOT.promptHistoryContract;
export const TURN_FAILED_MESSAGE = PERSONA_SOURCE_SNAPSHOT.turnFailedMessage;

export interface RenderedPersona {
  content: string;
  version: string;
  usesInjectedSnapshot: boolean;
  completeSnapshot: boolean;
}

function formatToolNames(toolNames: string[]): string {
  return toolNames.map((name) => `\`${name}\``).join(", ") || "(none)";
}

function subAgentGuidance(toolNames: string[]): string {
  if (!toolNames.some((name) => SUB_AGENT_TOOL_NAMES.has(name))) return "";
  const guidance = PERSONA_SOURCE_SNAPSHOT.subAgentGuidance.trim();
  if (toolNames.includes("start_subagent")) return guidance;
  return guidance
    .split("\n")
    .filter((line) => !line.includes("`start_subagent`"))
    .join("\n");
}

export function renderPersona(
  stage: PromptStage,
  toolNames: string[],
  snapshot?: PromptPersonaSnapshot,
  uiLanguage: PromptUiLanguage = DEFAULT_UI_LANGUAGE,
): RenderedPersona {
  const key: Exclude<keyof PromptPersonaSnapshot, "version"> = stage === "workflow_execute"
    ? "workflowExecute"
    : stage === "workflow_validate"
      ? "workflowValidate"
      : stage;
  const injected = snapshot?.[key];
  const template = injected ?? DEFAULT_PERSONAS[key];
  const renderedNames = formatToolNames(toolNames);
  return {
    content: template
      .replaceAll(MAIN_TOOL_NAMES_PLACEHOLDER, renderedNames)
      .replaceAll(STAGE_TOOL_NAMES_PLACEHOLDER, renderedNames)
      .replaceAll(SUB_AGENT_GUIDANCE_PLACEHOLDER, subAgentGuidance(toolNames))
      .replaceAll(UI_LANGUAGE_PLACEHOLDER, uiLanguage)
      .trim(),
    version: snapshot?.version ?? DEFAULT_PERSONAS.version,
    usesInjectedSnapshot: injected !== undefined,
    completeSnapshot: injected === undefined,
  };
}
