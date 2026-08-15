import { Component, type ErrorInfo, type ReactNode } from 'react'
import { rlog } from '../lib/logger'

interface State {
  hasError: boolean
  message?: string
  stack?: string
}

interface Props {
  children: ReactNode
}

/**
 * Catch-all React error boundary. Logs the error to the main process log
 * via `electron-log/renderer` so postmortem analysis is possible without
 * having had DevTools open at the time of the crash.
 *
 * COMPLEMENTARY COVERAGE — React Error Boundaries only catch errors thrown
 * during render / lifecycle. They do NOT catch:
 *   - errors inside `setTimeout` / `requestAnimationFrame` callbacks
 *   - errors inside event handlers
 *   - unhandled promise rejections (network, useEffect async work)
 *
 * Those paths are caught by the `window.addEventListener('error', …)` and
 * `'unhandledrejection'` listeners in `main.tsx`. The two layers together
 * cover the renderer; remove either and you have a blind spot.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    rlog.error('[react] uncaught', err, `\nComponent stack:${info.componentStack ?? ''}`)
  }

  private handleReload = (): void => {
    location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div
        style={{
          padding: 32,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          color: 'var(--text, #f0f0f0)',
          background: 'var(--bg-app, #0b0b0c)',
          minHeight: '100vh',
        }}
      >
        <h2 style={{ marginTop: 0, color: '#ff6b6b' }}>Renderer crashed</h2>
        <p style={{ opacity: 0.85 }}>{this.state.message}</p>
        {this.state.stack && (
          <pre
            style={{
              maxHeight: '40vh',
              overflow: 'auto',
              fontSize: 12,
              opacity: 0.6,
              border: '1px solid rgba(255,255,255,0.1)',
              padding: 12,
              borderRadius: 6,
            }}
          >
            {this.state.stack}
          </pre>
        )}
        <p style={{ opacity: 0.6, fontSize: 12 }}>
          Full trace logged to the main log file — open it from View → Open Log File.
        </p>
        <button
          onClick={this.handleReload}
          style={{
            marginTop: 16,
            padding: '8px 16px',
            background: '#0099FF',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}
