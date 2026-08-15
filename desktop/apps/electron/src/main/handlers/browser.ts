import { IPC } from '../../shared/ipc-channels'
import type { EmbeddedBrowserBounds } from '../../shared/types'
import type { EmbeddedBrowserManager } from '../embedded-browser-manager'
import { loggedHandle } from './logged-handle'

export function registerBrowserHandlers(browser: EmbeddedBrowserManager): void {
  loggedHandle(IPC.browser.snapshot, () => browser.snapshot())

  loggedHandle(IPC.browser.closeSession, (_event, sessionId: string) => {
    browser.closeSession(sessionId)
  })

  loggedHandle(IPC.browser.activateSession, (_event, sessionId: string | null) => {
    browser.activateSession(sessionId)
  })

  loggedHandle(IPC.browser.createTab, (_event, sessionId: string, url?: string) => {
    return browser.createTab(sessionId, url)
  })

  loggedHandle(IPC.browser.activateTab, (_event, sessionId: string, tabId: string) => {
    browser.activateTab(sessionId, tabId)
  })

  loggedHandle(IPC.browser.closeTab, async (_event, sessionId: string, tabId: string) => {
    await browser.closeTab(sessionId, tabId)
  })

  loggedHandle(
    IPC.browser.navigateTab,
    async (_event, sessionId: string, tabId: string, url: string) => {
      await browser.navigateTab(sessionId, tabId, url)
    },
  )

  loggedHandle(IPC.browser.goBack, (_event, sessionId: string, tabId: string) => {
    browser.goBack(sessionId, tabId)
  })

  loggedHandle(IPC.browser.goForward, (_event, sessionId: string, tabId: string) => {
    browser.goForward(sessionId, tabId)
  })

  loggedHandle(IPC.browser.reload, (_event, sessionId: string, tabId: string) => {
    browser.reload(sessionId, tabId)
  })

  loggedHandle(
    IPC.browser.hasHorizontalOverflow,
    (_event, sessionId: string, tabId: string) => {
      return browser.hasHorizontalOverflow(sessionId, tabId)
    },
  )

  loggedHandle(IPC.browser.setBounds, (event, bounds: EmbeddedBrowserBounds) => {
    const zoom = event.sender.getZoomFactor()
    browser.setBounds({
      x: bounds.x * zoom,
      y: bounds.y * zoom,
      width: bounds.width * zoom,
      height: bounds.height * zoom,
    })
  })

  loggedHandle(IPC.browser.setVisible, (event, visible: boolean, focusHost?: boolean) => {
    browser.setVisible(visible)
    if (!visible && focusHost === true && !event.sender.isDestroyed()) event.sender.focus()
  })
}
