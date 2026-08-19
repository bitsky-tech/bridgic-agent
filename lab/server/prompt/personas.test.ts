import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  PERSONA_SOURCE_SHA256,
  PERSONA_SOURCE_VERSION,
  renderPersona,
} from "./personas";
import type { PromptStage } from "./types";

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

function pythonPersonas(toolNames: string[]): Record<PromptStage, string> {
  const script = String.raw`
import importlib.util
import json
import sys

source_path = sys.argv[1]
tool_names = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("bridgic_prompt_parity", source_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
result = {
    "main": module.render_main_persona(tool_names, template=module.PERSONA).strip(),
    "child": module.render_main_persona(tool_names, template=module.SUB_AGENT_PERSONA).strip(),
    "clarify": module.render_stage_persona(tool_names, template=module.CLARIFY_PERSONA).strip(),
    "explore": module.render_stage_persona(tool_names, template=module.EXPLORE_PERSONA).strip(),
    "generate": module.render_stage_persona(tool_names, template=module.GENERATE_PERSONA).strip(),
    "verify": module.render_stage_persona(tool_names, template=module.VERIFY_PERSONA).strip(),
    "workflow_execute": module.render_stage_persona(tool_names, template=module.WORKFLOW_PERSONA).strip(),
    "workflow_validate": module.render_stage_persona(tool_names, template=module.WORKFLOW_VALIDATE_PERSONA).strip(),
}
json.dump(result, sys.stdout, ensure_ascii=False)
`;
  const process = Bun.spawnSync(["python3", "-c", script, sourcePath, JSON.stringify(toolNames)]);
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  return JSON.parse(process.stdout.toString()) as Record<PromptStage, string>;
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
    test(`renders all eight personas byte-for-byte like Python for ${toolNames.join(", ")}`, () => {
      const expected = pythonPersonas(toolNames);
      for (const stage of stages) {
        const actual = renderPersona(stage, toolNames);
        expect(actual.content).toBe(expected[stage]);
        expect(actual.completeSnapshot).toBe(true);
        expect(actual.content).not.toContain("__AMPHI_");
      }
    });
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
