'use client'

import { Component, type ReactNode } from 'react'

/**
 * WorkflowErrorBoundary — Bug #22 mitigation from the master plan.
 *
 * Wraps the workflow-aware portion of TaskCard so a buggy attachment template
 * or action button doesn't crash the entire tasks panel. Falls back to a
 * minimal "Workflow render failed" pill that keeps the surrounding task list
 * usable.
 *
 * Plain task rendering (the legacy TaskCard branch) is NOT inside this
 * boundary — failures there are unrelated and use whatever boundary the
 * outer page provides.
 */

interface State {
  hasError: boolean
  message?: string
}

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

export class WorkflowErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(err: unknown): State {
    return { hasError: true, message: err instanceof Error ? err.message : String(err) }
  }

  componentDidCatch(err: unknown, info: { componentStack?: string | null }) {
    // Surface to ops via console; Sentry instrumentation lives upstream.
    console.error('[WorkflowErrorBoundary] caught error in workflow render:', err, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="text-xs px-2 py-1 rounded bg-red-50 text-red-700 border border-red-200">
            Workflow render failed — staff: refresh, then check console.
            {this.state.message ? <span className="ml-1 opacity-70">({this.state.message})</span> : null}
          </div>
        )
      )
    }
    return this.props.children
  }
}
