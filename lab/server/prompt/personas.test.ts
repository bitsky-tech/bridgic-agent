import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  PERSONA_SOURCE_PATHS,
  PERSONA_SOURCE_SHA256,
  PERSONA_SOURCE_VERSION,
} from "./personas.generated";
import {
  renderPersona,
  TURN_FAILED_MESSAGE,
} from "./personas";
import { promptPythonExecutable, promptSourceFingerprint } from "./source";
import type { PromptStage, PromptUiLanguage } from "./types";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const pythonExecutable = promptPythonExecutable(repositoryRoot);
const stages: PromptStage[] = [
  "main",
  "child",
  "clarify",
  "explore",
  "generate",
  "verify",
  "workflow_execute",
];

interface PythonPromptSnapshot {
  personas: Record<PromptStage, string>;
  turnFailedMessage: string;
}

function pythonPromptSnapshot(toolNames: string[], locale: "zh" | "en"): PythonPromptSnapshot {
  const script = String.raw`
import json
import sys
import types
from pathlib import Path

sys.dont_write_bytecode = True
repository_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(repository_root))
tool_names = json.loads(sys.argv[2])
locale = sys.argv[3]
from src.amphi_service.i18n import use_locale
import src
package = types.ModuleType("src.amphi_agent")
package.__path__ = [str(repository_root / "src/amphi_agent")]
package.__package__ = "src.amphi_agent"
sys.modules["src.amphi_agent"] = package
from src.amphi_agent.prompts.build.clarify import CLARIFY_PERSONA
from src.amphi_agent.prompts.build.explore import EXPLORE_PERSONA
from src.amphi_agent.prompts.build.generate import GENERATE_PERSONA
from src.amphi_agent.prompts.build.verify import VERIFY_PERSONA
from src.amphi_agent.prompts.normal.main import PERSONA
from src.amphi_agent.prompts.normal.subagent import SUB_AGENT_PERSONA
from src.amphi_agent.prompts.render import render_main_persona, render_stage_persona
from src.amphi_agent.prompts.turn_failed import TURN_FAILED_MESSAGE
from src.amphi_agent.prompts.workflow.execute import WORKFLOW_PERSONA
with use_locale(locale):
    personas = {
        "main": render_main_persona(tool_names, template=PERSONA).strip(),
        "child": render_main_persona(tool_names, template=SUB_AGENT_PERSONA).strip(),
        "clarify": render_stage_persona(tool_names, template=CLARIFY_PERSONA).strip(),
        "explore": render_stage_persona(tool_names, template=EXPLORE_PERSONA).strip(),
        "generate": render_stage_persona(tool_names, template=GENERATE_PERSONA).strip(),
        "verify": render_stage_persona(tool_names, template=VERIFY_PERSONA).strip(),
        "workflow_execute": render_stage_persona(tool_names, template=WORKFLOW_PERSONA).strip(),
    }
result = {
    "personas": personas,
    "turnFailedMessage": TURN_FAILED_MESSAGE,
}
json.dump(result, sys.stdout, ensure_ascii=False)
`;
  const process = Bun.spawnSync([pythonExecutable, "-c", script, repositoryRoot, JSON.stringify(toolNames), locale]);
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  return JSON.parse(process.stdout.toString()) as PythonPromptSnapshot;
}

describe("persona source snapshot", () => {
  test("is pinned to the current prompt source graph SHA-256", async () => {
    const current = await promptSourceFingerprint(repositoryRoot);
    expect(PERSONA_SOURCE_PATHS.join("\n")).toBe(current.paths.join("\n"));
    expect(current.sha256).toBe(PERSONA_SOURCE_SHA256);
    expect(String(PERSONA_SOURCE_VERSION)).toBe(`prompts@${current.sha256.slice(0, 12)}`);
  });

  for (const toolNames of [
    ["read_file"],
    ["read_file", "run_subagent"],
    ["read_file", "run_subagent", "start_subagent"],
  ]) {
    for (const { locale, uiLanguage } of [
      { locale: "zh", uiLanguage: "Chinese" },
      { locale: "en", uiLanguage: "English" },
    ] as const satisfies readonly { locale: "zh" | "en"; uiLanguage: PromptUiLanguage }[]) {
      test(`renders all seven personas byte-for-byte like Python for ${toolNames.join(", ")} (${locale})`, () => {
        const expected = pythonPromptSnapshot(toolNames, locale);
        expect(String(TURN_FAILED_MESSAGE)).toBe(expected.turnFailedMessage);
        for (const stage of stages) {
          const actual = renderPersona(stage, toolNames, undefined, uiLanguage);
          expect(actual.content).toBe(expected.personas[stage]);
          expect(actual.completeSnapshot).toBe(true);
          expect(actual.content).not.toContain("__AMPHI_");
        }
      });
    }
  }

  test("keeps the expected stage identities as a golden structural guard", () => {
    const tools = ["read_file"];
    expect(renderPersona("main", tools).content).toContain("You are Bridgic Agent, a general-purpose agent");
    expect(renderPersona("child", tools).content).toContain("This Session is a Child Agent");
    expect(renderPersona("clarify", tools).content).toContain("# Current stage: clarify");
    expect(renderPersona("explore", tools).content).toContain("# Current stage: explore");
    expect(renderPersona("generate", tools).content).toContain("# Current stage: generate");
    expect(renderPersona("verify", tools).content).toContain("# Current stage: verify");
    expect(renderPersona("workflow_execute", tools).content).toContain("# Current stage: Execute");
  });
});
