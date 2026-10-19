"use client"

import { useState } from "react"

export function ApproveDevice(p: { deviceName: string; codeChallenge: string; redirectUri: string; state: string; code: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function approve() {
    setBusy(true); setError(null)
    try {
      const res = await fetch("/api/store-devices/approve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_name: p.deviceName, code_challenge: p.codeChallenge, redirect_uri: p.redirectUri, state: p.state }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || "Could not approve this Mac. Please try again.")
      }
      const { redirect } = (await res.json()) as { redirect: string }
      setDone(true)
      window.location.assign(redirect)   // the app's own loopback listener on this Mac
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not approve this Mac. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 space-y-3 text-sm">
      <p>A Mac is asking to open the company storage as a folder in Finder.</p>
      <div className="rounded-md border p-3">
        <div><span className="text-muted-foreground">Computer: </span><strong>{p.deviceName}</strong></div>
        <div><span className="text-muted-foreground">Check code: </span><strong className="font-mono tracking-wider">{p.code}</strong></div>
      </div>
      <p className="text-muted-foreground">The TD Storage app on your Mac shows the same check code. Approve only if the two codes are identical and you just started the sign-in yourself. You can sign a Mac out at any time.</p>
      {error ? <p className="text-red-600">{error}</p> : null}
      {done ? <p>Approved — you can close this page and go back to the app.</p> : (
        <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-60" disabled={busy} onClick={approve}>
          {busy ? "Approving…" : "Approve this Mac"}
        </button>
      )}
    </div>
  )
}
