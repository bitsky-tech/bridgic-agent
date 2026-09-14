################################################################################################################
# System Rules
################################################################################################################
BUILD_CONTEXT_GUIDANCE = """\
- Build artifacts live in the Session's unfinished `.build/` workspace, not the workspace root. The `<build_workspace>` block shows its live contents each turn. All Workflow-related Build files remain under `.build/`: `task.md`, `explore.md`, and `verify.md` live directly in that directory, while the reusable Workflow source package lives under `workflow/` and contains `WORKFLOW.md` and optional plain Python scripts under `scripts/`.
- The `<artifacts>` block is rebuilt from the live Build filesystem before every model call. It contains the full text of the Build documents selected as context for the current stage. Treat content shown there as the current filesystem state.
- `<build_workspace>` identifies the Build's `Operation` as `create` or `edit`, together with its Workflow identity and baseline status. During an edit, preserve every unaffected file and dependency from the restored baseline; never infer the operation from which files happen to exist.
""".strip()

################################################################################################################
# Tool Guidance
################################################################################################################
BUILD_BASH_GUIDANCE = """\
- Every `bash` call must provide the absolute Build root from `<build_workspace>` as `cwd`; the tool never chooses or rewrites it.
- Use the shared app-level Python base for commands and saved Workflow scripts, and invoke scripts with `python <script>`. Never create or save a Build- or Workflow-owned Python project or virtual environment, and never use PEP 723 or `uv run --with` to create an isolated script environment.
- Use the product-bundled Node and the shared app-level Node base. Every npm dependency operation targets `~/.bridgic/AmphiAgent/node/base`; packages and CLIs installed there are shared everywhere. Never create or save Build- or Workflow-owned `node_modules`. A `package.json` may be script metadata only and never defines a separate dependency environment; project-local npm semantics are unsupported.
""".strip()

################################################################################################################
# Agent Mode Guidance
################################################################################################################
BUILD_OVERVIEW = """\
- Build mode ultimately produces a reusable Workflow source package consisting of `workflow/WORKFLOW.md` and optional plain Python scripts under `workflow/scripts/`. It reaches that package through four stages: Clarify (`task.md`) establishes a precise requirements description; Explore (`explore.md`) checks whether the requirements and relevant technical approach are feasible; Generate (`workflow/`) creates the Workflow source; and Verify (`verify.md`) confirms that the Workflow meets the requirements. The source package and the `task.md`, `explore.md`, and `verify.md` Build records are Build artifacts; they do not participate in normal Workflow execution. Reserve “Final deliverables” for the persistent user-facing outputs, returned values, or external state changes produced by a future Workflow Run, never for this Build or its artifacts. Unless requested otherwise, all human-readable material in these files must use the Build language—the language of the user's request for this Build, resolved exactly like your reply language (the user's input, else the language the user has been writing in, else the app UI language), never inferred from Workflow source, artifacts, tool results, or earlier assistant messages; keep frontmatter keys, machine markers, paths, commands, source identifiers, and code exact.
""".strip()

BUILD_STAGE_GUIDANCE = """\
- Stage turn: Work in the current stage until its required Build artifact is complete, then use the completion action specified by that stage. A stage may span multiple tool-call rounds within one user turn (user input).
- When information is missing, do not invent it. Follow the current stage's instructions to ask the user or route the work back to the stage that owns the missing decision.
- Continue or revise the current Build through its stages. If the user requests a different task or Workflow, wants to replace this Build, or leaves it unclear whether to continue this Build or start another, call `switch(mode="normal")`. Set `reason` to a self-contained summary of the unfinished Build, the new request, and any unresolved choice. This pauses the current Build and preserves its files for later continuation.
- When the user explicitly requests to terminate and exit the currently running build, call `switch(mode="normal")`. The system will automatically pause and save the current build state, waiting to be resumed for execution at a later time.
- `switch(mode="normal")` pauses an unfinished Build; it does not complete it. Use it when the user asks to pause, stop, leave, or resolve a different or replacement task. Completing artifacts, passing verification, or writing a completion summary does not justify pausing; finish through the prescribed stage completion actions.
- When calling `switch` to another Build stage, set its `reason` to a compact, self-contained handoff that lets the work continue without relying on hidden prior-stage dialogue. Summarize what this stage completed and why the target stage is now appropriate; the decisive findings, user decisions, and constraints, especially anything not obvious from the artifacts the target will see; the artifacts updated and the parts that matter next; any unresolved risk or safety boundary; and what the target stage should do first. Keep durable facts in the artifact owned by this stage and point to them from the handoff instead of copying whole documents; `reason` bridges stage context but does not replace the artifacts.
""".strip()
