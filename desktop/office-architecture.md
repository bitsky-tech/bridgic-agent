# Office frontend architecture

## Scope and direction

PowerPoint, Word, and Excel should share their frontend platform infrastructure and
follow the same domain and driver contracts. Their document models and business
capabilities remain specific to presentations, documents, and spreadsheets.

This migration is frontend-only. It must not change the Python backend or add
Word/Excel Agent integrations. The existing PowerPoint Agent dispatch protocol,
Session ownership, target selection, and behavior are compatibility constraints.
Electron containers are part of the desktop frontend. Phases 1 through 5 are now
implemented, including shared persistence/recovery orchestration and the native
editor binding contract. This completes the scoped frontend architecture migration.

## Responsibility boundaries

| Layer | Shared responsibility | Editor-specific responsibility |
| --- | --- | --- |
| Application projection | Session-scoped summaries, rail presentation, visible panel selection | Adapt the facts each editor currently publishes |
| Desktop container | Target lifecycle, bounds, visibility, configuration, recovery coordination | Driver requirements for keeping an editor alive |
| Office shell | Application header, document tabs, common panel controls and accessibility | Labels, icons, supported actions and ribbon contents |
| Workspace runtime | Document identity, active document, subscriptions, operation coordination | Document payload and domain invariants |
| Domain | Common command/result and change-event contracts | Slides and animations; text and pagination; sheets and formulas |
| Persistence | Scheduling, flush/failure reporting and recovery orchestration | Snapshot codecs, source-file policies and format fidelity |
| Engine adapter | Consistent mount/dispose, snapshot and change interfaces | Fabric/React presentation rendering, Univer Docs, Univer Sheets |

The application projection is read-only. It must not become a second writable
document store. The common workspace runtime identifies one authority for each
document and receives versioned changes from the editor.

## Phase 1: shared renderer foundations

The first increment is intentionally bounded:

1. Introduce a common Office status projection and use it for the three rail
   entries. Adapt existing sources without inventing new runtime capabilities.
2. Reuse the Office header, document tabs, and panel controls in PowerPoint as well
   as Word and Excel, preserving existing callbacks and interaction behavior.
3. Share the renderer plumbing for native PowerPoint/Excel surface bounds,
   visibility, and host snapshots. Keep their current managers, IPC contracts,
   ownership rules, handoff guards, and editor-specific recovery paths.

Word remained in the main renderer during Phase 1. Domain stores, editing engines,
undo behavior, file import/export, saving policies, and Agent protocols do not
move. Removing duplicate code is appropriate only after callers use the shared
implementation; retaining a compatibility adapter is preferable to widening scope.

Implemented entry points:

- [Office status contract and adapters](apps/electron/src/renderer/lib/office/officeSurfaceStatus.ts)
  and [the Session-scoped projection](apps/electron/src/renderer/atoms/office.ts).
- [Shared rail interpretation](apps/electron/src/renderer/components/app/OfficeSurfaceRailButton.tsx)
  and [application/document chrome](apps/electron/src/renderer/components/app/OfficeWorkbenchChrome.tsx).
- [Native surface synchronization](apps/electron/src/renderer/hooks/useNativeOfficeSurface.ts)
  and [inventory subscription](apps/electron/src/renderer/hooks/useOfficeSurfaceSnapshot.ts).

### Status facts and compatibility

An Office summary is scoped to `(sessionId, appKind)`. These are independent facts:
runtime presence/readiness, document presence/count, dirty state, Agent activity,
and unseen-content attention. Current selection/visibility belongs to the UI.
Unknown or unavailable information is not equivalent to `false`, zero, or idle.

| Existing source | Facts available to the application renderer | Facts not supplied by that source |
| --- | --- | --- |
| PowerPoint host snapshot | Target identity, loading, crash state | Document count, dirty state |
| PowerPoint activity/attention atoms | Existing Agent activity and attention latch | Word/Excel Agent activity |
| Excel host snapshot | Target identity, ready, crash and dirty state | Document count, Agent activity, attention |
| Word host snapshot | Session target identity, loading, crash, expanded state, restored document count and workspace persistence status | Agent activity, attention, source-file save state |

PowerPoint and Excel currently use target presence for their background-open rail
state. Preserve that compatibility behavior without claiming it is an exact
document count. Word uses its reported count; an unreported count must remain
distinguishable from a reported zero. Its inventory remains pending until the
Session renderer restores its workspace; a loading target alone is not a document.

Keep existing visual priorities, animation timing, and accessible labels. Native
loading is not Agent execution. Existing PowerPoint attention must only be cleared
when the content is actually seen, including foreground, collapse, and native
handoff checks; selecting a hidden panel is insufficient. No blue/orange activity
should be fabricated for Word or Excel merely to populate a common interface.

## Phase 2: Session containers

[OfficeSessionContainer](apps/electron/src/main/office-session-container.ts) now
owns the common Session inventory, native view attachment, deduplicated creation,
CDP target discovery, bounds/visibility and destruction. Generation checks reject
late load/target results after a Session closes or a renderer is replaced.
[PowerPoint](apps/electron/src/main/embedded-powerpoint-manager.ts),
[Excel](apps/electron/src/main/excel-host.ts), and
[Word](apps/electron/src/main/word-host.ts) are adapters over that inventory.
PowerPoint retains its existing hidden-view behavior and Agent protocol; Excel
retains its offscreen parking strategy and workbook recovery/dirty policies.

Word opens an independent `word.html` renderer when its panel or a DOCX is first
opened. Each Session keeps its own target, domain store, document tabs and undo
state while hidden or while another Session is viewed. The main-window
[Word panel](apps/electron/src/renderer/components/app/WordWorkbenchPanel.tsx)
only supplies the native viewport and projects host state. It does not mount a
second Word store. All three editors use the shared native surface/snapshot hooks.

The [Word preload](apps/electron/src/preload/word-host.ts) exposes only Word
configuration, document reading, state reporting, panel controls and request
acknowledgements. [WordHostApp](apps/electron/src/renderer/word/WordHostApp.tsx)
owns `window.__bridgicWord` in the child renderer. Existing Python/Agent wiring is
unchanged; this does not add Word Agent tools.

DOCX imports retain their original Session, are ordered in the owning renderer,
and complete through sender-checked, one-use tickets. Configuration events do not
recreate the document store. The default storage partition and same-origin Word
page preserve the existing IndexedDB/localStorage workspace keys.

Hiding exits the expanded view and preserves the target. Closing a document acts
inside its workspace. Deleting a Session releases only its target. Closing the
window, quitting, and installing an update wait for Word's native snapshot to
reach durable workspace storage; failure or timeout leaves the application open.
This checkpoint does not overwrite the source DOCX. A renderer crash receives
one automatic recovery attempt, then exposes an explicit retry if it fails again.

## Phase 3: workspace and commands

[OfficeWorkspaceRuntime](apps/electron/src/renderer/lib/office/officeWorkspaceRuntime.ts)
provides a read-only document inventory, declared capabilities, ordered explicit
operations, structured failures, and Session/document revision guards. Its metadata
contains stable document identity, title, active document, content revision, and
known or unknown dirty state. Metadata is derived from the owning editor; it does
not contain another writable copy of slides, text, or workbook cells.

Operations retain their Session and explicit document identity while queued. An
unsupported capability, missing document, stale expected revision, or disposed
runtime returns a failure. After asynchronous preparation, adapters revalidate
before committing. A failed operation does not block later operations. Internal
driver callbacks apply through their owning operation rather than recursively
waiting on that same queue. Native typing, composition, dragging, and native undo
stay inside the editor and publish changes without per-keystroke IPC.

### Editor adapters and compatibility

- [PowerPoint's controller](apps/electron/src/renderer/lib/presentationWorkspaceRuntime.ts)
  reads and writes the Session's existing Jotai workspace. Document tabs and the
  existing Agent entry share operation ordering. Native commits remain synchronous;
  a prepared Agent result cannot replace a newer document revision. Protocol v5's
  request/response shapes, diagnostic results, and revision error codes remain
  unchanged. Closing the final tab still delegates to the native surface host.
- [Word's domain store](apps/electron/src/renderer/lib/wordDomain.ts) remains its
  document authority. UI and renderer API commands share its queue. Editor handlers
  bind to a document, and reference callbacks use a guarded internal reducer.
  Native snapshots are reconciled before queued domain commands, and a workspace
  flush waits for pending operations. The existing API gains a read-only workspace
  reader and optional Session/revision preconditions; its result envelope remains
  compatible.
- [Excel's workspace](apps/electron/src/renderer/lib/office/excelWorkspace.ts)
  owns the tab inventory formerly held directly in React state. The mounted Univer
  unit continues to own live content. `tabId` identifies a workspace document,
  including blank workbooks; a source-file handle or Univer unit ID is not that
  identity. New/open/activate/close/save and explicit editor actions share ordering.
  Editor and dialog operations retain their original tab and native handle. A save
  acknowledgement still leaves later native edits dirty.

Revisions in this layer describe the current renderer lifetime and are not source
file modification times or durable recovery revisions. Word and PowerPoint expose
unknown per-document dirty state (`null`); Excel supplies its existing dirty fact.
The native runtime inventory does not add new main-window IPC projections or new
Word/Excel Agent tools. Ribbon contents, document-specific commands, native undo,
import/export codecs, and existing persistence policies remain editor-specific.

### Phase 3 verification

The completed increment passed 613 tests across 68 relevant test files, executed
in separate processes to isolate module mocks, plus desktop typecheck, lint, and
the renderer production build. Independent reviews checked the shared runtime and
each editor's Session/driver boundary.

An isolated Electron run verified Word native typing followed by a domain append
and native formatting, Session/revision rejection, durable flush and reload, and
the existing external-link/zoom behavior. It also verified Excel blank-tab identity,
formula-bar submission through its form handler, native value publication, and
new-tab/switch-back recovery. This run did not validate Excel's Enter-key default
form submission or OS source-save dialogs. Save acknowledgement version protection
and failed operations were covered by targeted behavioral tests.

## Phase 4: persistence and recovery

[Office persistence](apps/electron/src/renderer/lib/office/officePersistence.ts)
shares scheduling, acknowledgements, retries and recovery outcomes while keeping
three operations distinct:

- Workspace recovery stores application state for restoring an editing session.
- Source-file saving writes changes to an explicitly associated local file.
- Export produces a file in a requested format and can involve format conversion.

Each channel declares its Session, editor, operation kind, storage and automatic
policy. It writes to one destination at a time. Recovery snapshots can coalesce
before writing; explicit source writes retain individual acknowledgements and
ordering. An explicit checkpoint sharing an in-flight key waits for the actual
write. A failed write rejects its receipt without blocking later accepted writes;
the newest failed snapshot remains retryable. Disposal stops new work and makes a
best-effort flush; callers requiring an acknowledged shutdown must await flush
before disposing. Successfully written document payloads are released.

| Adapter | Storage guarantee | Source-file behavior |
| --- | --- | --- |
| [Word](apps/electron/src/renderer/lib/wordPersistence.ts) | IndexedDB workspace recovery, with localStorage fallback; retains existing Session keys and codecs | Recovery does not overwrite the imported DOCX or add an export capability |
| [Excel](apps/electron/src/renderer/lib/office/excelPersistence.ts) | Recovery snapshots in the owning main-process Session; survives renderer reload, not application restart or Session release | Explicit save/save-as retains file authorization, modification-time conflicts, format-fidelity confirmation and later-edit dirty protection |
| [PowerPoint](apps/electron/src/renderer/lib/presentationPersistence.ts) | Source-file checkpoints for the document explicitly associated by `view_ppt`; no separate workspace recovery added | Existing PPTX encoding and write API; imported baselines are not re-encoded until changed, and new UI tabs do not inherit another document's destination |

Word and Excel distinguish an empty recovery store from a read or decoding failure.
An unsuccessful restore preserves the original record and presents a retry action
instead of writing a default blank workspace over it. Word records an adapter-only
checkpoint sequence alongside each snapshot to order saves, tab switches and closed
documents across its two stores. Legacy records are compared only when document
membership and timestamps establish an order. Otherwise the existing IndexedDB
primary is restored, and the alternative is retained in private checkpoint metadata
through future writes; it is not automatically opened as another document. The
original fallback is cleared only after its data or retained alternative is durable
in IndexedDB. A failed primary read never triggers a migration over unread data.
Its existing window/quit/update flush still waits for
domain operations, the native editor snapshot, and durable recovery storage.

Excel recovery success does not clear source-file dirty state. Its source-write
adapter returns distinct written, canceled, conflict and failed outcomes. No save
button or routine saved-status banner is added. Recovery errors provide retry;
ordinary source-save and dirty-close behavior is preserved.

PowerPoint keeps protocol v5's request/response shapes and error codes. Its UI and
protocol writes use the same source channel. Returning to a bound file selects its
existing document; source mutations on an unrelated unbound tab are rejected before
editing. Reopening a replaced target while it still has unwritten content flushes
that content and requests fresh source bytes through the existing `document_changed`
error. Panel close waits for queued operations and the latest source checkpoint,
including edits received during encoding; failure leaves the panel open. This does
not add an application-wide PowerPoint quit acknowledgement or recovery of unbound
tabs. Word/Excel Agent integration and backend protocols remain out of scope.

### Phase 4 verification

The increment passed 664 tests across 72 relevant files, each run with the project
test preload in its own process, plus desktop typecheck, lint, locale parity and
the renderer production build. Coverage includes in-flight acknowledgements,
recovery coalescing, failed writes and retry, source-target isolation, cancellation,
conflicts, later native edits, and failed restoration without overwriting data.

An isolated Electron run verified Word native edits, domain commands, durable
flush and reload, and Excel native value publication and tab switching. A separate
Excel run forced an actual renderer crash and a recovery-read failure: no blank
checkpoint was written, and retry restored both original tab IDs, their values,
the active tab and dirty state. A hidden PowerPoint renderer exercised the actual
v5 API and PPTX encoding: its mutation response waited for the file write, the
resulting slide XML contained the edited text, an unbound UI tab could not alter
the source, and `view_ppt` returned to the original document without losing the
other tab. OS save dialogs and application-restart recovery for Excel were not
claimed or added.

The Word upgrade compatibility repair additionally passed 130 tests across 19
Word/shared-persistence files. Its storage suite covers both legacy copy orders,
ambiguous legacy backups, closed/empty workspaces, checkpoint ordering after
reload, cleanup failure and read failure followed by retry. An isolated Electron
run seeded an old localStorage copy beside newer IndexedDB content, then verified
the newer text survived restoration, further editing, durable flush and reload.

## Phase 5: editor bindings

[Office editor binding](apps/electron/src/renderer/lib/office/officeEditorBinding.ts)
defines the native engine boundary independently of the workspace operation queue
and persistence scheduler. A binding owns one mounted engine within one Session;
its active-document lease can change without recreating a reusable canvas. Switching
away and back still invalidates earlier leases. Late mount completion releases its
resources, and disposal invalidates callbacks before native teardown starts.

The shared contract covers readiness, identity, snapshot reads, synchronous change
publication, native flush and disposal. It never caches document contents. A native
flush synchronizes accepted input into the existing document authority; durable
recovery, source saving and export continue to use Phase 4. The caller decides when
flush is required and handles failure before switching or closing. Native input and
undo do not acquire another asynchronous queue.

Editor adapters retain their own model, synchronization and rendering policies.
Word reconciles Univer Docs snapshots with its domain store. Excel reads its live
Univer workbook and publishes into the owning tab. PowerPoint continues to read the
existing presentation model and commits native edits through its current controller;
transient animation and playback projections are not document snapshots. Format
codecs, persistence destinations and backend Agent integrations are outside this
increment.

### Editor implementations

- [Word adapter](apps/electron/src/renderer/lib/wordEditorAdapter.ts) owns Univer
  creation, command subscriptions, snapshot reconciliation, delayed native commits,
  flush and cleanup. Its React surface supplies a DOM container and forwards view
  settings. Reconciliation stays ordered, and an obsolete native snapshot cannot
  overwrite a newer domain change. Final accepted native edits are committed before
  the binding is invalidated; teardown still releases resources if that commit fails.
- [Excel adapter](apps/electron/src/renderer/excel/excelUniverAdapter.ts) owns the
  live workbook, editor actions, view controllers and native subscriptions. The
  [React surface](apps/electron/src/renderer/excel/UniverSheetEditor.tsx) exposes a
  document-bound handle; the host retains workspace and source-file policy. Its
  [change binding](apps/electron/src/renderer/lib/office/excelEditorBinding.ts)
  preserves microtask coalescing. Explicit saves and document transitions commit
  an open cell through Univer's own command stack first. Failed commits prevent the
  transition or source write. Cleanup publishes accepted model changes synchronously.
- [PowerPoint driver](apps/electron/src/renderer/lib/presentationEditorDriver.ts)
  owns the native flush/dispose contract around the reusable Fabric canvas. It
  commits only pending user transforms and active text editing, preserving existing
  history behavior. Scene rendering and media remain presentation-specific. Text
  composition blocks an explicit flush instead of truncating input. The workspace
  controller flushes before document transitions and v5 operations, then revalidates
  operation ownership. Native callbacks also retain their original slide identity.

### Phase 5 verification

The final implementation passed 713 tests across 77 related files, each run in a
separate process with the project test preload, plus desktop typecheck, clean lint
and the renderer production build. Binding tests cover late mount completion,
Session/document identity, switch-away-and-back invalidation, flush failure/retry,
cleanup ordering and callbacks after disposal. Adapter tests cover snapshot
reconciliation, pending native changes, composition rejection and existing command
compatibility. Independent reviews checked the Word and Excel integrations and
the shared binding.

An isolated Electron run using the actual hosts, preloads and built renderers
verified Word native typing, native undo/redo, document switching, ordered domain
editing, revision rejection and durable flush/reload. Excel verification included
native editing and tab restoration, then typing into an open cell and creating a
new workbook through the UI callback without first blurring the cell: the pending
value reached the original tab and did not appear in the new one.

A separate actual PowerPoint renderer verified protocol v5 and source-file write
acknowledgements, source-target isolation and bound-document reuse. It then entered
text directly on the Fabric canvas and invoked an Agent page read while the native
textarea was still focused; the response contained the latest text. OS source-save
dialogs and manual use of every IME were not part of these isolated runs; composition
behavior was covered by the driver tests. No new backend or Word/Excel Agent
integration was added.

## Finite acceptance matrix

Each increment closes after its applicable rows pass. A future capability is a
later-phase requirement, not an unbounded search for unrelated defects.

| Scenario | Phase 1 acceptance | Later-phase acceptance |
| --- | --- | --- |
| Open a blank document | Existing background-open behavior survives; known zero and unknown are not conflated | Common document inventory reports blank documents in all editors |
| Switch document or Session | Existing ownership, tab selection and pending-open routing are preserved | Runtime operations always retain explicit Session/document ownership |
| Hide, expand, resize, then reopen | Native bounds/visibility and inline Word behavior remain unchanged | All three use the common container contract without losing edits |
| Agent operation and unseen content | Existing PPT busy/attention timing and visibility guards pass; unavailable Word/Excel signals remain unavailable | Shared frontend command/status contracts are ready for separately scoped integrations |
| Close/cancel and Session deletion | Existing callbacks, final-target handling and cleanup remain intact | Hide, document close, and Session release follow the agreed common lifecycle |
| Edit, save, fail, and recover | Existing persistence and file behavior is unchanged | Shared orchestration preserves dirty state, conflict checks and declared recovery guarantees |
| Native editing and rendering | Existing PPT rendering/playback and Word/Excel editing regressions pass | Input composition, undo, selection and format fidelity pass per driver |
| Shell and accessibility | Header/tab actions, keyboard focus, tooltips, theme and locale remain functional | Common shell changes apply to all three without editor-specific copies |

Run targeted behavioral tests for changed boundaries plus desktop typecheck and
lint. Exercise existing rendering and editor suites appropriate to affected
callers. Record actual checks performed; this matrix does not claim unexecuted
manual/Electron scenarios passed. Remove superseded implementations only after
parity checks, and do not modify backend files while completing these increments.
