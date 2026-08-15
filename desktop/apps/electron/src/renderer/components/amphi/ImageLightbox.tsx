/**
 * Image viewer host — subscribes to lightboxSrcAtom and renders with yet-another-react-lightbox.
 *
 * A singleton mounted at the App root (alongside ConfirmDialog/ToastHost); when open=false YARL renders no DOM itself.
 * Capabilities (plugins): Zoom (wheel/double-click zoom + drag to pan), Download, Fullscreen;
 * built-in close button + click-backdrop-to-close + Esc. Single image, so the carousel is finite and paging arrows are hidden.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import Lightbox from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import Download from 'yet-another-react-lightbox/plugins/download'
import Fullscreen from 'yet-another-react-lightbox/plugins/fullscreen'
import 'yet-another-react-lightbox/styles.css'
import { closeImageAtom, lightboxItemAtom } from '@/atoms/lightbox'
import { rlog } from '@/lib/logger'

/**
 * Toggle macOS traffic-light visibility.
 *
 * Failures are swallowed: the traffic lights are purely decorative, and not being able to reach the window
 * should not let an unhandledrejection pollute the error log (in dev this happens when main was edited
 * without a restart). The only consequence of the degraded path is that the traffic lights stay visible.
 * A module-level function — its reference is stable, so both effects can depend on it safely. On non-macOS it is a no-op.
 */
function setTrafficLights(visible: boolean): void {
  window.api.window
    .setTrafficLightsVisible(visible)
    .catch((err: unknown) => rlog.debug('[lightbox] toggle traffic lights failed', err))
}

/** Singleton host for the image viewer — driven by lightboxAtom; clicking an img / mermaid diagram in markdown opens it. Mounted once at the App top level. */
export function ImageLightbox() {
  const item = useAtomValue(lightboxItemAtom)
  const close = useSetAtom(closeImageAtom)
  const isOpen = item !== null
  // external-system sync: the traffic lights are native controls drawn above the web content, so a
  // full-screen backdrop cannot cover them — only the window itself can hide them.
  useEffect(() => {
    setTrafficLights(!isOpen)
  }, [isOpen])
  // Restoring is attached to **unmount** only. Written as the cleanup of the effect above, every
  // toggle would first send a "show" and then a "hide", wasting one IPC round trip, and the final
  // state would depend on the arrival order of the two async messages. Whereas if unmount / hot-reload
  // left it in the hidden state, the user could never click the close button again.
  useEffect(() => () => setTrafficLights(true), [])
  return (
    <Lightbox
      open={item !== null}
      close={() => close()}
      // download must be given an object {url, filename}: in YARL a string download is treated as a "download URL"
      // (so fetching the relative path returns index.html). url is the image's src; filename is the actual file name.
      // Omitted for ordinary images → YARL downloads using src by default.
      slides={
        item
          ? [{ src: item.src, download: item.download ? { url: item.src, filename: item.download } : undefined }]
          : []
      }
      // The read-only local protocol is element-streaming only (no Fetch API). YARL's Download
      // plugin uses HEAD/XHR, so hide that one action for files already present on the user's disk.
      plugins={item?.local ? [Zoom, Fullscreen] : [Zoom, Download, Fullscreen]}
      // Backdrop: semi-transparent dark + frosted-glass blur of the background. Not dead black; instead you see the
      // blurred app background through frosted glass, which focuses the image and feels softer (the Linear / macOS
      // Preview look). Tune color / opacity / blur radius here.
      //
      // top/height clear the Windows caption button area: YARL is third-party and cannot be wrapped in this project's
      // `ModalBackdrop`, so the same variable is injected through its container style. Without the inset, the top-right
      // corner keeps an uncovered rectangle (the WCO is composited by the system above the WebContents and cannot be covered).
      // On non-win32 the variable is always 0, which is equivalent to filling the screen as before.
      styles={{
        container: {
          top: 'var(--titlebar-win-inset-top)',
          height: 'calc(100% - var(--titlebar-win-inset-top))',
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(12px)',
        },
      }}
      // Disable YARL's fade-in (250ms by default): the fade works via `.yarl__portal`'s opacity 0→1, and an ancestor
      // with opacity<1 isolates the child layer's backdrop-filter so it cannot sample the page background → the frosted
      // glass only appears once the fade finishes (the culprit behind the "half-beat late" feel). fade:0 makes the backdrop
      // opacity=1 instantly, so the blur takes effect immediately.
      animation={{ fade: 0 }}
      carousel={{ finite: true }}
      controller={{ closeOnBackdropClick: true }}
      // Keep maxZoomPixelRatio low (2): open at fit size and do not upsample a small image to fill the viewport (otherwise it looks
      // "hugely magnified the moment you open it"). Zoom depth is guaranteed by the content's own resolution (mermaid diagrams are already exported at 3x).
      zoom={{ scrollToZoom: true, maxZoomPixelRatio: 2 }}
      // Single image: drop the left/right paging arrows.
      render={{ buttonPrev: () => null, buttonNext: () => null }}
    />
  )
}
