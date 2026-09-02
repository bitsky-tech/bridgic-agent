# Semantic page authoring

## Canonical page shape

A new page body passed to `insert_ppt_page` begins with YAML frontmatter:

```markdown
---
id: market-shift
name: Market shift
layout: two-cols
background: "#F7F4ED"
---

# Three forces are compressing the buying cycle

::left::

- Faster product cycles
- Lower switching costs

::right::

![A concise alt description](assets/market-shift.png)

<!-- notes
Connect these forces to the recommendation on the next page.
-->
```

Use `blank`, `title`, `titleContent`, or `twoContent`; accepted aliases include `cover`, `title-content`, and `two-cols`.

## Prefer semantic Markdown

Use headings, paragraphs, lists, block quotes, images, and Markdown tables for ordinary pages. The compiler chooses editable native elements and positions them in the selected layout. Keep page content concise enough to fit.

Use `::left::`, `::right::`, and `::default::` to direct subsequent blocks into layout regions. Use `{#stable-id}` after supported Markdown text blocks when a stable element id is useful.

## Use native components only when needed

Supported components include `PptText`, `PptShape`, `PptImage`, `PptAudio`, `PptVideo`, `PptTable`, and `PptChart`. Use them for explicit geometry, editable charts, media controls, grouping, animation, hyperlinks, or formatting that semantic Markdown cannot express.

Do not replace a readable semantic page with a long coordinate-level object tree merely to control minor spacing. Preserve native components, their returned `ref`, and unfamiliar supported attributes returned by `get_ppt_page`.

## Assets

Reference images, audio, and video with Session-workspace-relative paths such as `assets/chart.png`. The tool registers the files before compilation. Absolute paths, remote URLs, file URLs, and inline Base64 are rejected.

When editing a page returned by `get_ppt_page`, preserve `@existing/<element-ref>` media references unless intentionally replacing that asset.

## Stable page ids, element refs, and parallel work

Give skeleton pages meaningful stable frontmatter `id` values derived from their role, not their temporary numeric position. Preserve those page ids through later updates. `get_ppt_page` renders every real editable element as a canonical `Ppt*` fragment with a stable `ref`, such as:

```markdown
<PptText ref="title" x="80" y="64" width="960" height="90" fontSize="42">
The market has entered a new buying cycle
</PptText>
```

Treat refs like browser accessibility refs: use a returned ref to identify an existing element, never invent one, and preserve it in an edit replacement. Refs remain stable after unrelated element edits. `insert_ppt_element` assigns the ref for a new element, so insertion fragments must omit both `id` and `ref`.

## Edit existing elements precisely

After `get_ppt_page`, copy the complete canonical fragment for the one element that should change. Call `edit_ppt_page` with its `page_id`, `ref`, and modified fragment. Preserve the ref, geometry, style, media source, and unfamiliar attributes unless the task intentionally changes them. Do not send the surrounding page or encode several edits in one replacement.

Use one tool call per element. Multiple calls for different refs may be emitted together; same-page calls are committed serially and different pages remain independent. Use `insert_ppt_element` for a new element and `remove_ppt_element` for deletion. For a major re-layout, plan the desired element set, then edit retained refs, insert new elements, and remove obsolete refs.

## Notes and comments

Put speaker notes for a newly inserted page in the trailing `<!-- notes ... -->` block. Notes should add delivery context rather than repeat visible text. Element tools do not edit page frontmatter, comments, or notes; preserve those page-level fields unless the task explicitly requires a currently unsupported change.
