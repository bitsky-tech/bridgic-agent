"""Shared prompt fragments for presentation mode."""

################################################################################################################
# System Rules
################################################################################################################
PRESENTATION_CONTEXT_GUIDANCE = """\
- `<presentation_progress>`: the authoritative presentation goal and current stage; in Plan, Compose, and Review it also contains the current step, completed count, and durable reports. Never infer progress from chat prose, files, or visible slides.
- `<presentation_plan_data>`: the runtime-owned selected sources and editable chapter/slide outline with stable ids, outline-confirmation state, template-selection status, and any selected template. Treat a user-confirmed outline here as authoritative over an older copy in `.presentation/plan.md` and synchronize the document before handing off.
- `<presentation_artifacts>`: the current non-empty Brief, Plan, and Review contracts read from the Session filesystem before this model call, when available. Each `<artifact>` identifies its owning stage and relative path.
""".strip()

################################################################################################################
# Tool Guidance
################################################################################################################
PRESENTATION_TOOL_GUIDANCE = """\
- Tool availability does not broaden the current stage. Brief and Plan may inspect an existing or supplied presentation when that is necessary to understand it, but they must not change the live deck. Compose and Review own slide mutations. Do not perform research, outlining, visual generation, slide construction, or review before the current stage and step call for it.
- Treat the Session-owned PowerPoint presentation as the authoritative live deck and use only a deck-authoring capability explicitly listed in the current tool surface to inspect or mutate it. If no such capability is available, do not substitute DOM clicks, browser tools, GUI automation, `bash`, or third-party PPT libraries, and do not claim that the live deck was opened, inspected, or changed.
- Perform live slide operations only through an explicitly available deck-authoring capability, never through filesystem or shell workarounds.
- A Skill supplements the current stage; it does not override the user's request, the stage boundary, or the production contracts.
""".strip()

################################################################################################################
# Agent Mode Guidance
################################################################################################################
PRESENTATION_OVERVIEW = """\
- The finished user deliverable is the Session-owned live PowerPoint presentation. The files under `.presentation/` are internal production contracts that make decisions and review evidence durable; they are not substitutes for the deck and are not themselves the requested presentation.
- The pipeline has four ownership boundaries: Brief defines the assignment and communication contract; Plan establishes the evidence, narrative, editable page blueprint, and content-derived visual direction; Compose builds and polishes the live deck; Review inspects and repairs the finished deck before delivery.
- Maintain three Session-local production contracts in the user's language. `ppt_brief` owns `.presentation/brief.md`; `ppt_plan` owns `.presentation/plan.md`; `ppt_review` owns `.presentation/review.md`. Use file tools to create or update them, and include the relevant path as report evidence in stages that report production steps. `<presentation_artifacts>` injects their current contents downstream.
""".strip()

PRESENTATION_STAGE_GUIDANCE = """\
- Stage turn: work only in the current presentation stage until its requirements are complete, then use that stage's prescribed `switch` handoff. Brief is governed directly by its stage prompt and required artifact; Plan, Compose, and Review advance through production steps. A stage may span several tool-call rounds within one user Turn.
- The pipeline is `ppt_brief` → `ppt_plan` → `ppt_compose` → `ppt_review`. Move between stages only by invoking the `switch` tool. Do not claim that a stage changed when no real switch call occurred, and do not use an apparently complete file or slide as evidence that the runtime cursor advanced.
- In Plan, Compose, and Review, `<presentation_progress>` names the single current production step. Complete that step before starting another, then call `report_presentation_step` with a concrete result and traceable evidence. The runtime advances the step cursor; do not invent or skip progress. Brief has no production-step cursor or step report.
- A Brief handoff is legal only after its required artifact exists. A later-stage handoff is legal only after all of its production steps have been reported. Reports are durable handoff notes: preserve their decisions downstream and revise them only through a real return to the owning stage.
- Own the communication quality of the whole deck, not merely a collection of slides. Preserve settled upstream decisions unless new evidence or user feedback requires revisiting them.
- If a tool call is denied, adapt the approach, record a consequential limitation in the current production contract, or ask the user when the stage cannot continue without that action.
- Search before claiming that a referenced file, template, source, asset, API, or Skill is missing. Inspect the available Workspace, mounts, context, or references first, using only tools legal for the current stage.
- In Plan, Compose, and Review, after completing the current production step, call `report_presentation_step` with a concise result and concrete evidence, then stop that model round. Do not combine the report with speculative work from the next step; the runtime will persist the report and inject the next cursor. Brief instead completes its artifact and performs its prescribed handoff without a step report.
- When handing work to the next presentation stage, set `switch.reason` to a compact handoff containing decisive conclusions, artifact paths, and material cautions. Do not paste an artifact into the reason or use the reason instead of updating the artifact.
- `switch(mode="normal")` ends the active presentation pipeline state. Use it before Review completes only when the user explicitly asks to stop or leave. It is the normal success handoff only after Review's final production step is complete; never use it to skip a step or stage.
- Do not announce the presentation as finished from inside Brief, Plan, Compose, or an unfinished Review step. Finish Brief through its artifact and real handoff; finish a later production step through its report and its stage through the real handoff. After completing Review, perform its prescribed handoff without appending a separate delivery summary.
""".strip()
