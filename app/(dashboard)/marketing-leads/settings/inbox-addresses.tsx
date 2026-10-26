"use client"

import { Fragment, useState } from "react"
import { useRouter } from "next/navigation"
import { buildSignatureHtml } from "@/lib/email/signature"

export interface AddressRow { address: string; people: string[]; signature_name: string; signature_title: string; signature_phone: string; connected: boolean }
interface Sig { name: string; title: string; phone: string }
export interface PersonOption { id: string; label: string }

/** The signature fields and what they produce: the same company block the CRM Inbox sends (Full = with the logo and badges, Compact = small mark). Empty fields keep the company's own. */
function SignatureEditor({ address, value, onChange, disabled }: { address: string; value: Sig; onChange: (v: Sig) => void; disabled?: boolean }) {
  const field = "w-full rounded-lg border px-3 py-1.5 text-sm"
  const html = (variant: "gala" | "text") => buildSignatureHtml({ sender: "support", variant, includeSignoff: false, identity: { name: value.name, title: value.title, phone: value.phone, email: address } })
  return (
    <div className="space-y-2" data-testid="signature-editor">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-xs text-slate-500">Name<input className={field} maxLength={80} value={value.name} disabled={disabled} placeholder="Tony Durante LLC" onChange={e => onChange({ ...value, name: e.target.value })} data-testid="sig-name" /></label>
        <label className="text-xs text-slate-500">Title<input className={field} maxLength={80} value={value.title} disabled={disabled} placeholder="e.g. Sales, Tony Durante LLC" onChange={e => onChange({ ...value, title: e.target.value })} data-testid="sig-title" /></label>
        <label className="text-xs text-slate-500">Phone<input className={field} maxLength={80} value={value.phone} disabled={disabled} placeholder="+1 (727) 452-1093" onChange={e => onChange({ ...value, phone: e.target.value })} data-testid="sig-phone" /></label>
      </div>
      <p className="text-xs text-slate-500">Under every email written from {address} the person picks <b>Full</b>, <b>Compact</b> or <b>No signature</b> next to Send, exactly as in the CRM Inbox. The address of the company is added; leave a box empty to keep the company&apos;s own.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><p className="text-xs font-medium text-slate-500">Full</p><div className="overflow-auto rounded-lg border bg-white p-2" data-testid="sig-preview-full" dangerouslySetInnerHTML={{ __html: html("gala") }} /></div>
        <div><p className="text-xs font-medium text-slate-500">Compact</p><div className="overflow-auto rounded-lg border bg-white p-2" data-testid="sig-preview-compact" dangerouslySetInnerHTML={{ __html: html("text") }} /></div>
      </div>
    </div>
  )
}

/** The signature of one saved address: edit and save it on its own. */
function RowSignature({ row, busy, onSave }: { row: AddressRow; busy: boolean; onSave: (s: Sig) => void }) {
  const [v, setV] = useState<Sig>({ name: row.signature_name, title: row.signature_title, phone: row.signature_phone })
  const same = v.name === row.signature_name && v.title === row.signature_title && v.phone === row.signature_phone
  return (
    <div className="space-y-2">
      <SignatureEditor address={row.address} value={v} onChange={setV} disabled={busy} />
      <button type="button" className="rounded-lg border bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" disabled={busy || same} onClick={() => onSave(v)} data-testid={`sig-save-${row.address}`}>Save signature</button>
    </div>
  )
}

/** CRM > Marketing > Settings > Inbox addresses (dev job 9aec66fa). Antonio adds an address (the system checks it can open it first), ticks who may open it, and can remove it. Every server answer is shown as written (R099). */
export function InboxAddresses({ teamId, rows, people }: { teamId: string; rows: AddressRow[]; people: PersonOption[] }) {
  const router = useRouter()
  const [address, setAddress] = useState("")
  const [checked, setChecked] = useState<{ address: string } | null>(null)
  const [ticks, setTicks] = useState<string[]>([])
  const [signature, setSignature] = useState<Sig>({ name: "", title: "", phone: "" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const nameOf = (id: string) => people.find(p => p.id === id)?.label ?? "someone who left"

  async function call(body: Record<string, unknown>, fallback: string): Promise<{ data?: unknown } | null> {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch("/api/marketing-admin/inbox-mailboxes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId, ...body }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === "string" && d.error ? d.error : fallback)
      return d
    } catch (e) { setError(e instanceof Error && e.message ? e.message : fallback); return null } finally { setBusy(false) }
  }

  async function check() {
    setChecked(null)
    const d = await call({ action: "check", address }, "Could not check the address. Please try again.")
    const data = d?.data as { address: string; people: string[] } | undefined
    if (data) { setChecked({ address: data.address }); setTicks(data.people) }
  }
  async function save() {
    if (!checked) return
    const d = await call({ action: "add", address: checked.address, people: ticks, signature }, "Could not save the address. Please try again.")
    if (d) { setDone(`${checked.address} is added. It now appears in the Inbox of the people you chose.`); setChecked(null); setAddress(""); setSignature({ name: "", title: "", phone: "" }); setTicks([]); router.refresh() }
  }
  async function remove(a: string) {
    const d = await call({ action: "remove", address: a }, "Could not remove the address. Please try again.")
    if (d) { setDone(`${a} is removed from the Inbox.`); router.refresh() }
  }
  async function saveSignature(a: AddressRow, sig: Sig) {
    const d = await call({ action: "update", address: a.address, signature: sig }, "Could not save the signature. Please try again.")
    if (d) { setDone(`The signature of ${a.address} is saved.`); router.refresh() }
  }
  async function toggle(a: AddressRow, id: string) {
    const known = a.people.filter(x => people.some(p => p.id === x)) // people who left the team are dropped, so they cannot block a change
    const next = known.includes(id) ? known.filter(x => x !== id) : [...known, id]
    const d = await call({ action: "update", address: a.address, people: next }, "Could not change who can open it. Please try again.")
    if (d) router.refresh()
  }

  const btn = "rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50"
  return (
    <section className="rounded-xl border bg-white p-4" data-testid="inbox-addresses">
      <h2 className="text-sm font-semibold text-slate-600">Inbox addresses</h2>
      <p className="mt-1 text-xs text-slate-500">The mailboxes the team&apos;s Inbox may open. Only you add an address: the system&apos;s Gmail key can open any company mailbox, so the team owner cannot point it at someone else&apos;s. The CRM mailboxes (support@, antonio@) are always refused.</p>

      {rows.length === 0 ? <p className="mt-3 text-sm text-slate-500">No address yet. The Inbox shows nothing until you add one.</p> : (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="border-b text-xs text-slate-500"><tr><th className="py-2 pr-3">Address</th><th className="pr-3">Status</th><th className="pr-3">Who can open it (besides you)</th><th /></tr></thead>
          <tbody className="divide-y">
            {rows.map(r => (
              <Fragment key={r.address}>
              <tr data-testid="inbox-address-row">
                <td className="py-2 pr-3 font-medium">{r.address}</td>
                <td className="pr-3">{r.connected ? <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 text-xs text-emerald-800">connected</span> : <span className="rounded-full border border-rose-300 bg-rose-50 px-2 text-xs text-rose-800">cannot be opened</span>}</td>
                <td className="pr-3">
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {people.map(p => <label key={p.id} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={r.people.includes(p.id)} disabled={busy} onChange={() => toggle(r, p.id)} data-testid={`inbox-person-${r.address}-${p.id}`} />{p.label}</label>)}
                    {r.people.filter(id => !people.some(p => p.id === id)).map(id => <span key={id} className="text-xs text-slate-400">{nameOf(id)}</span>)}
                  </div>
                </td>
                <td><button className="rounded-lg border px-2 py-1 text-xs" disabled={busy} onClick={() => remove(r.address)} data-testid={`inbox-remove-${r.address}`}>Remove</button></td>
              </tr>
              <tr><td colSpan={4} className="pb-4 pt-1">
                <details data-testid={`sig-details-${r.address}`}><summary className="cursor-pointer text-xs font-medium text-slate-600">Signature of {r.address}{r.signature_name || r.signature_title || r.signature_phone ? "" : " (the company's own)"}</summary>
                  <div className="mt-2"><RowSignature row={r} busy={busy} onSave={sig => saveSignature(r, sig)} /></div>
                </details>
              </td></tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-4 rounded-lg border p-3">
        <p className="text-sm font-medium">Add an address</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input aria-label="New inbox address" className="w-72 rounded-lg border px-3 py-2 text-sm" placeholder="name@tonydurante.us" value={address} onChange={e => { setAddress(e.target.value); setChecked(null) }} autoComplete="off" />
          <button className={`${btn} bg-slate-900 text-white`} disabled={busy || !address.trim()} onClick={check} data-testid="inbox-check">Check it</button>
        </div>
        {checked && (
          <div className="mt-3 space-y-3" data-testid="inbox-checked">
            <p><span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 text-xs text-emerald-800">connected: the system can open {checked.address}</span></p>
            <div>
              <p className="text-sm font-medium">Who can open it?</p>
              <p className="text-xs text-slate-500">You always can. Nobody else can unless you tick them here.</p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {people.map(p => <label key={p.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={ticks.includes(p.id)} onChange={() => setTicks(ticks.includes(p.id) ? ticks.filter(x => x !== p.id) : [...ticks, p.id])} data-testid={`inbox-new-person-${p.id}`} />{p.label}</label>)}
              </div>
            </div>
            <div><p className="text-sm font-medium">Signature</p><SignatureEditor address={checked.address} value={signature} onChange={setSignature} disabled={busy} /></div>
            <button className={`${btn} bg-slate-900 text-white`} disabled={busy} onClick={save} data-testid="inbox-save">Save</button>
          </div>
        )}
      </div>
      {done && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="inbox-done">{done}</p>}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="inbox-error">{error}</p>}
    </section>
  )
}
