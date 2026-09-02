/**
 * Amphi icon set — pure inline SVG.
 *
 * Each entry is `(size = 16) => JSX.Element` so callers can override the
 * pixel size at the call site. Stroke/fill uses `currentColor` so the icon
 * inherits whatever `text-*` Tailwind class is applied to the parent.
 *
 * Approved oversized collection file per §1.14 (a single file is more
 * scannable than 28 tiny ones; the 28+ icons here are all stylistically
 * uniform).
 */
export const Icons = {
  plus: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  search: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  chevronDown: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  chevronRight: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  settings: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path
        d="M19.14 12.94a7.49 7.49 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a7.36 7.36 0 00-1.62-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 00-.61.22L2.65 8.84a.5.5 0 00.12.64l2.03 1.58a7.49 7.49 0 000 1.88L2.77 14.52a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.61.22l2.39-.96c.49.39 1.03.7 1.62.94l.36 2.54a.5.5 0 00.5.42h3.84a.5.5 0 00.5-.42l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96a.5.5 0 00.61-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  chat: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M2 3h12v8H5l-3 2.5V3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  workflow: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10" y="2" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="6" y="10" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 6v2h4M12 6v2H8M8 8v2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  workflowResult: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M4 2h5l3 3v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 2v3h3M5.2 9l1.6 1.6 3.4-3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  folder: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3H3a1 1 0 00-1 1z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  file: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M4 2h5l3 3v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  sheet: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 6.5h12M2 10h12M6.5 6.5v7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  document: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M4 2h5l3 3v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5.5 8h5M5.5 10.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  play: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M5 3l8 5-8 5V3z" fill="currentColor" />
    </svg>
  ),
  stop: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  ),
  check: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  x: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  dots: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12" cy="8" r="1.2" fill="currentColor" />
    </svg>
  ),
  clock: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5v3.5l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  // Thinking emphasis (the label of the "thinking" block in the QA execution process).
  lightbulb: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5a4.5 4.5 0 00-2.7 8.1c.45.34.7.86.7 1.4h4c0-.54.25-1.06.7-1.4A4.5 4.5 0 008 1.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6.2 12.5h3.6M6.8 14.5h2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  // Single-line icon for a failed tool (QA execution process, aligned with the QAXCircle design).
  xCircle: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  // Hint / help icon (a ? in a circle) — the trigger point of a hover tooltip.
  help: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6.06 6.2a2 2 0 0 1 3.89 0.67c0 1.33-2 2-2 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="7.95" cy="11.35" r="0.85" fill="currentColor" />
    </svg>
  ),
  // Single-line icon for network tools (web_search / web_fetch).
  globe: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2 8h12M8 2c1.7 1.6 2.7 3.7 2.7 6S9.7 12.4 8 14C6.3 12.4 5.3 10.3 5.3 8S6.3 3.6 8 2z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  ),
  send: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M2 8l12-5-5 12-2-5-5-2z" fill="currentColor" />
    </svg>
  ),
  slash: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M10 3L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  at: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 6v3a1.5 1.5 0 003 0V8a5.5 5.5 0 10-2 4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  eye: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  download: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M8 2v8M5 7l3 3 3-3M3 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  trash: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M3 5h10l-1 9H4L3 5zM6 2h4M2 5h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  edit: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M11 2l3 3-8 8H3v-3l8-8z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  refresh: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M2.5 8a5.5 5.5 0 019.27-4M13.5 8a5.5 5.5 0 01-9.27 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11 1l1 3h-3M5 15l-1-3h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  robot: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="3" y="5" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6" cy="9" r="1" fill="currentColor" />
      <circle cx="10" cy="9" r="1" fill="currentColor" />
      <path d="M8 2v3M6 2h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  panelRight: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10 2.5v11" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  panelLeft: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  // Filled-left variant — signals the left sidebar is OPEN (vs panelLeft outline = closed).
  panelLeftFilled: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.6" y="3.6" width="3.4" height="8.8" rx="1" fill="currentColor" />
    </svg>
  ),
  // Filled-right variant — signals the right panel is OPEN (vs panelRight outline = closed).
  panelRightFilled: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10" y="3.6" width="3.4" height="8.8" rx="1" fill="currentColor" />
    </svg>
  ),
  link: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path
        d="M6.5 9.5l3-3M7 11l-1.5 1.5a2.12 2.12 0 01-3-3L4 8M9 5l1.5-1.5a2.12 2.12 0 013 3L12 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  feishu: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M3 4l5 4 5-4M3 4v7l5 3 5-3V4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  ),
  terminal: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 7l2.5 2L4 11M8 11h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  paperclip: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05L12.25 20.24a6 6 0 01-8.49-8.49L13.13 2.4a4 4 0 015.66 5.66L9.41 17.44a2 2 0 01-2.83-2.83L15.07 6.1" />
    </svg>
  ),
  square: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  ),
  arrowUp: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  ),
  sun: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  moon: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" />
    </svg>
  ),
  restart: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <polyline points="21 4 21 9 16 9" />
    </svg>
  ),
  // Added for the schedule feature (ported from the ui.jsx design mock): approval-center bell / needs-action alert / fix-it-for-me wrench.
  bell: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M8 2.2a3 3 0 013 3V8.4l1.1 1.6a.4.4 0 01-.34.63H4.24A.4.4 0 013.9 10L5 8.4V5.2a3 3 0 013-3z"
            stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.6 12.4a1.5 1.5 0 002.8 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  alert: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M8 2L1.5 13.5h13L8 2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 6.5v3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r=".9" fill="currentColor" />
    </svg>
  ),
  wrench: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M10.5 2.5a3 3 0 00-3.8 3.8l-4 4a1.2 1.2 0 001.7 1.7l4-4a3 3 0 003.8-3.8l-1.8 1.8-1.5-.4-.4-1.5 1.8-1.8z"
            stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  ),
} as const

export type IconKey = keyof typeof Icons
