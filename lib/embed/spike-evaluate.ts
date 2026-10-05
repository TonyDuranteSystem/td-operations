/**
 * Pass/fail rules for the floating-window frame test (dev job f3f3e237, step 3).
 *
 * The test page loads real CRM pages in frames and takes a snapshot of each one.
 * These pure functions turn a snapshot into a plain verdict, so the rules the whole
 * decision rests on are unit-tested instead of living inside a React page.
 */

export interface FrameSnapshot {
  /** The address the frame was asked to load. */
  src: string
  /** Where the frame actually is now (after any redirect). Empty if unreadable. */
  pathname: string
  /** Value of the frame's data-embedded marker, or null if the marker is missing. */
  embeddedAttr: string | null
  /** True if the frame contains the left menu (an <aside>). */
  hasSidebar: boolean
  /** True if the frame contains the main scrolling area. */
  hasMain: boolean
  /** How many requests to the alert component's polling address the frame has made. */
  alertPolls: number
  /** Set when the frame's document could not be read at all. */
  error?: string
}

export interface FrameCheck {
  id: 'loaded' | 'bare' | 'quiet'
  label: string
  pass: boolean
  detail: string
}

export interface FrameVerdict {
  src: string
  checks: FrameCheck[]
  pass: boolean
}

const LOGIN_PREFIXES = ['/login', '/mfa']

export function isLoginPath(pathname: string): boolean {
  return LOGIN_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))
}

export function evaluateFrame(s: FrameSnapshot): FrameVerdict {
  if (s.error) {
    const detail = `Could not read the frame: ${s.error}`
    return {
      src: s.src,
      pass: false,
      checks: [
        { id: 'loaded', label: 'The real page loaded', pass: false, detail },
        { id: 'bare', label: 'No left menu or header inside the window', pass: false, detail: 'Not checked' },
        { id: 'quiet', label: 'No alert polling inside the window', pass: false, detail: 'Not checked' },
      ],
    }
  }

  const onLogin = isLoginPath(s.pathname)
  const loaded = !onLogin && s.pathname.startsWith('/') && s.hasMain
  const bare = s.embeddedAttr === 'true' && !s.hasSidebar
  const quiet = s.alertPolls === 0

  const checks: FrameCheck[] = [
    {
      id: 'loaded',
      label: 'The real page loaded',
      pass: loaded,
      detail: onLogin
        ? `The window shows the sign-in page (${s.pathname}) — the session was lost`
        : loaded
          ? `Showing ${s.pathname}`
          : `Page not ready (at "${s.pathname}", main area ${s.hasMain ? 'present' : 'missing'})`,
    },
    {
      id: 'bare',
      label: 'No left menu or header inside the window',
      pass: bare,
      detail: bare
        ? 'Window-mode marker is on and there is no left menu'
        : s.embeddedAttr !== 'true'
          ? `Window-mode marker is "${s.embeddedAttr ?? 'missing'}" — the page loaded as the full CRM`
          : 'Window-mode marker is on but a left menu is still there',
    },
    {
      id: 'quiet',
      label: 'No alert polling inside the window',
      pass: quiet,
      detail: quiet ? 'No alert requests made' : `${s.alertPolls} alert request(s) made — alerts would double up`,
    },
  ]
  return { src: s.src, checks, pass: checks.every(c => c.pass) }
}

export function summarize(verdicts: FrameVerdict[]): { pass: boolean; text: string } {
  if (verdicts.length === 0) return { pass: false, text: 'No frames to check.' }
  const failed = verdicts.filter(v => !v.pass)
  if (failed.length === 0) {
    return { pass: true, text: `PASS — all ${verdicts.length} windows loaded as bare pages.` }
  }
  const names = failed.map(v => v.src).join(', ')
  return { pass: false, text: `FAIL — ${failed.length} of ${verdicts.length} windows failed: ${names}` }
}
