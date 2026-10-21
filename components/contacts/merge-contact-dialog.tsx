"use client"

/**
 * "Delete / Merge" on a contact: step 1 picks the contact to KEEP (search by name or email; contacts sharing this one's email are
 * suggested first), step 2 is the usual confirm dialog with a plain-English preview of what moves. The merge itself runs in the
 * delete-contact route (database function merge_contacts). "Delete instead" hands over to the existing delete dialog.
 */
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, Search, X, GitMerge } from "lucide-react"
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog"

interface Candidate { id: string; full_name: string | null; email: string | null; phone: string | null }

export function MergeContactDialog({
  open, onClose, contact, onDeleteInstead,
}: {
  open: boolean
  onClose: () => void
  contact: { id: string; full_name: string | null; email: string | null }
  onDeleteInstead: () => void
}) {
  const router = useRouter()
  const [q, setQ] = useState("")
  const [results, setResults] = useState<Candidate[]>([])
  const [suggested, setSuggested] = useState<Candidate[]>([])
  const [searching, setSearching] = useState(false)
  const [target, setTarget] = useState<Candidate | null>(null)

  const search = async (term: string): Promise<Candidate[]> => {
    const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(term)}`)
    const data = await res.json().catch(() => ({}))
    return ((data.contacts ?? []) as Candidate[]).filter((c) => c.id !== contact.id)
  }

  useEffect(() => {
    if (!open) { setQ(""); setResults([]); setSuggested([]); setTarget(null); return }
    // contacts that share this one's email are almost always the real one
    if (contact.email && contact.email.length >= 2) {
      search(contact.email).then((r) => setSuggested(r.filter((c) => (c.email ?? "").toLowerCase() === contact.email!.toLowerCase()))).catch(() => setSuggested([]))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact.id])

  useEffect(() => {
    if (!open || q.trim().length < 2) { setResults([]); return }
    setSearching(true)
    const t = setTimeout(() => { search(q.trim()).then(setResults).catch(() => setResults([])).finally(() => setSearching(false)) }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open])

  if (!open) return null

  if (target) {
    return (
      <ConfirmDestructiveDialog
        open
        onClose={() => setTarget(null)}
        title="Merge contacts"
        description={`"${contact.full_name ?? "This contact"}" will be merged INTO "${target.full_name ?? "the chosen contact"}". The chosen contact is the one that stays; everything of this contact moves to it.`}
        severity="red"
        requireTypeToConfirm="MERGE"
        confirmLabel="Merge contacts"
        loadPreview={async () => {
          const res = await fetch("/api/crm/admin-actions/delete-contact", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contact_id: contact.id, dry_run: true, mode: "merge", merge_into_contact_id: target.id }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || "Could not load the merge preview")
          return data.preview
        }}
        onConfirm={async () => {
          const res = await fetch("/api/crm/admin-actions/delete-contact", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contact_id: contact.id, mode: "merge", merge_into_contact_id: target.id }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) return { success: false, error: data.error || "Merge failed — nothing was changed." }
          return { success: true, message: data.message }
        }}
        onSuccess={() => { onClose(); router.push(`/contacts/${target.id}`) }}
      />
    )
  }

  const row = (c: Candidate) => (
    <button key={c.id} type="button" onClick={() => setTarget(c)} className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 border-b last:border-b-0">
      <div className="text-sm font-medium text-zinc-900">{c.full_name || "(no name)"}</div>
      <div className="text-xs text-zinc-500">{[c.email, c.phone].filter(Boolean).join(" · ")}</div>
    </button>
  )

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
            <h2 className="text-lg font-semibold flex items-center gap-2 text-zinc-900"><GitMerge className="h-5 w-5" /> Merge into another contact</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100" aria-label="Close"><X className="h-5 w-5" /></button>
          </div>
          <div className="px-6 py-4 space-y-4 overflow-y-auto">
            <p className="text-sm text-zinc-700">
              <span className="font-medium">{contact.full_name || "This contact"}</span> will disappear into the contact you choose below.
              Choose the one that must <span className="font-medium">stay</span> (the one with the right name and the real history).
            </p>
            {suggested.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">Same email as this contact</div>
                <div className="border rounded-lg">{suggested.map(row)}</div>
              </div>
            )}
            <div>
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-2.5 text-zinc-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the contact to keep (name, email or phone)" className="w-full pl-9 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-zinc-400" autoFocus />
              </div>
              {searching && <div className="flex items-center gap-2 text-xs text-zinc-500 mt-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…</div>}
              {results.length > 0 && <div className="border rounded-lg mt-2">{results.map(row)}</div>}
              {!searching && q.trim().length >= 2 && results.length === 0 && <p className="text-xs text-zinc-500 mt-2">No other contact found.</p>}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 px-6 py-3 border-t shrink-0">
            <button type="button" onClick={onDeleteInstead} className="text-xs text-red-700 hover:underline">No duplicate? Delete this contact instead</button>
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
          </div>
        </div>
      </div>
    </>
  )
}
