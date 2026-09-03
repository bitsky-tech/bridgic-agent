import type {
  PromptStage,
  PromptToolSchemaSnapshot,
  PromptToolSummary,
  PromptTurnSnapshot,
} from "./types";

const BROWSER_BASIC = new Set([
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_input",
  "browser_back",
  "browser_scroll",
  "browser_key",
  "browser_close",
  "load_browser_tools",
]);

const BROWSER_ADVANCED_NAMES = [
  "browser_search",
  "browser_page_info",
  "browser_reload",
  "browser_forward",
  "browser_fill_form",
  "browser_scroll_to_ref",
  "browser_select",
  "browser_get_dropdown_options",
  "browser_check",
  "browser_uncheck",
  "browser_focus",
  "browser_hover",
  "browser_double_click",
  "browser_upload_file",
  "browser_drag",
  "browser_tabs",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_evaluate_javascript",
  "browser_evaluate_javascript_on_ref",
  "browser_type_text",
  "browser_key_down",
  "browser_key_up",
  "browser_mouse_click",
  "browser_mouse_move",
  "browser_mouse_drag",
  "browser_mouse_down",
  "browser_mouse_up",
  "browser_wait",
  "browser_screenshot",
  "browser_save_pdf",
  "browser_start_network_capture",
  "browser_get_network_requests",
  "browser_stop_network_capture",
  "browser_wait_for_network_idle",
  "browser_setup_dialog_handler",
  "browser_handle_dialog",
  "browser_remove_dialog_handler",
  "browser_get_cookies",
  "browser_set_cookie",
  "browser_clear_cookies",
  "browser_save_storage_state",
  "browser_restore_storage_state",
  "browser_verify_text",
  "browser_verify_role_visible",
  "browser_verify_url",
  "browser_verify_title",
  "browser_verify_state",
  "browser_verify_value",
  "browser_start_console_capture",
  "browser_get_console_messages",
  "browser_stop_console_capture",
  "browser_start_tracing",
  "browser_add_trace_chunk",
  "browser_stop_tracing",
  "browser_start_video",
  "browser_stop_video",
  "browser_resize",
  "browser_scroll_to_text",
  "browser_verify_visible",
] as const;

const BROWSER_ADVANCED = new Set<string>(BROWSER_ADVANCED_NAMES);
const WORKSPACE_ADVANCED = new Set(["workspace_checkpoint"]);
const SKILLS_ADVANCED = new Set([
  "import_skills",
  "list_skills",
  "set_skill_enabled",
  "uninstall_skill",
]);

const TOOL_ORDER = [
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "help",
  "web_search",
  "web_fetch",
  ...BROWSER_BASIC,
  ...BROWSER_ADVANCED_NAMES,
  "workspace_status",
  "workspace_diff",
  "workspace_history",
  "workspace_restore_file",
  "workspace_restore",
  "load_workspace_tools",
  "workspace_checkpoint",
  "view_skill",
  "manage_skills",
  "import_skills",
  "list_skills",
  "set_skill_enabled",
  "uninstall_skill",
  "request_build",
  "request_run_workflow",
  "request_human_choice",
  "request_human_task_confirm",
  "request_human_workflow_confirm",
  "create_schedule",
  "delete_schedule",
  "edit_workflow",
  "get_schedule",
  "list_schedules",
  "remove_workflow",
  "update_schedule",
  "report_workflow_step",
  "list_workflow_runs",
  "read_workflow_run",
  "run_subagent",
  "start_subagent",
] as const;

type SchemaSeed = {
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  description?: string;
};

const SCHEMAS: Record<string, SchemaSeed> = {
  bash: {
    required: ["command", "cwd"],
    properties: { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "integer" } },
    description: "Run a command in the platform shell with an explicit working directory.",
  },
  read_file: {
    required: ["file_path"],
    properties: { file_path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
  },
  write_file: {
    required: ["file_path", "content"],
    properties: { file_path: { type: "string" }, content: { type: "string" } },
  },
  edit_file: {
    required: ["file_path", "old_string", "new_string"],
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
  },
  glob: { required: ["pattern"], properties: { pattern: { type: "string" }, path: { type: "string" } } },
  grep: {
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      output_mode: { type: "string" },
      case_insensitive: { type: "boolean" },
      head_limit: { type: "integer" },
    },
  },
  web_search: {
    required: ["query"],
    properties: { query: { type: "string" }, search_engine: { type: "string" }, num_results: { type: "integer" } },
  },
  web_fetch: {
    required: ["url", "prompt"],
    properties: { url: { type: "string", format: "uri" }, prompt: { type: "string" } },
  },
  request_build: {
    required: ["goal"],
    properties: { goal: { type: "string" }, mode: { type: "string" }, reason: { type: "string" } },
  },
  request_run_workflow: {
    required: ["workflow_id"],
    properties: { workflow_id: { type: "string" }, action: { type: "string" }, reason: { type: "string" } },
  },
  request_human_choice: {
    required: ["prompt", "questions"],
    properties: { prompt: { type: "string" }, questions: { type: "string" } },
  },
  create_schedule: {
    required: ["name", "desc", "cron"],
    properties: { name: { type: "string" }, desc: { type: "string" }, cron: { type: "string" }, refs: { type: "array" } },
  },
  update_schedule: {
    required: ["schedule_id"],
    properties: {
      schedule_id: { type: "string" },
      name: { type: "string" },
      desc: { type: "string" },
      cron: { type: "string" },
      enabled: { type: "boolean" },
    },
  },
  delete_schedule: { required: ["schedule_id"], properties: { schedule_id: { type: "string" } } },
  get_schedule: { required: ["schedule_id"], properties: { schedule_id: { type: "string" } } },
  edit_workflow: { required: ["workflow_id"], properties: { workflow_id: { type: "string" } } },
  remove_workflow: { required: ["workflow_id"], properties: { workflow_id: { type: "string" } } },
  report_workflow_step: {
    required: ["status", "summary"],
    properties: { status: { type: "string" }, summary: { type: "string" }, evidence: { type: "array" } },
  },
  read_workflow_run: {
    required: ["run_id"],
    properties: { run_id: { type: "string" }, path: { type: "string" } },
  },
  run_subagent: { required: ["goal"], properties: { goal: { type: "string" } } },
  start_subagent: { required: ["goal"], properties: { goal: { type: "string" } } },
  view_skill: {
    required: ["skill_dir"],
    properties: { skill_dir: { type: "string" }, file_path: { type: "string" } },
  },
  switch: {
    properties: { mode: { type: "string" }, stage: { type: "string" }, reason: { type: "string" } },
  },
};

function groupFor(name: string): string {
  if (name.startsWith("browser_") || name === "load_browser_tools") return "browser";
  if (name.startsWith("workspace_") || name === "load_workspace_tools") return "workspace";
  if (name.includes("skill")) return "skills";
  if (name.includes("schedule")) return "schedules";
  if (name.includes("workflow")) return "workflows";
  if (name.includes("subagent")) return "subagents";
  if (["read_file", "write_file", "edit_file", "glob", "grep"].includes(name)) return "filesystem";
  if (["web_search", "web_fetch"].includes(name)) return "web";
  if (name.startsWith("request_human")) return "interaction";
  return "core";
}

function isAdvanced(name: string): boolean {
  return BROWSER_ADVANCED.has(name) || WORKSPACE_ADVANCED.has(name) || SKILLS_ADVANCED.has(name);
}

export const DEFAULT_TOOL_CATALOG: PromptToolSchemaSnapshot[] = [
  ...TOOL_ORDER.map((name) => {
    const seed = SCHEMAS[name] ?? {};
    return {
      name,
      group: groupFor(name),
      advanced: isAdvanced(name),
      description: seed.description ?? `Bridgic Agent ${name} tool.`,
      parameters: {
        type: "object",
        properties: seed.properties ?? {},
        required: seed.required ?? [],
      },
    };
  }),
  {
    name: "switch",
    group: "control",
    description: "Switch the active cognitive mode or stage.",
    parameters: { type: "object", properties: SCHEMAS.switch?.properties ?? {}, required: [] },
  },
];

const MAIN_EXCLUDED = new Set([
  "report_workflow_step",
  "request_human_task_confirm",
  "request_human_workflow_confirm",
  "switch",
]);

const BUILD_EXCLUDED = new Set([
  ...MAIN_EXCLUDED,
  "edit_workflow",
  "help",
  "request_run_workflow",
  "remove_workflow",
  "start_subagent",
  "create_schedule",
  "delete_schedule",
  "get_schedule",
  "list_schedules",
  "update_schedule",
]);

const CHILD_ALLOWED = new Set([
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "workspace_status",
  "workspace_diff",
  "workspace_history",
  "load_workspace_tools",
  "view_skill",
  "manage_skills",
  "list_workflow_runs",
  "read_workflow_run",
  "request_human_choice",
  ...BROWSER_BASIC,
  ...BROWSER_ADVANCED_NAMES,
  ...WORKSPACE_ADVANCED,
  ...SKILLS_ADVANCED,
]);

function actionSteps(record: Record<string, unknown>): Record<string, unknown>[] {
  const action = record.action_result;
  if (!action || typeof action !== "object") return [];
  const results = (action as Record<string, unknown>).results;
  return Array.isArray(results) ? results.filter((step): step is Record<string, unknown> => !!step && typeof step === "object") : [];
}

export interface ToolSurfaceResult {
  tools: PromptToolSummary[];
  limitations: string[];
}

export function selectToolSurface(
  stage: PromptStage,
  turn: PromptTurnSnapshot,
  roundsBeforeTarget: Record<string, unknown>[],
  catalogSnapshot?: PromptToolSchemaSnapshot[],
): ToolSurfaceResult {
  const catalog = catalogSnapshot?.length ? catalogSnapshot : DEFAULT_TOOL_CATALOG;
  const limitations: string[] = [];
  const priorNames = new Set(
    roundsBeforeTarget.flatMap((record) =>
      actionSteps(record)
        .filter((step) => step.success !== false)
        .map((step) => String(step.tool_name ?? "")),
    ),
  );

  const allNames = new Set(
    turn.otaRecords.flatMap((record) => actionSteps(record).map((step) => String(step.tool_name ?? ""))),
  );
  const resolveLoaded = (loader: string, persisted: boolean | undefined): boolean => {
    if (priorNames.has(loader)) return true;
    if (allNames.has(loader)) return false;
    if (persisted) {
      limitations.push(`The initial ${loader} state is inferred from the Turn-level persisted flag.`);
      return true;
    }
    return false;
  };

  const browserLoaded = resolveLoaded("load_browser_tools", turn.browserToolLoaded);
  const workspaceLoaded = resolveLoaded("load_workspace_tools", turn.workspaceToolsLoaded);
  const skillsLoaded = resolveLoaded("manage_skills", turn.skillsToolLoaded);

  const isAllowed = (name: string): boolean => {
    if (BROWSER_ADVANCED.has(name) && !browserLoaded) return false;
    if (WORKSPACE_ADVANCED.has(name) && !workspaceLoaded) return false;
    if (SKILLS_ADVANCED.has(name) && !skillsLoaded) return false;
    if (stage === "child") return CHILD_ALLOWED.has(name);
    if (stage === "workflow_execute") {
      return !MAIN_EXCLUDED.has(name) && !["edit_workflow", "help", "request_build"].includes(name)
        || name === "report_workflow_step"
        || name === "switch";
    }
    if (["clarify", "explore", "generate", "verify"].includes(stage)) {
      if (name === "switch") return true;
      if (name === "request_human_task_confirm") return stage === "clarify";
      if (name === "request_human_workflow_confirm") return stage === "verify";
      return !BUILD_EXCLUDED.has(name);
    }
    return !MAIN_EXCLUDED.has(name);
  };

  const tools = catalog.filter((tool) => isAllowed(tool.name)).map((tool) => {
    const parameters = tool.parameters ?? { type: "object", properties: {}, required: [] };
    const properties = parameters.properties && typeof parameters.properties === "object"
      ? Object.keys(parameters.properties as Record<string, unknown>)
      : [];
    const required = Array.isArray(parameters.required)
      ? parameters.required.map(String)
      : [];
    return {
      name: tool.name,
      description: tool.description ?? "",
      group: tool.group ?? groupFor(tool.name),
      advanced: tool.advanced ?? isAdvanced(tool.name),
      required,
      properties,
      parameters,
      schemaFidelity: catalogSnapshot?.length ? "snapshot" as const : "lab_catalog" as const,
    };
  });
  return { tools, limitations };
}

export function browserAdvancedToolNames(): ReadonlySet<string> {
  return BROWSER_ADVANCED;
}
