---
name: bridgic-ppt
description: Create, open, inspect, edit, and save presentations through Bridgic's live PowerPoint editor. Use for PowerPoint or PPTX work that should remain visible and editable in the app.
---

# Work with Bridgic PowerPoint

Use the live PowerPoint tools as the only authoring surface. Do not create a separate Markdown deck file, use pptxgenjs or OOXML, operate the editor through browser or DOM tools, or generate coordinate-level `PptShape` and `PptText` trees.

## Start the live document

Call `view_ppt` before research or extended planning. A name creates or opens a `.pptx` in the Session workspace; a path targets that file. This establishes the Session-owned presentation and immediately exposes the PowerPoint surface and Agent activity to the user.

`view_ppt` returns the title, theme, size, current position, ordered page ids, and a short summary for every page. It deliberately does not return every page's Markdown. A new PPT starts with one blank page: read and update that page, then add the remaining pages with separate `insert_ppt_page` calls. Never send an entire deck in one tool argument.

## Author one page at a time

Write compact semantic Markdown for exactly one logical page. Prefer ordinary headings, paragraphs, lists, images, tables, speaker notes, and small theme or layout directives supported by the live compiler. Keep content concise enough to fit the slide. Do not wrap the page in a Markdown code fence.

Every page begins with a small YAML frontmatter block. Use `blank`, `title`, `titleContent`, or `twoContent` for layout (`cover`, `title-content`, and `two-cols` are accepted aliases). A typical inserted page is:

```markdown
---
name: Market shift
layout: two-cols
background: "#F7F4ED"
---

# Three forces reshape the market

::left::

- Faster product cycles
- Lower switching costs

::right::

![A concise alt description](assets/market-shift.png)

<!-- notes
Connect the three forces to the recommendation on the next page.
-->
```

Use Session-workspace-relative paths for images and media. Tables use ordinary Markdown table syntax. Preserve the `id` and any unfamiliar supported fields when editing Markdown returned by `get_ppt_page`.

Use `get_ppt_page` when a page's current source or asset paths are needed. Before updating or removing an existing page, read it first. The Session remembers a private version token and supplies it automatically; never invent or pass a revision. If the user changed the page after the read, the write is rejected without mutation and the Agent must read that page again.

Compilation is atomic. If a write returns diagnostics, the previous page remains unchanged; correct the reported problems and retry only that page. On a conflict, read only the affected page again and reconcile the user's current content.

Use `insert_ppt_page`, `remove_ppt_page`, and `move_ppt_page` for later structural changes rather than rebuilding the deck.

## Verify and deliver

Use `goto_ppt_page` to keep the page being discussed visible. Fix only the affected page. The live document is saved to the target selected by `view_ppt` after every successful edit, so there is no separate export step.
