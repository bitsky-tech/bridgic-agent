---
name: bridgic-ppt
description: Plan, create, restyle, inspect, and edit presentations through Bridgic's live PowerPoint editor. Use for PowerPoint or PPTX work that should remain visible and editable in the app.
---

# Build PowerPoint presentations in Bridgic

Use the live PowerPoint tools as the only authoring surface. Do not create a separate Markdown deck, use pptxgenjs or OOXML, operate the editor through browser or DOM tools, or generate coordinate-level object trees unless a page genuinely needs a supported `Ppt*` component.

## Choose the workflow

- **New deck:** follow all seven steps below.
- **Edit a few pages:** open, inspect the target pages, update them, and run focused checks.
- **Restyle a deck:** open, update the global design, then inspect representative dense, visual, and data-heavy pages.
- **Restructure a deck:** open, plan the new page map, make structural changes serially, then update independent pages in parallel.
- **Review or repair:** open, identify concrete failures, read only affected pages, and fix the smallest useful scope.

## Standard production method

### 1. Establish the assignment

Identify the audience, presentation setting, desired decision or action, language, approximate length, brand constraints, and required evidence. Infer ordinary missing details when the request already makes the intent clear.

### 2. Open and inspect the live document

Call `view_ppt` before research or extended planning. It creates or opens the Session-owned `.pptx`, shows the PowerPoint surface immediately, and returns document design, page size, current position, ordered page ids, and short page summaries. It deliberately does not return every page's Markdown.

For an existing deck, decide whether the task is a local edit, a structural rewrite, a global restyle, or a full rebuild. Call `get_ppt_page` only for pages whose exact content or assets are needed.

### 3. Plan the story and page map

Create an internal page map before detailed authoring. For every page define its role in the argument, one core takeaway, an appropriate slide archetype, and the evidence or asset it requires. Titles should usually state the conclusion, not merely name the topic.

Read [references/workflow.md](references/workflow.md) for narrative patterns, page-map guidance, and the production passes used for new and existing decks.

### 4. Establish the design system

Use `update_ppt_design` for document-wide theme, background, accent palette, title/body typography, page size, footer, numbering, and shared transition. Do this before detailed page production when creating or fully restyling a deck so later Markdown inherits the same design.

Read [references/design-system.md](references/design-system.md) when choosing or changing the visual system.

### 5. Build in passes and parallelize independent pages

Do not default to completing page 1, then page 2, then page 3.

For a new deck:

1. Read the initial blank page and insert the cover elements into it.
2. Insert compact page skeletons serially to establish stable page ids and final order.
3. Read the skeleton pages that will be edited.
4. Prepare research, assets, and element fragments for independent pages concurrently.
5. Call `edit_ppt_page` concurrently for different, already-read page ids when the pages do not depend on one another.
6. Keep structural calls such as insert, remove, and move serial when order matters.

For an existing deck, use `edit_ppt_page` to replace exactly one existing ref, `insert_ppt_element` to add one element, and `remove_ppt_element` to delete one. Do not regenerate unchanged page Markdown. Independent page reads and writes may run concurrently after the page map is settled. Multiple calls for different refs on the same page may be emitted together; the Session commits them serially in call order. Never edit the same ref concurrently or combine a structural page mutation with writes whose target order depends on it.

Every element write targets one page and one semantic element. Tool arguments stay flat: a ref plus one replacement fragment, or one new element fragment. The renderer validates each element atomically and presents successful Agent changes progressively in the visible canvas. Never send an entire deck in one tool argument or encode multiple element edits inside one argument.

Read [references/tool-reference.md](references/tool-reference.md) before a multi-page or concurrent operation. Read [references/page-authoring.md](references/page-authoring.md) for semantic Markdown, supported components, assets, and stable ids.

### 6. Verify each result

Watch the live page after every write. Compilation diagnostics leave the previous page unchanged. Correct only the affected page. On a version conflict, read that page or the deck overview again and reconcile the user's current content rather than retrying a stale write.

Use `goto_ppt_page` when a particular page should remain visible while discussing or reviewing it.

### 7. Review the complete deck and deliver

Check the title sequence as a coherent argument, page density, hierarchy, alignment, contrast, typography, repeated layouts, chart consistency, asset quality, page order, and final call to action. Read [references/quality-check.md](references/quality-check.md) for the final review.

The live document is saved to the target selected by `view_ppt` after every successful mutation. There is no separate export step.

## Non-negotiable state rules

- Read an existing page before editing, inserting into, or removing from it. The Session supplies a private version token; never invent or pass one.
- Treat returned refs like browser accessibility refs: use them only for real existing elements and preserve them when editing.
- Make one element change per tool call. Use `insert_ppt_element` and `remove_ppt_element` instead of simulating creation or deletion through replacement text.
- Call `view_ppt` before `update_ppt_design`. A document-wide write is rejected if the live deck changed after the overview was read.
- Preserve returned `ref` values and unfamiliar supported fields when editing canonical element Markdown. Do not provide `id` or `ref` when inserting a new element.
- Use Session-workspace-relative asset paths. Never embed absolute paths, remote URLs, or Base64 payloads in page Markdown.
- Keep structural commits serial when page order is part of their meaning.
