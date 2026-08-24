import { describe, expect, test } from "bun:test";

import { rebuildPrompt } from "./reconstruct";
import type { PromptRebuildInput, PromptTurnSnapshot } from "./types";

function turn(
  id: string,
  ordinal: number,
  text: string,
  otaRecords: Record<string, unknown>[],
  overrides: Partial<PromptTurnSnapshot> = {},
): PromptTurnSnapshot {
  const records = otaRecords.map((round) => {
    const rawScope = round.think_scope;
    const scope = rawScope && typeof rawScope === "object" && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : {};
    return {
      ...round,
      think_scope: { prompt_contract: "history_v2", ...scope },
    };
  });
  return {
    id,
    sessionId: "session-1",
    sessionOrdinal: ordinal,
    userInput: { text },
    otaRecords: records,
    agentState: { think: { mode: "normal", stage: "main" } },
    createdAt: "2026-08-18T01:02:00Z",
    model: "gpt-test",
    ...overrides,
  };
}

function request(turns: PromptTurnSnapshot[], targetTurnId: string, targetRoundIndex: number): PromptRebuildInput {
  return {
    session: { id: "session-1", workspaceRoot: "/sessions/session-1" },
    turns,
    targetTurnId,
    targetRoundIndex,
    uiLanguage: "Chinese",
    promptTime: "2026-08-18 09:02 (UTC+08:00)",
    workspace: {
      workDir: "/sessions/session-1/.work",
      mounts: [],
      environment: {
        osName: "Darwin",
        osRelease: "25.0",
        architecture: "arm64",
        shell: "Bash",
        node: "bundled Node 24",
        python: "Python 3.13",
      },
      changedFiles: [],
    },
    context: {
      skills: [],
      schedules: [],
      workflows: [],
      workflowResults: [],
      memories: [],
      browserTabs: [],
    },
  };
}

describe("rebuildPrompt", () => {
  test("interprets SQLite's naive persisted timestamp as UTC before rendering local prompt time", () => {
    const current = turn("turn-current", 0, "Check the clock", [{}], {
      createdAt: "2026-08-18 01:02:00.000000",
    });
    const input = request([current], current.id, 0);
    delete input.promptTime;

    const result = rebuildPrompt(input);
    const local = new Date("2026-08-18T01:02:00Z");
    const two = (value: number) => String(value).padStart(2, "0");
    const expected = `${local.getFullYear()}-${two(local.getMonth() + 1)}-${two(local.getDate())} ${two(local.getHours())}:${two(local.getMinutes())}`;

    expect(result.messages.find((message) => message.role === "user")?.content).toContain(expected);
  });

  test("rebuilds the call before the selected round and excludes that round's result", () => {
    const current = turn("turn-current", 0, "Inspect the project", [
      {
        think_result: { step_content: "I will inspect it." },
        action_result: {
          results: [{
            tool_id: "call-1",
            tool_name: "read_file",
            tool_arguments: { file_path: "README.md" },
            success: true,
            tool_result: "# Project",
          }],
        },
        observation_result: "The README was found.",
      },
      {
        think_result: { step_content: "This belongs to the selected round." },
        action_result: { results: [] },
      },
    ]);

    const result = rebuildPrompt(request([current], current.id, 1));

    expect(result.roundIndex).toBe(1);
    expect(result.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(result.messages[2]?.toolCalls?.[0]).toEqual({
      id: "call-1",
      name: "read_file",
      arguments: { file_path: "README.md" },
    });
    expect(result.messages.some((message) => message.content?.includes("selected round"))).toBe(false);
    expect(result.components.find((item) => item.id === "current-turn")?.metadata?.completedRounds).toBe(1);
  });

  test("replays all Session history without an OTA-record limit", () => {
    const old = turn("turn-old", 0, "old-should-remain", Array.from({ length: 60 }, () => ({})));
    const recent = turn("turn-recent", 1, "recent-should-remain", Array.from({ length: 50 }, () => ({})));
    const current = turn("turn-current", 2, "current", [{}]);

    const result = rebuildPrompt(request([old, recent, current], current.id, 0));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(contents).toContain("recent-should-remain");
    expect(contents).toContain("old-should-remain");
    expect(result.components.find((item) => item.id === "session-history")?.metadata?.includedTurns).toBe(2);
    expect(result.components.find((item) => item.id === "session-history")?.metadata?.recordLimit).toBeUndefined();
    expect(result.components.find((item) => item.id === "session-history")?.metadata?.promptContract).toBe("history_v2");
  });

  test("uses the legacy bounded text replay when the prompt contract is absent", () => {
    const old = turn("turn-old", 0, "old-should-be-omitted", Array.from({ length: 60 }, () => ({})));
    const recent = turn("turn-recent", 1, "recent-should-remain", Array.from({ length: 50 }, () => ({})));
    const failed = turn("turn-failed", 2, "failed-question", [{
      think_result: { step_content: "legacy-failed-reply", tool_calls: [] },
    }], { status: "failed", error: "Provider unavailable" });
    const current = turn("turn-current", 3, "current", [{}]);
    const targetScope = current.otaRecords[0]?.think_scope as Record<string, unknown>;
    delete targetScope.prompt_contract;

    const result = rebuildPrompt(request([old, recent, failed, current], current.id, 0));
    const contents = result.messages.map((message) => message.content ?? "");
    const historyComponent = result.components.find((item) => item.id === "session-history");

    expect(contents).toContain("failed-question");
    expect(contents).toContain("recent-should-remain");
    expect(contents).not.toContain("legacy-failed-reply");
    expect(contents).not.toContain("old-should-be-omitted");
    expect(result.messages.slice(1).some((message) => message.content?.includes("<turn_failed>"))).toBe(false);
    expect(JSON.stringify(result.messages)).not.toContain("Provider unavailable");
    expect(historyComponent?.metadata).toMatchObject({
      promptContract: "legacy",
      recordLimit: 100,
    });
  });

  test("marks an unknown future prompt contract as unsupported", () => {
    const previous = turn("turn-previous", 0, "previous", []);
    const current = turn("turn-current", 1, "current", [{}]);
    const targetScope = current.otaRecords[0]?.think_scope as Record<string, unknown>;
    targetScope.prompt_contract = "history_v_next";

    const result = rebuildPrompt(request([previous, current], current.id, 0));
    const historyComponent = result.components.find((item) => item.id === "session-history");

    expect(historyComponent?.fidelity).toBe("partial");
    expect(historyComponent?.limitations).toContain(
      "Unsupported prompt history contract history_v_next; Session history was projected with legacy semantics.",
    );
    expect(historyComponent?.metadata?.promptContract).toBe("history_v_next");
  });

  test("selects the history contract from the exact target round", () => {
    const failed = turn("turn-failed", 0, "failed-question", [{
      think_result: { step_content: "partial-failed-reply", tool_calls: [] },
    }], { status: "failed", error: "Provider unavailable" });
    const current = turn("turn-current", 1, "current", [{}, {}]);
    const legacyScope = current.otaRecords[0]?.think_scope as Record<string, unknown>;
    delete legacyScope.prompt_contract;

    const legacy = rebuildPrompt(request([failed, current], current.id, 0));
    const v2 = rebuildPrompt(request([failed, current], current.id, 1));
    const legacyHistory = legacy.messages.slice(1).map((message) => message.content ?? "");
    const v2History = v2.messages.slice(1).map((message) => message.content ?? "");
    const marker = "<turn_failed>This Turn failed before completion. "
      + "Its preceding Agent content may be incomplete.</turn_failed>";

    expect(legacyHistory).not.toContain("partial-failed-reply");
    expect(legacyHistory).not.toContain(marker);
    expect(legacy.components.find((item) => item.id === "session-history")?.metadata).toMatchObject({
      promptContract: "legacy",
      recordLimit: 100,
    });
    expect(v2History).toContain("partial-failed-reply");
    expect(v2History).toContain(marker);
    expect(v2.components.find((item) => item.id === "session-history")?.metadata?.promptContract).toBe("history_v2");
    expect(v2.components.find((item) => item.id === "session-history")?.metadata?.recordLimit).toBeUndefined();
  });

  test("renders persisted structured inputs in Session history", () => {
    const previous = turn("turn-previous", 0, "/build Create report from references", [{
      think_result: { step_content: "Historical structured answer", tool_calls: [] },
    }], {
      userInput: {
        text: "/build Create report from references",
        blocks: [
          { type: "slash", id: "build", label: "build", resource: null },
          { type: "text", value: " Create report from " },
          { type: "mention", id: "mount-project", label: "Project", path: "spec.md" },
          { type: "text", value: " and " },
          { type: "mention", id: "removed-mount", label: "Removed", path: "" },
          { type: "text", value: " with " },
          {
            type: "mention",
            id: "run-prior",
            label: "Prior",
            group: "WorkflowRun",
            path: "report.md",
          },
        ],
      },
    });
    const current = turn("turn-current", 1, "Continue", [{}]);
    const input = request([previous, current], current.id, 0);
    input.context = {
      ...input.context,
      referencePaths: { "mount-project": "/mounted/project" },
      workflowResults: [{
        runId: "run-prior",
        workflowName: "Prior report",
        status: "completed",
        resultDir: "/published/run-prior/result",
      }],
    };

    const result = rebuildPrompt(input);

    expect(result.messages[1]?.content).toBe(
      "The user explicitly requested reusable Workflow Build mode. Additional input: "
      + "Create report from Project(/mounted/project/spec.md) and @Removed "
      + "with Prior(/published/run-prior/result/report.md)",
    );
    expect(result.messages[2]?.content).toBe("Historical structured answer");
    const historyComponent = result.components.find((item) => item.id === "session-history");
    expect(historyComponent?.fidelity).toBe("partial");
    expect(historyComponent?.limitations).toContain(
      "Localized slash-command intent prose is approximated by the Lab copy.",
    );
  });

  test("keeps Agent content from a failed historical Turn", () => {
    const failed = turn("turn-failed", 0, "Trigger the failed request", [{
      think_result: { step_content: "Partial response before failure", tool_calls: [] },
    }], {
      status: "failed",
      error: "Provider unavailable",
    });
    const current = turn("turn-current", 1, "Continue", [{}]);

    const result = rebuildPrompt(request([failed, current], current.id, 0));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(contents).toContain("Trigger the failed request");
    expect(contents).toContain("Partial response before failure");
    const marker = "<turn_failed>This Turn failed before completion. "
      + "Its preceding Agent content may be incomplete.</turn_failed>";
    expect(contents).toContain(marker);
    expect(contents.indexOf(marker)).toBe(contents.indexOf("Partial response before failure") + 1);
    expect(contents).not.toContain("Provider unavailable");
    expect(JSON.stringify(result.messages)).not.toContain("Provider unavailable");
  });

  test("replays persisted historical Think tool calls as atomic assistant/tool pairs", () => {
    const previous = turn("turn-previous", 0, "Read it", [{
      think_result: {
        step_content: "Reading.",
        tool_calls: [{ tool: "read_file", tool_arguments: [{ name: "file_path", value: "a.txt" }] }],
      },
      action_result: {
        results: [{ tool_id: "history-call", tool_name: "read_file", success: true, tool_result: "hello" }],
      },
    }]);
    const current = turn("turn-current", 1, "Continue", [{}]);

    const result = rebuildPrompt(request([previous, current], current.id, 0));
    const assistant = result.messages.find((message) => message.toolCalls?.[0]?.id === "history-call");
    const toolMessage = result.messages.find((message) => message.toolCallId === "history-call");

    expect(assistant?.toolCalls?.[0]?.arguments).toEqual({ file_path: "a.txt" });
    expect(toolMessage).toEqual({ role: "tool", content: "hello", toolCallId: "history-call" });
  });

  test("summarizes unsafe current-turn tool replay when an argument is too large", () => {
    const current = turn("turn-current", 0, "Write it", [
      {
        think_result: { step_content: "Writing." },
        action_result: {
          results: [{
            tool_id: "large-call",
            tool_name: "write_file",
            tool_arguments: { file_path: "large.txt", content: "x".repeat(1_201) },
            success: true,
            tool_result: "Created large.txt",
          }],
        },
      },
      {},
    ]);

    const result = rebuildPrompt(request([current], current.id, 1));
    const replay = result.messages.find((message) => message.content?.includes("large arguments not replayed"));

    expect(replay?.role).toBe("assistant");
    expect(replay?.toolCalls).toBeUndefined();
    expect(replay?.content).toContain("`content` (1201 characters)");
  });

  test("preserves the historical Session-history policy for earlier scoped Explore records", () => {
    const previous = turn("turn-previous", 0, "previous-conversation", []);
    const current = turn("turn-current", 1, "Explore it", [{ think_scope: { mode: "build", stage: "explore" } }], {
      agentState: { think: { mode: "build", stage: "explore" } },
    });
    const input = request([previous, current], current.id, 0);
    input.workspace = { ...input.workspace, build: { root: "/sessions/session-1/.work/.build", tree: ["task.md"] } };
    input.context = { ...input.context, artifacts: { "task.md": "# Confirmed task" } };

    const result = rebuildPrompt(input);

    expect(result.stage).toBe("explore");
    expect(result.messages.some((message) => message.content === "previous-conversation")).toBe(false);
    expect(result.messages[0]?.content).toContain("<task.md>\n# Confirmed task\n</task.md>");
    expect(result.tools.some((tool) => tool.name === "switch")).toBe(true);
    expect(result.tools.some((tool) => tool.name === "create_schedule")).toBe(false);
    expect(result.components.find((item) => item.id === "session-history")?.metadata?.omittedByStage).toBe(true);
  });

  test("reconstructs only the current Build stage trace from think_scope", () => {
    const current = turn("turn-current", 0, "Build it", [
      { think_scope: { mode: "build", stage: "clarify" }, think_result: { step_content: "Clarify history" } },
      { think_scope: { mode: "build", stage: "explore" }, think_result: { step_content: "Explore history" } },
      { think_scope: { mode: "build", stage: "generate" }, think_result: { step_content: "Generate history" } },
      { think_scope: { mode: "build", stage: "generate" } },
    ], { agentState: { think: { mode: "build", stage: "generate" } } });

    const result = rebuildPrompt(request([current], current.id, 3));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(result.stage).toBe("generate");
    expect(contents).toContain("Generate history");
    expect(contents).not.toContain("Clarify history");
    expect(contents).not.toContain("Explore history");
    expect(result.components.find((item) => item.id === "current-turn")?.metadata).toMatchObject({
      completedRounds: 1,
      availableRounds: 3,
      omittedByStage: 2,
      historyModel: "stage_scoped",
      retainedBoundaryRound: false,
      retainedSwitchRounds: 0,
    });
  });

  test("applies the Build switch history policy when a stage is re-entered", () => {
    const reason = "Rewrite the redundant implementation.";
    const handoff = "[stage handoff] `build/verify` → `build/generate`\nRewrite the redundant implementation.";
    const current = turn("turn-current", 0, "Return to Generate", [
      { think_scope: { mode: "build", stage: "generate" }, think_result: { step_content: "Earlier Generate history" } },
      { think_scope: { mode: "build", stage: "verify" }, think_result: { step_content: "Verify intermediate work" } },
      {
        think_scope: { mode: "build", stage: "verify" },
        think_result: {
          step_content: "Verify found redundant code",
          tool_calls: [{ call_id: "switch-call", tool: "switch", tool_arguments: [{ name: "stage", value: "generate" }, { name: "reason", value: reason }] }],
        },
        action_result: {
          results: [{ tool_id: "switch-call", tool_name: "switch", tool_arguments: { stage: "generate", reason }, success: true, tool_result: { stage: "generate", reason } }],
        },
        observation_result: handoff,
      },
      {
        think_scope: { mode: "build", stage: "generate" },
        think_result: {
          step_content: "Generate retry history",
          tool_calls: [{ call_id: "switch-to-verify", tool: "switch", tool_arguments: [{ name: "stage", value: "verify" }, { name: "reason", value: "Retry ready for verification." }] }],
        },
        action_result: {
          results: [{ tool_id: "switch-to-verify", tool_name: "switch", tool_arguments: { stage: "verify", reason: "Retry ready for verification." }, success: true, tool_result: { stage: "verify", reason: "Retry ready for verification." } }],
        },
        observation_result: "[stage handoff] `build/generate` → `build/verify`\nRetry ready for verification.",
      },
      { think_scope: { mode: "build", stage: "verify" } },
    ], { agentState: { think: { mode: "build", stage: "generate" } } });

    const result = rebuildPrompt(request([current], current.id, 3));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(result.stage).toBe("generate");
    expect(contents).toContain(handoff);
    expect(contents).toContain("Earlier Generate history");
    expect(contents).not.toContain("Verify intermediate work");
    expect(contents).toContain("Verify found redundant code");
    expect(result.messages.find((message) => message.toolCalls?.[0]?.id === "switch-call")?.toolCalls?.[0]).toMatchObject({
      name: "switch",
      arguments: { stage: "generate", reason },
    });
    const switchResult = result.messages.find((message) => message.toolCallId === "switch-call");
    expect(switchResult?.role).toBe("tool");
    expect(switchResult?.content).toContain(reason);
    expect(result.components.find((item) => item.id === "current-turn")?.metadata).toMatchObject({
      completedRounds: 2,
      availableRounds: 3,
      omittedByStage: 1,
      historyModel: "stage_scoped",
      retainedBoundaryRound: true,
      retainedSwitchRounds: 1,
    });

    const verifyResult = rebuildPrompt(request([current], current.id, 4));
    const verifyContents = verifyResult.messages.map((message) => message.content ?? "");
    expect(verifyResult.stage).toBe("verify");
    expect(verifyContents).toContain("Verify intermediate work");
    expect(verifyContents).toContain("Verify found redundant code");
    expect(verifyContents).toContain("Generate retry history");
    expect(verifyResult.components.find((item) => item.id === "current-turn")?.metadata).toMatchObject({
      completedRounds: 3,
      availableRounds: 4,
      omittedByStage: 1,
      historyModel: "stage_scoped",
      retainedSwitchRounds: 1,
    });
  });

  test("keeps Session history in every stage when the persisted scope opts in", () => {
    const previous = turn("turn-previous", 0, "Past Session request", []);
    const current = turn("turn-current", 1, "Build it", [
      {
        think_scope: { mode: "build", stage: "clarify", session_history: "all_stages" },
        think_result: { step_content: "Clarify confirmation history" },
        action_result: {
          results: [{ tool_id: "task-confirm", tool_name: "request_human_task_confirm", tool_arguments: {}, success: true, tool_result: { status: "confirmed" } }],
        },
      },
      { think_scope: { mode: "build", stage: "explore", session_history: "all_stages" }, think_result: { step_content: "Explore history" } },
      { think_scope: { mode: "build", stage: "explore", session_history: "all_stages" } },
    ], { agentState: { think: { mode: "build", stage: "explore" } } });

    const result = rebuildPrompt(request([previous, current], current.id, 2));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(contents).toContain("Past Session request");
    expect(contents).toContain("Explore history");
    expect(contents).not.toContain("Clarify confirmation history");
    expect(result.components.find((item) => item.id === "current-turn")?.metadata).toMatchObject({
      completedRounds: 1,
      availableRounds: 2,
      omittedByStage: 1,
      retainedBoundaryRound: false,
      retainedSwitchRounds: 0,
    });
    expect(result.components.find((item) => item.id === "session-history")?.metadata).toMatchObject({
      omittedByStage: false,
      historyModel: "all_stages",
    });
  });

  test("keeps Session history while isolating marked Workflow Validate from Execute", () => {
    const previous = turn("turn-previous", 0, "Past Workflow request", []);
    const current = turn("turn-workflow", 1, "Run it", [
      { think_scope: { mode: "run_workflow", stage: "execute", session_history: "all_stages" }, think_result: { step_content: "Older Execute history" } },
      { think_scope: { mode: "run_workflow", stage: "execute", session_history: "all_stages" }, think_result: { step_content: "Final Execute handoff" } },
      { think_scope: { mode: "run_workflow", stage: "validate", session_history: "all_stages" }, think_result: { step_content: "Validate history" } },
      { think_scope: { mode: "run_workflow", stage: "validate", session_history: "all_stages" } },
    ], { agentState: { think: { mode: "run_workflow", stage: "validate" } } });

    const result = rebuildPrompt(request([previous, current], current.id, 3));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(contents).toContain("Past Workflow request");
    expect(contents).toContain("Validate history");
    expect(contents).not.toContain("Final Execute handoff");
    expect(contents).not.toContain("Older Execute history");
    expect(result.components.find((item) => item.id === "session-history")?.metadata).toMatchObject({
      omittedByStage: false,
      historyModel: "all_stages",
    });
  });

  test("keeps the full Turn trace for legacy Build records without think_scope", () => {
    const current = turn("turn-legacy-build", 0, "Build it", [
      { build_stage: "clarify", think_result: { step_content: "Legacy Clarify history" } },
      { build_stage: "explore", think_result: { step_content: "Legacy Explore history" } },
      { build_stage: "explore" },
    ], { agentState: { think: { mode: "build", stage: "explore" } } });

    const result = rebuildPrompt(request([current], current.id, 2));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(result.stage).toBe("explore");
    expect(contents).toContain("Legacy Clarify history");
    expect(contents).toContain("Legacy Explore history");
    expect(result.components.find((item) => item.id === "current-turn")?.metadata).toMatchObject({
      completedRounds: 2,
      availableRounds: 2,
      omittedByStage: 0,
      historyModel: "legacy_full_turn",
    });
  });

  test("uses persisted Workflow scope and drops Execute history in Validate", () => {
    const previous = turn("turn-previous", 0, "previous-conversation", []);
    const current = turn("turn-workflow", 1, "Run it", [
      { think_scope: { mode: "run_workflow", stage: "execute" }, think_result: { step_content: "Execute history" } },
      { think_scope: { mode: "run_workflow", stage: "validate" }, think_result: { step_content: "Validate history" } },
      { think_scope: { mode: "run_workflow", stage: "validate" } },
    ], { agentState: { think: { mode: "run_workflow", stage: "validate" } } });

    const result = rebuildPrompt(request([previous, current], current.id, 2));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(result.stage).toBe("workflow_validate");
    expect(contents).toContain("Validate history");
    expect(contents).not.toContain("Execute history");
    expect(contents).not.toContain("previous-conversation");
    expect(result.fidelity.limitations.some((item) => item.includes("Workflow stage is inferred"))).toBe(false);
  });

  test("does not let a null Build marker hide the persisted Workflow mode", () => {
    const previous = turn("turn-previous", 0, "Legacy Session history", []);
    const current = turn("turn-workflow", 1, "Run it", [
      { build_stage: null, think_result: { step_content: "Legacy Execute history" } },
      { build_stage: null },
    ], {
      agentState: { think: { mode: "run_workflow", stage: "validate" } },
    });

    const result = rebuildPrompt(request([previous, current], current.id, 1));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(result.stage).toBe("workflow_validate");
    expect(contents).toContain("Legacy Session history");
    expect(contents).toContain("Legacy Execute history");
    expect(result.components.find((item) => item.id === "current-turn")?.metadata?.historyModel).toBe("legacy_full_turn");
    expect(result.fidelity.limitations.some((item) => item.includes("Workflow stage is inferred"))).toBe(true);
  });

  test("derives advanced-tool visibility from loader actions before the target round", () => {
    const current = turn("turn-current", 0, "Browse", [
      {
        action_result: {
          results: [{
            tool_id: "loader",
            tool_name: "load_browser_tools",
            tool_arguments: {},
            success: true,
            tool_result: "loaded",
          }],
        },
      },
      {},
    ], { browserToolLoaded: true });

    const beforeLoad = rebuildPrompt(request([current], current.id, 0));
    const afterLoad = rebuildPrompt(request([current], current.id, 1));

    expect(beforeLoad.tools.some((tool) => tool.name === "browser_screenshot")).toBe(false);
    expect(afterLoad.tools.some((tool) => tool.name === "browser_screenshot")).toBe(true);
  });

  test("marks non-persisted Invocation metadata as explicit fidelity limitations", () => {
    const current = turn("turn-current", 0, "Hello", [{}]);
    const input = request([current], current.id, 0);
    delete input.uiLanguage;
    delete input.promptTime;
    delete input.workspace;
    delete input.context;

    const result = rebuildPrompt(input);

    expect(result.fidelity.level).toBe("partial");
    expect(result.fidelity.score).toBeLessThan(100);
    expect(result.fidelity.limitations.some((item) => item.includes("prompt_time"))).toBe(true);
    expect(result.fidelity.limitations.some((item) => item.includes("UI language"))).toBe(true);
    expect(result.fidelity.limitations.some((item) => item.includes("Browser tabs"))).toBe(true);
    expect(result.messages[0]?.content).toContain("<Workspace>");
  });
});
