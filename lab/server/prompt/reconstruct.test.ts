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
  return {
    id,
    sessionId: "session-1",
    sessionOrdinal: ordinal,
    userInput: { text },
    otaRecords,
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

  test("bounds Session history by whole Turns and the 100 OTA-record limit", () => {
    const old = turn("turn-old", 0, "old-should-be-omitted", Array.from({ length: 60 }, () => ({})));
    const recent = turn("turn-recent", 1, "recent-should-remain", Array.from({ length: 50 }, () => ({})));
    const current = turn("turn-current", 2, "current", [{}]);

    const result = rebuildPrompt(request([old, recent, current], current.id, 0));
    const contents = result.messages.map((message) => message.content ?? "");

    expect(contents).toContain("recent-should-remain");
    expect(contents).not.toContain("old-should-be-omitted");
    expect(result.components.find((item) => item.id === "session-history")?.metadata?.includedTurns).toBe(1);
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

  test("uses Build-stage context and intentionally omits Session history in Explore", () => {
    const previous = turn("turn-previous", 0, "previous-conversation", []);
    const current = turn("turn-current", 1, "Explore it", [{ build_stage: "explore" }], {
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

  test("does not let a null Build marker hide the persisted Workflow mode", () => {
    const current = turn("turn-workflow", 0, "Run it", [{ build_stage: null }], {
      agentState: { think: { mode: "run_workflow", stage: "validate" } },
    });

    const result = rebuildPrompt(request([current], current.id, 0));

    expect(result.stage).toBe("workflow_validate");
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
    delete input.promptTime;
    delete input.workspace;
    delete input.context;

    const result = rebuildPrompt(input);

    expect(result.fidelity.level).toBe("partial");
    expect(result.fidelity.score).toBeLessThan(100);
    expect(result.fidelity.limitations.some((item) => item.includes("prompt_time"))).toBe(true);
    expect(result.fidelity.limitations.some((item) => item.includes("Browser tabs"))).toBe(true);
    expect(result.messages[0]?.content).toContain("<Workspace>");
  });
});
