'use client'

import { useEffect } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Dashboard error:', error)
  }, [error])

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-8">
      <div className="text-center max-w-md">
        <div className="mx-auto w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-4">
          <AlertCircle className="h-6 w-6 text-red-600" />
        </div>
        <h2 className="text-lg font-semibold mb-2">Errore di caricamento</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Si è verificato un errore durante il caricamento dei dati. Riprova o contatta Antonio.
        </p>
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          Riprova
        </button>
        {error.digest && (
          <p className="text-xs text-muted-foreground mt-4">
            Codice errore: {error.digest}
          </p>
        )}
      </div>
    </div>
  )
}
