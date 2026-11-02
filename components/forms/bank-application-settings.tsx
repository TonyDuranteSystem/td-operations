"use client"

/**
 * The two address lists on the Forms page's Bank-application card (Antonio 2026-11-02: "the settings must be under Forms,
 * in the BofA card"). Everyone who can open Forms SEES them; only the owner can change them (the server enforces it — the
 * disabled boxes here are just the honest picture). The shipping address is shown for reference and is not editable: it is
 * our office address from one place in the code (lib/bofa-intake/shipping.ts).
 */

import { useCallback, useEffect, useState } from "react"
import { shippingAddressLines } from "@/lib/bofa-intake/shipping"

interface Loaded {
  can_edit: boolean
  submit_to: string[]
  submit_changed_by: string | null
  submit_changed_at: string | null
  notify_to: string[]
  notify_changed_by: string | null
  notify_changed_at: string | null
}

function when(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""
}

export function BankApplicationSettings() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState("")
  const [submitTo, setSubmitTo] = useState("")
  const [notifyTo, setNotifyTo] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)

  const apply = useCallback((d: Loaded) => {
    setLoaded(d)
    setSubmitTo(d.submit_to.join(", "))
    setNotifyTo(d.notify_to.join(", "))
  }, [])

  useEffect(() => {
    fetch("/api/bofa-intake-admin/settings", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || "Could not load the settings.")
        apply(d)
      })
      .catch((e) => setLoadError(e instanceof Error && e.message ? e.message : "Could not load the settings."))
  }, [apply])

  async function save() {
    setError("")
    setSaved(false)
    setBusy(true)
    try {
      const res = await fetch("/api/bofa-intake-admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submit_to: submitTo, notify_to: notifyTo }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "Could not save. Please try again.")
      apply({ ...(loaded as Loaded), ...d })
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not save. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const canEdit = loaded?.can_edit === true
  const inputCls = "w-full h-9 rounded-md border px-3 text-sm disabled:bg-gray-50 disabled:text-gray-600"

  return (
    <div className="border-t pt-4 mt-5" data-testid="bank-application-settings">
      <h3 className="text-sm font-medium mb-1">Where applications go</h3>
      <p className="text-xs text-muted-foreground mb-3">
        A submitted application waits for us. Nothing is sent outside until someone marks it Reviewed and presses Submit.
      </p>

      {loadError && <p className="text-sm text-red-700" role="alert">{loadError}</p>}
      {!loaded && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}

      {loaded && (
        <>
          <label className="text-sm font-medium block mb-1">Applications are submitted to</label>
          <p className="text-xs text-muted-foreground mb-2">The bank contact. The Submit button emails the answers and documents here. One or more addresses, separated by commas.</p>
          <input className={`${inputCls} mb-1`} value={submitTo} onChange={(e) => { setSubmitTo(e.target.value); setSaved(false) }} disabled={!canEdit} aria-label="Applications are submitted to" />
          {loaded.submit_changed_at && <p className="text-xs text-muted-foreground mb-3">Last changed by {loaded.submit_changed_by ?? "unknown"} on {when(loaded.submit_changed_at)}.</p>}
          {!loaded.submit_changed_at && <div className="mb-3" />}

          <label className="text-sm font-medium block mb-1">Told when one arrives</label>
          <p className="text-xs text-muted-foreground mb-2">Who gets the email &ldquo;an application is waiting for review&rdquo;. It carries a link only, never the answers or documents.</p>
          <input className={`${inputCls} mb-1`} value={notifyTo} onChange={(e) => { setNotifyTo(e.target.value); setSaved(false) }} disabled={!canEdit} aria-label="Told when one arrives" />
          {loaded.notify_changed_at && <p className="text-xs text-muted-foreground mb-3">Last changed by {loaded.notify_changed_by ?? "unknown"} on {when(loaded.notify_changed_at)}.</p>}
          {!loaded.notify_changed_at && <div className="mb-3" />}

          <p className="text-sm font-medium mb-1">Shipping address on the form</p>
          <p className="text-xs text-muted-foreground mb-1">Filled in for every applicant and locked. It is our office address, so it is not changed here.</p>
          <p className="text-sm mb-3 whitespace-pre-line">{shippingAddressLines().join("\n")}</p>

          {canEdit ? (
            <button className="h-9 px-4 rounded-md bg-gray-900 text-white text-sm disabled:opacity-60" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save addresses"}
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">Only the owner can change these addresses.</p>
          )}
          {saved && <p className="text-sm text-green-700 mt-2">Saved. The owner was emailed a note of the change.</p>}
          {error && <p className="text-sm text-red-700 mt-2" role="alert">{error}</p>}
        </>
      )}
    </div>
  )
}
