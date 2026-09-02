# Bridgic PowerPoint tool reference

## `view_ppt`

Use first for every PPT task. A name or relative path resolves inside the Session workspace; a missing suffix becomes `.pptx`. An existing file is imported and a missing file is created.

The result is the deck overview: identity, global design, page size, current page, ordered page summaries, and private document/order leases retained by the Session. It does not include every page's Markdown.

Calling it again for the active target refreshes the global overview and the private document lease without reopening the file.

## `update_ppt_design`

Use after `view_ppt` for document-wide design. It can set:

- `theme`: `light`, `paper`, `midnight`, or `lavender`;
- `background` and `accent_colors` to override a preset;
- `title_font_family` and `body_font_family`;
- `page_size`: `wide` or `standard`;
- `footer_text`, `show_date`, and `show_slide_number`;
- `transition_effect`, `transition_direction`, `transition_duration_ms`, and `transition_through_black`;
- `document_title`.

A preset supplies a coherent background, palette, and typography. Explicit arguments override the preset. The operation normalizes existing text, shapes, tables, charts, page backgrounds, footer, and transition while preserving content, geometry, images, media, and page order. Page-size changes proportionally rescale existing geometry.

If the user changes the deck after `view_ppt`, the write is rejected. Call `view_ppt` again, reconcile the new overview, and retry intentionally.

## `get_ppt_page`

Returns one live page as canonical Markdown plus lightweight asset paths. Every real editable `Ppt*` element carries a stable `ref`. Read an existing page before editing, inserting into, or removing from it. The private page version is remembered by the Session and never appears in tool arguments.

Independent page reads can run concurrently.

## `edit_ppt_page`

Atomically replaces exactly one real element from an already-read page. Pass the page id, the element's returned `ref`, and one complete canonical `Ppt*` replacement fragment. Copy the fragment from `get_ppt_page`, preserve its `ref` and unfamiliar attributes, and modify only the intended content or properties.

```json
{
  "page_id": "slide-opening",
  "ref": "title",
  "replacement": "<PptText ref=\"title\" x=\"80\" y=\"64\" width=\"960\" height=\"90\" fontSize=\"42\">The market has entered a new buying cycle</PptText>"
}
```

The tool cannot create or delete an element. A missing, stale, or mismatched ref leaves the page unchanged. Each call contains one flat replacement string instead of a nested edit list or complete page.

Calls for different pages may run concurrently after structure and global design are stable. Calls for different refs on one page may be emitted together; the Session serializes them in call order and refreshes the private snapshot after each success. Never issue concurrent edits to the same ref.

## `insert_ppt_element`

Inserts exactly one new `PptText`, `PptShape`, `PptImage`, `PptAudio`, `PptVideo`, `PptTable`, or `PptChart` fragment into an already-read page. Include its geometry, content, and style. Do not provide `id` or `ref`; the renderer assigns a stable ref and returns it. New elements are placed at the top of the layer stack.

## `remove_ppt_element`

Removes exactly one real element from an already-read page by ref. Do not simulate deletion with an empty edit replacement.

## `insert_ppt_page`

Inserts one semantic page, optionally after a stable page id. A new deck begins with one blank page; read it and insert its elements instead of inserting a duplicate first page.

Prepare multiple page bodies concurrently, but commit order-sensitive insertions serially. For a large new deck, insert skeletons first, read them, then edit or insert their elements in parallel.

## `remove_ppt_page`

Removes a page that was first read with `get_ppt_page`. A deck must retain at least one page. Keep removals serial with other structure changes.

## `move_ppt_page`

Moves a page before or after another stable page id. It uses the private order lease from `view_ppt`; refresh the overview if the order changed. Keep moves serial.

## `goto_ppt_page`

Changes the visible page without modifying content. Use it for review and discussion, not as a prerequisite for page writes.

## Concurrency matrix

| Operation | Parallel? | Constraint |
|---|---|---|
| Research and asset preparation | Yes | Avoid duplicate work on shared evidence |
| `get_ppt_page` for different pages | Yes | Read only pages actually needed |
| Element preparation for different pages | Yes | Use the settled page map and design |
| Element writes for different pages | Yes | Every target page must have been read; no page-structure mutation in flight |
| Different refs on one page | Emit together | The Session serializes commits in call order |
| Multiple writes to one ref | No | Wait for the first result and re-read when needed |
| Insert, remove, and move pages | Usually no | Serialize when order matters |
| `update_ppt_design` with page writes | No | Establish global defaults before parallel page work |
