import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  PERSONA_SOURCE_SHA256,
  PERSONA_SOURCE_VERSION,
  renderPersona,
  TURN_FAILED_MESSAGE,
} from "./personas";
import type { PromptStage, PromptUiLanguage } from "./types";

const sourcePath = resolve(import.meta.dir, "../../../src/amphi_agent/_prompt.py");
const stages: PromptStage[] = [
  "main",
  "child",
  "clarify",
  "explore",
  "generate",
  "verify",
  "workflow_execute",
  "workflow_validate",
];

interface PythonPromptSnapshot {
  personas: Record<PromptStage, string>;
  turnFailedMessage: string;
}

function pythonPromptSnapshot(toolNames: string[], locale: "zh" | "en"): PythonPromptSnapshot {
  const script = String.raw`
import importlib.util
import json
import sys
from pathlib import Path

source_path = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source_path.parents[2]))
tool_names = json.loads(sys.argv[2])
locale = sys.argv[3]
from src.amphi_service.i18n import use_locale
spec = importlib.util.spec_from_file_location("src.amphi_agent._prompt_parity", source_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
with use_locale(locale):
    personas = {
        "main": module.render_main_persona(tool_names, template=module.PERSONA).strip(),
        "child": module.render_main_persona(tool_names, template=module.SUB_AGENT_PERSONA).strip(),
        "clarify": module.render_stage_persona(tool_names, template=module.CLARIFY_PERSONA).strip(),
        "explore": module.render_stage_persona(tool_names, template=module.EXPLORE_PERSONA).strip(),
        "generate": module.render_stage_persona(tool_names, template=module.GENERATE_PERSONA).strip(),
        "verify": module.render_stage_persona(tool_names, template=module.VERIFY_PERSONA).strip(),
        "workflow_execute": module.render_stage_persona(tool_names, template=module.WORKFLOW_PERSONA).strip(),
        "workflow_validate": module.render_stage_persona(tool_names, template=module.WORKFLOW_VALIDATE_PERSONA).strip(),
    }
result = {
    "personas": personas,
    "turnFailedMessage": module.TURN_FAILED_MESSAGE,
}
json.dump(result, sys.stdout, ensure_ascii=False)
`;
  const process = Bun.spawnSync(["python3", "-c", script, sourcePath, JSON.stringify(toolNames), locale]);
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  return JSON.parse(process.stdout.toString()) as PythonPromptSnapshot;
}

describe("persona source snapshot", () => {
  test("is pinned to the current _prompt.py SHA-256", async () => {
    const source = await Bun.file(sourcePath).arrayBuffer();
    const current = new Bun.CryptoHasher("sha256").update(source).digest("hex");
    expect(current).toBe(PERSONA_SOURCE_SHA256);
    expect(String(PERSONA_SOURCE_VERSION)).toBe(`_prompt.py@${current.slice(0, 12)}`);
  });

  for (const toolNames of [
    ["read_file", "run_subagent"],
    ["read_file", "run_subagent", "start_subagent"],
  ]) {
    for (const { locale, uiLanguage } of [
      { locale: "zh", uiLanguage: "Chinese" },
      { locale: "en", uiLanguage: "English" },
    ] as const satisfies readonly { locale: "zh" | "en"; uiLanguage: PromptUiLanguage }[]) {
      test(`renders all eight personas byte-for-byte like Python for ${toolNames.join(", ")} (${locale})`, () => {
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
    expect(renderPersona("workflow_validate", tools).content).toContain("# Current stage: Validate");
  });
});
