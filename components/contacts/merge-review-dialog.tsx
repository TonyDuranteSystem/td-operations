"use client"

/**
 * Step 2 of "Merge into another contact" (dev job 938af003, slice 1): BOTH contacts side by side, whichever contact page the
 * merge was started from. Shows which one is suggested to stay (and why) with a swap, the personal details field by field,
 * the personal documents that have no owner, and the logins of both. Nothing here writes; the merge button runs the route.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, X, GitMerge, ArrowLeftRight } from "lucide-react"
import type { MergeReport, PersonView } from "@/lib/operations/contact-merge-report"
import type { DryRunResult } from "@/lib/operations/destructive"
import { followsCopies, unresolvedIdentityConflicts, type DetailChoice } from "@/lib/contacts/merge-details"

interface Person { id: string; full_name: string | null; email: string | null }

type Loaded = { preview: DryRunResult; report: MergeReport | null }

// The same report asked for twice at once (React runs effects twice in development) is fetched once.
const inflight = new Map<string, Promise<Loaded>>()
function fetchReport(rem: string, keep: string, wantedEmail: string): Promise<Loaded> {
  const key = `${rem}|${keep}|${wantedEmail}`
  const existing = inflight.get(key)
  if (existing) return existing
  const p = (async (): Promise<Loaded> => {
    const res = await fetch("/api/crm/admin-actions/delete-contact", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: rem, dry_run: true, mode: "merge", merge_into_contact_id: keep, wanted_email: wantedEmail || undefined }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || "Could not load the merge report. Please try again.")
    return { preview: j.preview as DryRunResult, report: (j.report ?? null) as MergeReport | null }
  })().finally(() => { inflight.delete(key) })
  inflight.set(key, p)
  return p
}

function PersonCard({ p, kind }: { p: PersonView; kind: "keep" | "drop" }) {
  const working = p.logins.filter((l) => l.working).length
  return (
    <div className={`rounded-lg border p-3 text-sm ${kind === "keep" ? "border-emerald-500 bg-emerald-50" : "border-zinc-200"}`}>
      <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full mb-1 ${kind === "keep" ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-600"}`}>
        {kind === "keep" ? "Kept" : "Will be removed"}
      </span>
      <div className="font-semibold text-zinc-900">{p.fullName || "(no name)"}</div>
      <div className="text-xs text-zinc-600 break-all">{p.email || "no email"}</div>
      <div className="text-xs text-zinc-600 mt-1">{p.companies.length ? p.companies.map((c) => c.name).join(", ") : "No company"}</div>
      <div className="text-xs text-zinc-600">Login: {p.logins.length === 0 ? "none" : working === p.logins.length ? `${p.logins.length} working` : `${p.logins.length} (${working} working)`}</div>
      <div className="text-xs text-zinc-600">{p.hasStorage ? "Has a Storage folder" : "No Storage folder"} · {p.records} linked record{p.records === 1 ? "" : "s"}</div>
    </div>
  )
}

export function MergeReviewDialog({
  open, onClose, current, other, onMerged,
}: {
  open: boolean
  onClose: () => void
  /** the contact page the merge was started from */
  current: Person
  /** the contact picked in step 1 (kept by default) */
  other: Person
  onMerged: (keptId: string) => void
}) {
  const [removedId, setRemovedId] = useState(current.id)
  const [keptId, setKeptId] = useState(other.id)
  const [wanted, setWanted] = useState<string>("")
  const [data, setData] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [choices, setChoices] = useState<Record<string, DetailChoice>>({})
  const [docIds, setDocIds] = useState<Record<string, boolean>>({})
  const [typed, setTyped] = useState("")
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)

  const loadSeq = useRef(0)
  const load = useCallback(async (rem: string, keep: string, wantedEmail: string) => {
    const mine = ++loadSeq.current                       // only the newest request may change the screen
    setLoading(true); setLoadError(null); setData(null)   // never leave the old report on screen while (or after) a reload fails
    try {
      const loaded = await fetchReport(rem, keep, wantedEmail)
      if (mine !== loadSeq.current) return
      setData(loaded)
    } catch (e) {
      if (mine === loadSeq.current) setLoadError(e instanceof Error && e.message ? e.message : "Could not load the merge report. Please try again.")
    } finally { if (mine === loadSeq.current) setLoading(false) }
  }, [])

  useEffect(() => {
    if (!open) return
    setRemovedId(current.id); setKeptId(other.id); setWanted(""); setChoices({}); setDocIds({}); setTyped(""); setMergeError(null)
    load(current.id, other.id, "")
  }, [open, current.id, other.id, load])

  const report = data?.report ?? null
  const swap = () => {
    setRemovedId(keptId); setKeptId(removedId); setChoices({}); setDocIds({}); setTyped(""); setMergeError(null)
    load(keptId, removedId, wanted)
  }
  // the wanted email only changes the suggestion: the choices already made stay as they are
  const chooseWanted = (email: string) => { setWanted(email); load(removedId, keptId, email) }

  const identityMissing = useMemo(() => (report ? unresolvedIdentityConflicts(report.details, choices) : []), [report, choices])
  const selectedDocs = Object.entries(docIds).filter(([, v]) => v).map(([id]) => id)
  const blocked = !!(data?.preview.blocker) || (report?.blockers.length ?? 0) > 0
  // the report on screen must be the one for the pair about to be merged, in the same direction
  const reportMatches = !!report && report.removed.id === removedId && report.kept.id === keptId && !loadError
  const ready = reportMatches && !loading && !blocked && identityMissing.length === 0 && typed.trim().toUpperCase() === "MERGE" && !merging

  if (!open) return null

  const doMerge = async () => {
    if (!report) return
    setMerging(true); setMergeError(null)
    try {
      const res = await fetch("/api/crm/admin-actions/delete-contact", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: removedId, mode: "merge", merge_into_contact_id: keptId, field_choices: choices, document_ids: selectedDocs }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || "Merge failed — nothing was changed.")
      onMerged(keptId)
    } catch (e) {
      setMergeError(e instanceof Error && e.message ? e.message : "Merge failed — nothing was changed.")
    } finally { setMerging(false) }
  }

  const keptName = report?.kept.fullName || "the kept contact"
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Merge contacts">
          <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
            <h2 className="text-lg font-semibold flex items-center gap-2 text-zinc-900"><GitMerge className="h-5 w-5" /> Merge two contacts</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100" aria-label="Close"><X className="h-5 w-5" /></button>
          </div>

          <div className="px-6 py-4 space-y-5 overflow-y-auto text-sm">
            {loading && !report && <div className="flex items-center gap-2 text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Looking at both contacts…</div>}
            {loadError && <div className="rounded-md bg-red-50 text-red-800 px-3 py-2">{loadError}</div>}

            {report && (
              <>
                {/* 1. Who stays */}
                <section className="space-y-2">
                  <h3 className="font-semibold text-zinc-900">1. Which one stays</h3>
                  <p className="text-zinc-600">It does not matter which contact page you started from. Both are shown here.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <PersonCard p={report.kept} kind="keep" />
                    <PersonCard p={report.removed} kind="drop" />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" onClick={swap} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-md hover:bg-zinc-50 disabled:opacity-50">
                      <ArrowLeftRight className="h-3.5 w-3.5" /> Swap: keep the other one instead
                    </button>
                    {loading && <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />}
                  </div>
                  <div className="rounded-md bg-zinc-50 border px-3 py-2">
                    <div className="font-medium text-zinc-900">
                      Suggested to keep: {report.suggestion.keepId === report.kept.id ? report.kept.fullName : report.removed.fullName} ({(report.suggestion.keepId === report.kept.id ? report.kept.email : report.removed.email) || "no email"})
                      {report.suggestsSwap && <span className="ml-2 text-amber-700 font-normal">— this is the other one; press Swap to follow the suggestion</span>}
                    </div>
                    <ul className="list-disc pl-5 text-zinc-600">{report.suggestion.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                  </div>
                  <div className="text-zinc-700">
                    <div className="font-medium">Which email does the person want to use?</div>
                    <div className="flex flex-wrap gap-4 mt-1">
                      {[report.kept, report.removed].filter((p) => p.email).map((p) => (
                        <label key={p.id} className="flex items-center gap-1.5 cursor-pointer">
                          <input type="radio" name="wanted-email" disabled={loading} checked={wanted.toLowerCase() === (p.email ?? "").toLowerCase()} onChange={() => chooseWanted(p.email ?? "")} /> {p.email}
                        </label>
                      ))}
                      <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="wanted-email" disabled={loading} checked={wanted === ""} onChange={() => chooseWanted("")} /> Not sure</label>
                    </div>
                  </div>
                </section>

                {/* blockers */}
                {(report.blockers.length > 0 || data?.preview.blocker) && (
                  <div className="rounded-md bg-red-50 text-red-800 px-3 py-2 space-y-1" role="alert">
                    <div className="font-semibold">This merge cannot run yet</div>
                    {(report.blockers.length ? report.blockers : [data?.preview.blocker as string]).map((b) => <div key={b}>{b}</div>)}
                  </div>
                )}

                {/* 2. Personal details */}
                <section className="space-y-2">
                  <h3 className="font-semibold text-zinc-900">2. Personal details</h3>
                  {report.details.length === 0 ? <p className="text-zinc-600">Neither contact has personal details to compare.</p> : (
                    <>
                      <p className="text-zinc-600">Passport, ITIN and date of birth are never replaced without a choice from you. A passport expiry or ITIN date is only copied together with its own number.</p>
                      {report.details.some((r) => r.identity && r.status === "copy" && choices[r.field] !== "winner") && (
                        <p className="rounded-md bg-amber-50 text-amber-900 px-3 py-2">Passport, ITIN or date of birth of the removed contact will be copied onto the kept one. Make sure they are the same person (same name is not proof). Untick a row to leave it out.</p>
                      )}
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[520px] text-left">
                          <thead><tr className="text-xs uppercase tracking-wide text-zinc-500"><th className="py-1 pr-2">Detail</th><th className="py-1 pr-2">Kept</th><th className="py-1 pr-2">Removed</th><th className="py-1">What happens</th></tr></thead>
                          <tbody>
                            {report.details.map((r) => (
                              <tr key={r.field} className="border-t align-top">
                                <td className="py-2 pr-2">{r.label}</td>
                                <td className="py-2 pr-2 break-all">{r.kept ?? <span className="italic text-zinc-400">empty</span>}</td>
                                <td className="py-2 pr-2 break-all">{r.removed ?? <span className="italic text-zinc-400">empty</span>}</td>
                                <td className="py-2">
                                  {r.status === "same" && <span className="text-emerald-700">Same on both</span>}
                                  {r.status === "only_kept" && <span className="text-zinc-500">Kept contact already has it</span>}
                                  {r.status === "follows" && (
                                    followsCopies(report.details, r.field, choices)
                                      ? <span className="text-emerald-700">Copied with its number{r.kept ? " (replaces the kept date)" : ""}</span>
                                      : <span className="text-zinc-500">Not copied: it goes with the other number, which is not used</span>
                                  )}
                                  {r.status === "copy" && (
                                    <label className="flex items-center gap-1.5 cursor-pointer">
                                      <input type="checkbox" checked={choices[r.field] !== "winner"} onChange={(e) => setChoices((c) => ({ ...c, [r.field]: e.target.checked ? "loser" : "winner" }))} /> Copy to the kept contact
                                    </label>
                                  )}
                                  {r.status === "conflict" && (
                                    <div className="space-y-0.5">
                                      <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name={`c-${r.field}`} checked={choices[r.field] === "winner" || (!r.identity && !choices[r.field])} onChange={() => setChoices((c) => ({ ...c, [r.field]: "winner" }))} /> Keep {r.kept}</label>
                                      <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name={`c-${r.field}`} checked={choices[r.field] === "loser"} onChange={() => setChoices((c) => ({ ...c, [r.field]: "loser" }))} /> Use {r.removed}</label>
                                      {r.identity && !choices[r.field] && <span className="inline-block text-xs font-semibold text-amber-800 bg-amber-100 rounded-full px-2 py-0.5">You choose</span>}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </section>

                {/* 3. Documents */}
                <section className="space-y-2">
                  <h3 className="font-semibold text-zinc-900">3. Documents</h3>
                  {report.documents.movingFromRemoved > 0 && <p className="text-zinc-600">{report.documents.movingFromRemoved} file{report.documents.movingFromRemoved === 1 ? "" : "s"} owned by the removed contact {report.documents.movingFromRemoved === 1 ? "moves" : "move"} to {keptName} automatically.</p>}
                  {report.documents.ownerless.length === 0 ? <p className="text-zinc-600">No personal document is waiting for an owner on these contacts&apos; companies.</p> : (
                    <>
                      <p className="text-zinc-600">{report.documents.ownerless.length} personal file{report.documents.ownerless.length === 1 ? " has" : "s have"} no owner (red warning in Documents). Pick who they belong to. The tool never guesses from file names — a company with other people may hold files that are not {keptName}&apos;s.</p>
                      <button type="button" onClick={() => setDocIds(Object.fromEntries(report.documents.ownerless.map((d) => [d.id, true])))} className="px-3 py-1.5 text-xs border rounded-md hover:bg-zinc-50">
                        Give all {report.documents.ownerless.length} to {keptName}
                      </button>
                      <ul>
                        {report.documents.ownerless.map((d) => (
                          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-t py-1.5">
                            <span className="break-all">{d.fileName || "(no name)"}{d.companyName ? <span className="text-zinc-500"> · {d.companyName}</span> : null}</span>
                            <select aria-label={`Owner of ${d.fileName}`} value={docIds[d.id] ? "kept" : ""} onChange={(e) => setDocIds((m) => ({ ...m, [d.id]: e.target.value === "kept" }))} className="border rounded px-2 py-1 text-sm">
                              <option value="">No owner yet</option>
                              <option value="kept">{keptName}</option>
                            </select>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>

                {/* 4. Logins */}
                <section className="space-y-2">
                  <h3 className="font-semibold text-zinc-900">4. Logins</h3>
                  {[report.kept, report.removed].every((p) => p.logins.length === 0) ? <p className="text-zinc-600">Neither contact has a portal login.</p> : (
                    <ul>
                      {[{ p: report.kept, tag: "Kept" }, { p: report.removed, tag: "Removed with the merge" }].flatMap(({ p, tag }) => p.logins.map((l) => (
                        <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-t py-1.5">
                          <span className="break-all">{l.email ?? "(no email)"} <span className="text-zinc-500">· {l.working ? "can sign in" : "cannot sign in"}{l.lastSignInAt ? ` · last in ${new Date(l.lastSignInAt).toLocaleDateString()}` : " · never signed in"}</span></span>
                          <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${tag === "Kept" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>{tag}</span>
                        </li>
                      )))}
                    </ul>
                  )}
                  {report.removed.logins.length > 0 && !report.kept.logins.some((l) => l.working) && (
                    <p className="rounded-md bg-amber-50 text-amber-900 px-3 py-2">The kept contact has no working login, but the removed one does. The removed login will be deleted — the person will need a new login. Consider swapping.</p>
                  )}
                </section>

                {/* what happens */}
                {data?.preview.items && data.preview.items.length > 0 && (
                  <section className="space-y-1">
                    <h3 className="font-semibold text-zinc-900">What will happen</h3>
                    <ul className="list-disc pl-5 text-zinc-700">{data.preview.items.map((i) => <li key={i.label}>{i.label}</li>)}</ul>
                    {(data.preview.warnings ?? []).map((w) => <p key={w} className="text-amber-800">{w}</p>)}
                  </section>
                )}
              </>
            )}
          </div>

          <div className="px-6 py-3 border-t shrink-0 space-y-2">
            {mergeError && <div className="rounded-md bg-red-50 text-red-800 px-3 py-2 text-sm" role="alert">{mergeError}</div>}
            {identityMissing.length > 0 && <div className="text-sm text-amber-800">Choose a value for: {identityMissing.map((m) => m.label.toLowerCase()).join(", ")}.</div>}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type MERGE" aria-label="Type MERGE to confirm" className="border rounded-md px-3 py-1.5 text-sm w-32" />
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
              <button type="button" onClick={doMerge} disabled={!ready} className="px-4 py-2 text-sm rounded-md bg-red-600 text-white disabled:opacity-40 inline-flex items-center gap-2">
                {merging && <Loader2 className="h-4 w-4 animate-spin" />} Merge contacts
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
