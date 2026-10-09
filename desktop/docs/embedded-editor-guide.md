# Embedded editor integration guide

Use this guide when adding an editor with its own GUI to the Session sidebar,
such as a whiteboard or mind-map editor. PowerPoint, Word and Excel are the
reference implementations. Their shared modules retain the `Office` name but
are the reuse points for other native editors as well.

This is the current integration contract. The
[Office architecture record](../office-architecture.md) explains the existing
layers, adapters and migration history. An integration is complete only when its
behavior, shell, ownership and recovery guarantees are defined together.

## Interaction contract

An editor can have multiple document tabs. **When only one tab remains, closing
it closes that Session's editor surface and retracts its sidebar.** Do not create
a replacement blank tab or leave an empty native window behind.

| Action | Required behavior |
| --- | --- |
| Select another tool, collapse the dock, or view another Session | Hide the native surface; keep its target and workspace alive. Leaving expanded mode is not document closure. |
| Close a non-final document tab | Close that document in the owning workspace's operation queue. Keep other documents and the surface open. |
| Close the final document tab or use the editor header's X | Run the editor's close preparation, close that editor's target, and retract its Session's panel. Use the same surface-close path for both actions. |
| A close completes after navigation | Update the original Session even on Settings or another page. Preserve a newer tool/focus pane selected in that Session and every other Session's layout. |
| Delete/release a Session | Release all of its editor targets, pending requests, workers and subscriptions. Do not release another Session's targets. |
| Actually close the app window, quit, or install an update | Release all editor targets without an Office unsaved-changes confirmation or unload veto. Any best-effort recovery checkpoint must be bounded and must not cancel exit on failure. |
| Close the window with hide-to-tray enabled | Follow the existing application hide behavior; this is not an editor shutdown. |

Closing is not an implicit source-file save. Use the editor-specific close policy
declared below; do not introduce a generic Office confirmation shared by editors
with different persistence guarantees. Automatic source writes and workspace
recovery have different guarantees. Native input commits or an existing source-save
contract can fail before a panel close is accepted. Report such failures through
the editor's error UI, without introducing an app-quit veto.

The final-tab decision belongs **inside the serialized document operation**,
after reconciling pending native input. Two quick closes must not both use an old
React tab count and leave an empty workspace. Do not wait recursively on the same
queue. Keep any snapshot needed for close preparation alive until it is consumed.

## Ownership and close handshake

```text
Main-window shell (read-only status + Session layout)
          │ typed IPC / Session-scoped events
Electron XManager (owns views, targets and request tickets)
          │ exact Session + renderer identity
Session renderer (workspace → domain → native engine)
          ↑ structured dispatch, if Agent support is implemented
Python SessionX / XHost → exact CDP target
```

The main window projects status; it must not mount a second document store.
The renderer/domain owns document contents. The main process owns the inventory
and lifetime of native targets. A file path, current foreground Session, or
window title is not proof of ownership.

Use [OfficeSessionContainer](../apps/electron/src/main/office-session-container.ts)
for target creation, attachment, visibility, CDP discovery and destruction.
Register a target before asynchronous loading, and keep the container's generation
checks. Use `closeOptions: { waitForBeforeUnload: false }`; do not add a renderer
`beforeunload` listener that vetoes closure. Engine-specific parking or crash
recovery belongs in the manager adapter.

Use [registerOfficeCloseHandler](../apps/electron/src/main/handlers/office-close.ts)
for a child renderer's close request:

1. Resolve the Session from the sending `webContentsId`; reject foreign senders.
2. Optionally await bounded editor-specific close preparation. The adapter owns
   its persistence/error policy. The helper does not turn a rejected save into success.
3. Revalidate the sender after preparation, then emit its Session's close event.
4. Acknowledge the IPC invocation before deferred destruction. Destroy by the
   **original sender identity**, resolving ownership again. Never defer a bare
   `closeSession(sessionId)` that could destroy a replacement target.

The standard child API takes no caller-selected Session ID. PowerPoint's older
API additionally requires its Session argument to match the sender; keep this
compatibility check when changing its adapter.

[useOfficeCloseBridge](../apps/electron/src/renderer/hooks/useOfficeCloseBridge.ts)
is mounted at application lifetime, not inside the visible sidebar. It routes
events to [closeOfficeSurfaceAtom](../apps/electron/src/renderer/atoms/office.ts)
and the Session-specific layout operation in
[workbench atoms](../apps/electron/src/renderer/atoms/workbench.ts). Extend this
route for a new editor, including expansion reset. Do not use the viewed Session
as a substitute for the event's owner, or collapse a different currently selected
tool. A dirty/status snapshot update must not trigger a stale `ensureSession`
that reopens a just-closed editor.

File-open requests and acknowledgements also retain their original Session and
renderer. Use sender-checked, one-use tickets where the child redeems a file
request. Revalidate identity/revision after asynchronous parsing and before
committing; a late result must not reopen a closed target or overwrite newer edits.

## Shared shell and visual design

Reuse [OfficeWorkbenchChrome](../apps/electron/src/renderer/components/app/OfficeWorkbenchChrome.tsx)
instead of copying its JSX or Tailwind classes. It is the source of truth for
dimensions, spacing, borders and control states:

| Component | Responsibility |
| --- | --- |
| `OfficeAppHeader` | One application header, `h-12`, icon tile, title and optional subtitle. |
| `OfficePanelControls` | Expand/restore and close actions, `size-7` controls, tooltips and accessible labels. |
| `OfficeDocumentTabs` | One document strip, `h-11`, selection, close, dirty marker and new-document action. The adapter supplies callbacks. |
| [OfficeSurfaceRailButton](../apps/electron/src/renderer/components/app/OfficeSurfaceRailButton.tsx) | Common rail status and attention presentation. |

Keep the header and document strip visible while the engine content flexes with
`min-h-0` and `min-w-0`. Render one shell, whether it lives in the child renderer
or wraps its viewport. Engine ribbons, canvas toolbars and workbook sheet tabs
remain editor-specific; sheet tabs are not document tabs.

Use semantic `bg-bg-*`, `text-text-*` and `border-border-*` tokens. Pass only the
editor's icon/accent, translated labels and supported actions. Do not introduce a
second header size, close icon, tab treatment or hard-coded light background.
Use the shared tooltip behavior, `aria-label`, `aria-selected` and `aria-pressed`
contracts. Sync theme, locale and zoom into each native target, including hidden
ones. Verify clipping and pointer/focus behavior in Electron, not only the DOM.

Use [useNativeOfficeSurface](../apps/electron/src/renderer/hooks/useNativeOfficeSurface.ts)
for bounds, clipping, resize, activation and visibility. Keep its client/policy
references stable. It hides on detachment; it does not own document destruction.
Use [useOfficeSurfaceSnapshot](../apps/electron/src/renderer/hooks/useOfficeSurfaceSnapshot.ts)
so pushed inventory cannot be overwritten by a stale initial read.

Extend [officeSurfaceStatus](../apps/electron/src/renderer/lib/office/officeSurfaceStatus.ts)
and its Session projection with actual facts. Unknown counts/dirty state remain
unknown. Loading a renderer is not Agent execution; target presence is not a
document count. Do not fabricate busy/attention indicators for an unsupported API.

## Workspace, engine and file boundaries

Reuse these modules independently; a new document model does not need a new copy
of the platform:

| Module | Reuse it for | Keep in the adapter |
| --- | --- | --- |
| [officeWorkspaceRuntime](../apps/electron/src/renderer/lib/office/officeWorkspaceRuntime.ts) | Stable document identity, metadata, operation ordering, capabilities, Session/revision guards | Document model, commands, domain validation |
| [officeEditorBinding](../apps/electron/src/renderer/lib/office/officeEditorBinding.ts) | Mount/dispose, readiness, document leases, native flush and change publication | Native engine setup, model reconciliation, rendering |
| [officePersistence](../apps/electron/src/renderer/lib/office/officePersistence.ts) | Ordered writes, receipts, recovery coalescing, flush/retry | Snapshot codecs, destination, fidelity and source-write policy |
| [officeImportWorker](../apps/electron/src/renderer/lib/office/officeImportWorker.ts) | Disposable worker, transfer, cancellation and parsing errors | Format parser, resource limits, resulting model |

Native typing, composition, selection and undo stay in the engine. Explicit
commands flush accepted input through the binding and share the workspace queue.
Do not send every keystroke through IPC. A stale document lease must not publish
into a newly selected document.

Move expensive parsing off the UI thread, transfer buffers where possible, bound
input/decompressed resources, and cancel work during teardown. Preserve structured
errors instead of silently truncating content. Worker parsing alone is not proof
of responsiveness: test conversion and engine mounting with a representative
large file, and check supported drawing/media fidelity.

Declare recovery and source-save guarantees for every new editor. Current adapters:

| Editor | Workspace/source guarantee | Close policy |
| --- | --- | --- |
| Word | Durable IndexedDB workspace recovery with localStorage fallback; does not overwrite imported DOCX | Bounded best-effort recovery checkpoint before panel/app closure; failure does not veto exit. |
| Excel | Main-process Session recovery survives renderer reload, not app restart or Session release; source save is explicit | No dirty-close prompt; closing releases that recovery state. Source save retains conflict/fidelity checks. |
| PowerPoint | Durable renderer IndexedDB recovery for one structured `PresentationWorkspace`; imported PPTX parts use hidden internal asset references, while newly inserted external files use Session mounts until an explicit export snapshots them | Dirty project closure asks to save, discard or cancel. Session closure drains the workspace write and any requested PPTX export. |

These are storage policies, not different tab designs. In particular, a shared
close handshake does not promise that every editor saves every change on quit.
Keep each editor's declared persistence boundary documented and covered by restore,
write-failure and close tests.

## Adding another editor

1. Define the domain, supported capabilities, target granularity and persistence
   policy. Default to one native target per Session with internal document tabs;
   use per-document targets only when the engine requires them, with the same
   Session isolation.
2. Add an `XManager` adapter over the shared container and attach it through
   [WindowManager](../apps/electron/src/main/window-manager.ts). Wire Session
   release, app cleanup and bounded recovery if supported.
3. Add typed [IPC channels](../apps/electron/src/shared/ipc-channels.ts),
   [API types](../apps/electron/src/shared/types.ts), handlers and a narrow preload.
   Register the shared close handshake and route its event through the app bridge.
4. Add the dedicated renderer/build entry, domain store, engine binding and file
   adapter. Reuse the shell, hooks and runtimes above. Existing wiring is in
   [ExcelHost](../apps/electron/src/main/excel-host.ts),
   [WordHost](../apps/electron/src/main/word-host.ts) and
   [PowerPointManager](../apps/electron/src/main/embedded-powerpoint-manager.ts).
5. Extend `OfficeAppKind`, the workbench surface kind, status projection, rail, panel selection,
   expansion reset, API stub, translations and file-link routing as appropriate.
   A renderer-only extension panel can use
   [DesktopAppExtensions](../apps/electron/src/renderer/components/app/DesktopAppExtensions.ts)
   instead; that does not provide a native target or Agent integration.
6. If Agent control is part of the feature, expose a stable Session-bound Python
   `SessionX` through `XHost`. Connect to the exact manager-owned CDP target and
   call a structured renderer API such as `window.__bridgicX.dispatch(...)`.
   Validate commands and return structured results/errors; do not use DOM clicks
   for business operations. Word/Excel sharing this UI platform does not itself
   add Python Agent tools. Keep existing PowerPoint protocol compatibility.
7. Record the new editor's guarantees here and run the acceptance checks below.

## Acceptance checks

Cover the boundaries your integration changes with behavioral tests:

- Two Sessions open: close A while viewing B or Settings; B's target and layout
  survive, and returning to A does not recreate the closed editor automatically.
- Close one tab, the final tab and the header; rapidly close two tabs; repeat
  close; close during a checkpoint and reopen the same Session before teardown.
- Reject a foreign sender and expired ticket; ignore stale load, snapshot,
  import, native lease and deferred close results after replacement.
- Hide/expand/resize/switch/reopen without losing live edits; test native focus,
  clipping, theme and zoom in an isolated Electron run.
- Close/quit with dirty documents and failed or timed-out recovery: no Office
  confirmation or unload veto. Verify only the adapter's declared save guarantee.
- Exercise large imports, cancellation, errors and retry without blank recovery
  overwrites, silent format truncation or duplicate source writes.

Useful regression examples are
[the close handshake tests](../apps/electron/src/main/__tests__/office-close.test.ts),
[Session layout/bridge tests](../apps/electron/src/renderer/components/app/__tests__/SessionResourcePanel.test.tsx)
and [shared chrome tests](../apps/electron/src/renderer/components/app/__tests__/OfficeWorkbenchChrome.test.tsx).
Run affected Bun suites with `--preload ./test-setup.ts` from `desktop/`; isolate
test files that mock shared modules. Also run `bun run typecheck`, `bun run lint`,
`bun run check:doc-links` and the affected build. Report native/OS cases that were
not exercised rather than treating unit tests as a manual UI check.
