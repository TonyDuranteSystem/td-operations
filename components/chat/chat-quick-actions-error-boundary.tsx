"use client"

/**
 * ChatQuickActionsErrorBoundary — fallback layer #3 for Slice 6b.
 *
 * Wraps the catalog-driven Create-section rendering so a render-time crash
 * (malformed catalog row that slipped past validation, missing icon, etc.)
 * never takes down the whole per-message dropdown. On error, renders the
 * provided `fallback` prop (the hardcoded Create section) and logs once.
 *
 * Defense-in-depth ordering, top-to-bottom (Slice 6b uses all three):
 *   1. Feature flag check (env var → if off, never even attempt catalog)
 *   2. Validated fetch (catalog rows that fail Zod validation are dropped;
 *      if zero valid rows remain, fall back to hardcoded)
 *   3. This error boundary (catches anything that crashes during render)
 *
 * Class component because React error boundaries can only be class-based.
 */

import { Component, type ReactNode } from "react"

interface Props {
  fallback: ReactNode
  children: ReactNode
  /** Optional logger override for tests. Defaults to console.error. */
  onError?: (error: Error, info: { componentStack?: string | null }) => void
}

interface State {
  hasError: boolean
}

export class ChatQuickActionsErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    if (this.props.onError) {
      this.props.onError(error, info)
    } else {
      // Log once per boundary lifetime — fallback rendering takes over after.
      console.error("[ChatQuickActionsErrorBoundary] catalog render failed:", error, info)
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback
    }
    return this.props.children
  }
}
