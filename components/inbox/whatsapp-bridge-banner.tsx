'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface BridgeStatus {
  health: 'ok' | 'unmonitored' | 'none' | 'offline' | 'process_down' | 'unlinked' | 'disconnected'
  isOwner?: boolean
  reason?: string | null
  hint?: string | null
  code?: string | null
  codeAgeSeconds?: number | null
  /** owner only: "Get a new code" was pressed and the Mac has not answered yet */
  codeRequested?: boolean
  /** owner only: 5 codes were already made this hour — when the hour is over (ISO) */
  codeLimitUntil?: string | null
}

const POLL_MS = 30_000
const POLL_UNLINKED_MS = 10_000

/**
 * Red banner at the top of the Inbox WhatsApp tab when the self-hosted WhatsApp link is unhealthy (same rules as the alert email).
 * When WhatsApp has UNLINKED the device, the owner sees the pairing code the Mac fetched and the steps to type it on the phone.
 * Renders nothing while the link is healthy (or not monitored).
 */
export function WhatsAppBridgeBanner() {
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false) // between the click and the first status that shows the request
  const [askError, setAskError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inbox/whatsapp/bridge-status', { cache: 'no-store' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not read the WhatsApp link status.')
      }
      setStatus(await res.json())
      setError(null)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not read the WhatsApp link status.')
    }
  }, [])

  const askForCode = async () => {
    setAskError(null)
    setAsking(true)
    try {
      const res = await fetch('/api/inbox/whatsapp/bridge-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'code' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not send the request. Please try again.')
      if (d.result === 'limit') setAskError('5 codes were already made in the last hour — please wait a little and try again.')
      else if (d.result === 'linked') setAskError('WhatsApp is connected again — no code needed.')
      await load()
    } catch (err) {
      setAskError(err instanceof Error && err.message ? err.message : 'Could not send the request. Please try again.')
    } finally {
      setAsking(false)
    }
  }

  const unlinked = status?.health === 'unlinked'
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), unlinked ? POLL_UNLINKED_MS : POLL_MS)
    return () => clearInterval(timer)
  }, [load, unlinked])

  if (error && !status) return null // a status-read failure must not block the inbox
  if (!status || status.health === 'ok' || status.health === 'unmonitored' || status.health === 'none') return null

  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-red-200 bg-red-50 text-red-900" role="alert">
      <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0 text-red-600" />
      <div className="flex-1 min-w-0 space-y-2">
        <p className="text-sm font-semibold">WhatsApp is not connected — new messages are NOT arriving in the CRM.</p>
        {status.reason && <p className="text-sm">{status.reason}</p>}

        {unlinked && status.isOwner ? (
          <div className="space-y-2">
            {status.code ? (
              <>
                <p className="text-xs uppercase tracking-wide text-red-700">Your pairing code</p>
                <p className="font-mono text-3xl font-bold tracking-widest select-all">{status.code}</p>
                <p className="text-xs text-red-800">
                  On the phone: WhatsApp → Settings → Linked devices → Link a device → <b>Link with phone number instead</b> → type this code.
                  It expires in about 2 minutes — if it runs out, press the button below for a new one.
                </p>
              </>
            ) : status.codeRequested ? (
              <p className="text-sm" role="status">Asking the Mac Mini for a pairing code — it should appear here within about a minute…</p>
            ) : (
              <p className="text-sm">
                No pairing code is made until you ask for one. Get the phone ready first (WhatsApp → Settings → Linked devices → Link a device →
                <b> Link with phone number instead</b>), then press the button — the code lasts about 2 minutes.
              </p>
            )}
            <button
              type="button"
              disabled={asking || !!status.codeRequested}
              onClick={askForCode}
              data-testid="wa-get-code"
              className="inline-flex items-center gap-1.5 rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${asking || status.codeRequested ? 'animate-spin' : ''}`} />
              {status.code ? 'Get a new code' : 'Get a pairing code'}
            </button>
            {askError && <p className="text-xs text-red-700" role="alert">{askError}</p>}
            {!askError && status.codeLimitUntil && !status.codeRequested && (
              <p className="text-xs text-red-700">5 codes were already made this hour; you can ask again after {new Date(status.codeLimitUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>
            )}
          </div>
        ) : unlinked ? (
          <p className="text-sm">Only the owner can see the pairing code. Please tell Antonio.</p>
        ) : (
          status.hint && <p className="text-sm">{status.hint}</p>
        )}
      </div>
    </div>
  )
}
