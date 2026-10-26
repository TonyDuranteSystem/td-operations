"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export interface AddressRow { address: string; people: string[]; signature: string; connected: boolean }
export interface PersonOption { id: string; label: string }

/** CRM > Marketing > Settings > Inbox addresses (dev job 9aec66fa). Antonio adds an address (the system checks it can open it first), ticks who may open it, and can remove it. Every server answer is shown as written (R099). */
export function InboxAddresses({ teamId, rows, people }: { teamId: string; rows: AddressRow[]; people: PersonOption[] }) {
  const router = useRouter()
  const [address, setAddress] = useState("")
  const [checked, setChecked] = useState<{ address: string } | null>(null)
  const [ticks, setTicks] = useState<string[]>([])
  const [signature, setSignature] = useState("")
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
    if (d) { setDone(`${checked.address} is added. It now appears in the Inbox of the people you chose.`); setChecked(null); setAddress(""); setSignature(""); setTicks([]); router.refresh() }
  }
  async function remove(a: string) {
    const d = await call({ action: "remove", address: a }, "Could not remove the address. Please try again.")
    if (d) { setDone(`${a} is removed from the Inbox.`); router.refresh() }
  }
  async function toggle(a: AddressRow, id: string) {
    const next = a.people.includes(id) ? a.people.filter(x => x !== id) : [...a.people, id]
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
          <thead className="border-b text-xs text-slate-500"><tr><th className="py-2 pr-3">Address</th><th className="pr-3">Status</th><th className="pr-3">Who can open it (besides you and the person it belongs to)</th><th /></tr></thead>
          <tbody className="divide-y">
            {rows.map(r => (
              <tr key={r.address} data-testid="inbox-address-row">
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
              <p className="text-xs text-slate-500">You always can. The person it belongs to (the team login with this address) always can.</p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {people.map(p => <label key={p.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={ticks.includes(p.id)} onChange={() => setTicks(ticks.includes(p.id) ? ticks.filter(x => x !== p.id) : [...ticks, p.id])} data-testid={`inbox-new-person-${p.id}`} />{p.label}</label>)}
              </div>
            </div>
            <label className="block text-sm"><span className="font-medium">Signature</span> <span className="text-xs text-slate-500">(text added under every email written from this address; optional)</span>
              <textarea className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" rows={3} maxLength={600} value={signature} onChange={e => setSignature(e.target.value)} />
            </label>
            <button className={`${btn} bg-slate-900 text-white`} disabled={busy} onClick={save} data-testid="inbox-save">Save</button>
          </div>
        )}
      </div>
      {done && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="inbox-done">{done}</p>}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" data-testid="inbox-error">{error}</p>}
    </section>
  )
}
