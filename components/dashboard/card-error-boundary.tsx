'use client'

import { Component, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

interface Props {
  children: ReactNode
  fallbackTitle?: string
}

interface State {
  hasError: boolean
}

/**
 * Error boundary for dashboard cards.
 * One broken card must not crash the entire dashboard.
 */
export class CardErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-white rounded-lg border p-5">
          {this.props.fallbackTitle && (
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
              {this.props.fallbackTitle}
            </h3>
          )}
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <AlertCircle className="h-8 w-8 mb-2 text-red-300" />
            <p className="text-sm">Failed to load</p>
            <button
              onClick={() => this.setState({ hasError: false })}
              className="mt-2 text-xs text-blue-600 hover:underline"
            >
              Retry
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
