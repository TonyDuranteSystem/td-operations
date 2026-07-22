'use client'

/**
 * Crash guard for the floating chat window.
 *
 * WHY THIS EXISTS AT ALL: the window mounts in the dashboard layout, and the
 * dashboard's error.tsx is a PAGE-segment boundary — it does not catch a throw
 * originating in the layout, and there is no global boundary. Unguarded, one bad
 * message render white-screens the entire CRM, on every page, for both staff.
 * The sticky-notes layer carries its own boundary for exactly this reason.
 *
 * WHY IT IS NOT A COPY OF THAT ONE: the notes boundary renders `null` forever.
 * For notes that is fine — a missing post-it is visibly missing. For a chat it
 * is the worst possible failure: the window silently disappears and the user
 * concludes nobody is writing to them, while messages pile up unseen. So this
 * one degrades to a VISIBLE pill that says something broke and offers a retry,
 * which remounts the subtree with a fresh key.
 *
 * LIMIT, stated because it is easy to over-trust: React error boundaries catch
 * render/lifecycle throws ONLY. They do not catch errors in event handlers or in
 * async work (a failed fetch, a realtime callback). Those must be caught where
 * they happen and surfaced with the server's own message (R099).
 */

import React from 'react'
import { MessageSquareWarning } from 'lucide-react'

interface Props {
  children: React.ReactNode
  /** Where the fallback pill sits, matching the window's own anchor. */
  className?: string
}

interface State {
  dead: boolean
  /** Bumped on retry to force a fresh subtree. */
  attempt: number
}

export class ChatErrorBoundary extends React.Component<Props, State> {
  state: State = { dead: false, attempt: 0 }

  static getDerivedStateFromError(): Partial<State> {
    return { dead: true }
  }

  componentDidCatch(error: unknown, info: unknown) {
    // Contained, but never silent in the console — a white-screen-adjacent event
    // should be findable when someone asks "why did my chat vanish?"
    console.warn('[floating-chat] window crashed (contained):', error, info)
  }

  private retry = () => {
    this.setState((s) => ({ dead: false, attempt: s.attempt + 1 }))
  }

  render() {
    if (this.state.dead) {
      return (
        <div
          className={
            this.props.className ??
            'fixed bottom-4 right-4 z-[46] flex items-center gap-2 rounded-full border border-emerald-300 bg-emerald-100 px-4 py-2 text-sm text-emerald-950 shadow-lg'
          }
          role="alert"
        >
          <MessageSquareWarning className="h-4 w-4 shrink-0" />
          <span>Chat had a problem.</span>
          <button
            onClick={this.retry}
            className="rounded bg-emerald-200 px-2 py-0.5 font-medium hover:bg-emerald-300"
          >
            Reopen
          </button>
        </div>
      )
    }
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>
  }
}
