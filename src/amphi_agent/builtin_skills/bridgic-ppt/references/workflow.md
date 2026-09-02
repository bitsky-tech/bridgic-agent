# Presentation workflow

## Define the communication job

A deck is successful when the intended audience reaches the intended conclusion. Before authoring, identify:

- who will see it and what they already know;
- whether it is presented live, read asynchronously, or used as a leave-behind;
- the decision, belief, or action the deck should produce;
- the strongest evidence available and any claims that still need support;
- time, page-count, language, and brand constraints.

Do not stop for questions that can be safely inferred. Ask only when a missing choice would materially change the story or design.

## Build a page map

Represent each planned page with four fields:

| Field | Purpose |
|---|---|
| Role | Why this page exists in the argument |
| Takeaway | The single conclusion the audience should retain |
| Archetype | Cover, section, evidence, comparison, process, timeline, data, recommendation, or close |
| Inputs | Facts, data, quote, image, diagram, or decision needed |

The sequence of takeaway titles should read as a compressed version of the complete argument. Merge pages with duplicate roles. Split pages that contain two conclusions.

## Common narrative patterns

### Recommendation or decision deck

1. Decision and executive summary
2. Context and urgency
3. Evidence or diagnosis
4. Options and trade-offs
5. Recommendation
6. Implementation and risks
7. Decision required

### Product, sales, or fundraising deck

1. Promise
2. Customer problem
3. Insight and opportunity
4. Solution and experience
5. Evidence, market, or traction
6. Differentiation
7. Business or adoption model
8. Roadmap and ask

### Teaching or explanatory deck

1. Learning objective
2. Mental model
3. Components or principles
4. Worked examples
5. Failure modes
6. Practice or application
7. Summary

These are starting shapes, not mandatory templates. Choose the shortest structure that supports the requested outcome.

## Use three production passes

### Structure pass

- Open the live document and settle the page map.
- Apply the document-wide design.
- Read the initial blank page and insert its cover elements.
- Insert minimal skeleton pages serially so ids and order are stable.

A skeleton needs frontmatter, a stable page id, a meaningful name, the intended layout, and preferably the takeaway title. It does not need finished prose or assets.

### Parallel content pass

Group pages by dependencies. Research shared facts and prepare shared assets once. Pages whose inputs and conclusions are independent can be authored concurrently. After their skeletons have been read, edit or insert elements on different page ids concurrently.

Keep these operations serial:

- inserting pages whose relative order matters;
- moving or removing pages;
- editing the same ref;
- changing global design while page work depends on the old defaults;
- a page that requires the final result or id of another page.

### Coherence pass

Review the complete order after parallel work converges. Normalize terminology, numbers, title voice, visual density, repeated colors, and transitions. Repair only affected pages.

## Existing-deck strategy

Preserve what already works. Read the overview first, then sample only enough pages to understand the established system. Use `edit_ppt_page` for one referenced element at a time, `insert_ppt_element` for new elements, and `remove_ppt_element` for deletion. A page-wide re-layout is a planned sequence of element edits, insertions, and removals rather than a full-page Markdown replacement. Use `update_ppt_design` only when the user requests a global change or inconsistency is itself the problem.
