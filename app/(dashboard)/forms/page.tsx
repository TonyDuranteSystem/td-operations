"use client"

/**
 * /forms — every standalone form (one that is not tied to a client account), in one place:
 * view it, make a one-time link and copy it, or open its links and submissions. The bank-application card also holds
 * its two address settings (where a reviewed application is submitted, who is told when one arrives).
 * Admins, plus the staff logins named in lib/auth/forms-access.ts (side-menu item + middleware + the staff routes).
 * The list lives in lib/forms-hub/registry.ts.
 */

import { useState } from "react"
import Link from "next/link"
import { STANDALONE_FORMS, type StandaloneForm } from "@/lib/forms-hub/registry"
import { BankApplicationSettings } from "@/components/forms/bank-application-settings"

function FormCard({ form }: { form: StandaloneForm }) {
  const [partner, setPartner] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [created, setCreated] = useState<{ label: string; url: string } | null>(null)
  const [copied, setCopied] = useState(false)

  async function createLink() {
    setError("")
    setCopied(false)
    setBusy(true)
    try {
      const res = await fetch(form.createLinkApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partner_name: partner }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || "Could not create the link.")
      setCreated({ label: d.link.partner_name || "Direct link (no partner)", url: d.link.url })
      setPartner("")
      try {
        await navigator.clipboard.writeText(d.link.url)
        setCopied(true)
      } catch {
        // Copy is a convenience; the link stays on screen for a manual copy.
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not create the link.")
    } finally {
      setBusy(false)
    }
  }

  async function copyAgain() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.url)
      setCopied(true)
    } catch {
      setError("Could not copy. Select the link and copy it by hand.")
    }
  }

  return (
    <div className="border rounded-lg p-5 max-w-3xl">
      <h2 className="text-base font-medium mb-1">{form.name}</h2>
      <p className="text-sm text-muted-foreground mb-4">{form.description}</p>

      <div className="flex flex-wrap gap-2 mb-5">
        <Link href={form.viewHref} className="h-9 px-4 inline-flex items-center rounded-md border text-sm">View form</Link>
        <Link href={form.manageHref} className="h-9 px-4 inline-flex items-center rounded-md border text-sm">Links and submissions</Link>
      </div>

      <h3 className="text-sm font-medium mb-3">Make a new one-time link</h3>
      <label className="text-sm font-medium block mb-1">Partner name <span className="text-xs font-normal text-muted-foreground">(optional)</span></label>
      <p className="text-xs text-muted-foreground mb-2">Only when a third party brings the client. Leave it empty to send the link straight to our own client or anyone else. The person who fills the form appears on the list once they submit.</p>
      <input
        className="w-full h-9 rounded-md border px-3 text-sm mb-4"
        value={partner}
        onChange={(e) => { setPartner(e.target.value); setError("") }}
        placeholder="Type the partner's name, or leave empty"
      />
      <p className="text-xs text-muted-foreground mb-4">When the client submits, the answers wait for our review. They are sent to the bank contact only when we press Submit (addresses are set further down on this card).</p>
      <button className="h-9 px-4 rounded-md bg-gray-900 text-white text-sm disabled:opacity-60" onClick={createLink} disabled={busy}>
        {busy ? "Creating…" : "Create and copy link"}
      </button>
      {error && <p className="text-sm text-red-700 mt-2" role="alert">{error}</p>}
      {created && (
        <div className="mt-4 rounded-md bg-green-50 p-3 text-sm">
          <p className="font-medium mb-1">{created.label}{copied ? " — link copied" : ""}</p>
          <p className="break-all text-xs mb-2">{created.url}</p>
          <button className="h-8 px-3 rounded-md border bg-white text-sm" onClick={copyAgain}>Copy link again</button>
          <p className="text-xs text-muted-foreground mt-2">Do not open it yourself: the first person to press Start on it becomes the only one who can use it.</p>
        </div>
      )}
      {form.id === "bank-application" && <BankApplicationSettings />}
    </div>
  )
}

export default function FormsPage() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-1">Forms</h1>
      <p className="text-sm text-muted-foreground mb-5">
        Standalone forms: not tied to a client account. View one, make a one-time link to send, and read what comes back.
      </p>
      <div className="space-y-4">
        {STANDALONE_FORMS.map((f) => <FormCard key={f.id} form={f} />)}
      </div>
    </div>
  )
}
