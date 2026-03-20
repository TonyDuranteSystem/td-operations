'use client'

import { useEffect } from 'react'
import { AlertCircle, RotateCcw, MessageCircle } from 'lucide-react'

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  // Log error for debugging (shows in browser console)
  useEffect(() => {
    console.error('Portal error:', error)
  }, [error])

  return (
    <div className="min-h-[50vh] flex items-center justify-center p-6">
      <div className="text-center max-w-md">
        <div className="mx-auto mb-4 p-3 rounded-full bg-red-50 w-fit">
          <AlertCircle className="h-10 w-10 text-red-400" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-900 mb-2">Something went wrong</h2>
        <p className="text-sm text-zinc-500 mb-1">
          We encountered an unexpected error. Please try again.
        </p>
        {error.digest && (
          <p className="text-xs text-zinc-400 mb-4 font-mono">
            Error ID: {error.digest}
          </p>
        )}
        <div className="flex items-center justify-center gap-3 mt-4">
          <button
            onClick={reset}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <RotateCcw className="h-4 w-4" />
            Try Again
          </button>
          <a
            href="/portal/chat"
            className="flex items-center gap-2 px-4 py-2 text-sm border border-zinc-200 text-zinc-600 rounded-lg hover:bg-zinc-50 transition-colors"
          >
            <MessageCircle className="h-4 w-4" />
            Contact Support
          </a>
        </div>
        <p className="text-xs text-zinc-400 mt-4">
          If this keeps happening, please contact us at support@tonydurante.us
        </p>
      </div>
    </div>
  )
}
