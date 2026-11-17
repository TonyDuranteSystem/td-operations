"use client"

/**
 * The "Start a new company" pop-up (dev job bf9886a3) — opened from the "State refused the company name" panel of the formation
 * workspace (components/flows/start-new-company-panel.tsx), always about THAT job.
 *
 * For a company the state refused the NAME of after the company already exists: the pop-up shows which company is being
 * replaced, every consequence in plain words, and the message the client will get (in the client's language, editable).
 * Pressing the blue button is the staff member's approval of that message. The work is done by
 * app/api/crm/admin-actions/start-new-company (lib/operations/start-new-company.ts).
 *
 * The page is NOT refreshed after a press: the old job becomes cancelled, the workspace would no longer show the panel, and the
 * result (with the button to the new job) would disappear with it.
 */
import { useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react"
import { isItalian } from "@/lib/locale"
import type { ReplaceCandidate, StartNewCompanyPreview, StartNewCompanyResult } from "@/lib/operations/start-new-company"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function StartNewCompanyDialog({
  open,
  onClose,
  onDone,
  contactId,
  contactName,
  deliveryId,
}: {
  open: boolean
  onClose: () => void
  /** Called with the answer of a press that went through (finished or not), so the panel can show its result. */
  onDone?: (result: StartNewCompanyResult) => void
  contactId: string
  contactName: string
  /** The formation job being replaced: the one whose workspace this was opened from. */
  deliveryId: string
}) {
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [preview, setPreview] = useState<StartNewCompanyPreview | null>(null)
  const [candidate, setCandidate] = useState<ReplaceCandidate | null>(null)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [result, setResult] = useState<StartNewCompanyResult | null>(null)

  useEffect(() => {
    if (!open) return
    setResult(null)
    setFormError(null)
    setLoadError(null)
    setPreview(null)
    setCandidate(null)
    setLoading(true)
    fetch(`/api/crm/admin-actions/start-new-company?contact_id=${encodeURIComponent(contactId)}&delivery_id=${encodeURIComponent(deliveryId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || "Could not read this company. Please try again.")
        return data as StartNewCompanyPreview
      })
      .then((data) => {
        setPreview(data)
        const c = data.candidates.find((x) => x.deliveryId === deliveryId) ?? null
        setCandidate(c)
        if (c) setMessage(c.draftMessage)
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not read this company. Please try again."))
      .finally(() => setLoading(false))
  }, [open, contactId, deliveryId])

  if (!open) return null

  const firstName = (preview?.contact?.firstName ?? contactName).split(" ")[0]
  const language = isItalian(preview?.contact?.language) ? "Italian" : "English"
  const canSubmit = !!candidate && candidate.blockers.length === 0 && message.trim().length > 0 && !busy

  const submit = async () => {
    if (!candidate) return
    setBusy(true)
    setFormError(null)
    try {
      const res = await fetch("/api/crm/admin-actions/start-new-company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId, replace_delivery_id: candidate.deliveryId, message }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Something went wrong. Check this page before pressing again.")
      const done = data as StartNewCompanyResult
      setResult(done)
      onDone?.(done)
      if (done.finished) toast.success("New company started")
      else toast.warning("Started, but not finished — press the button again")
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Something went wrong. Check this page before pressing again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={busy ? undefined : onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[92vh] flex flex-col pointer-events-auto"
          role="dialog"
          aria-modal="true"
          aria-label={`Start a new company for ${contactName}`}
        >
          <div className="flex items-start justify-between px-6 py-4 border-b shrink-0">
            <h2 className="text-lg font-semibold text-zinc-900">Start a new company for {contactName}</h2>
            <button type="button" onClick={onClose} disabled={busy} className="p-1 rounded hover:bg-zinc-100" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-4 space-y-4 overflow-y-auto text-sm text-zinc-800">
            {loading && (
              <div className="flex items-center justify-center py-8 text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="ml-2">Reading the company…</span>
              </div>
            )}

            {loadError && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700">{loadError}</div>}

            {preview && !loading && !candidate && !result && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900">
                This formation can no longer be replaced from here: it is not open any more, it has no company, or it belongs to another person. Refresh the page and look again. If the state refused a name before the company was created, use the name check on the formation job instead.
              </div>
            )}

            {result ? (
              <ResultView result={result} />
            ) : (
              candidate && (
                <>
                  <div>
                    <div className="text-xs font-semibold text-zinc-500 mb-1.5">Company being replaced</div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5">
                      <span className="font-semibold">{candidate.companyName}</span>
                      {candidate.state ? ` · ${candidate.state}` : ""} · formation step &ldquo;{candidate.stage ?? "unknown"}&rdquo;
                      {candidate.blockers.length > 0 && (
                        <span className="mt-1.5 flex gap-1.5 items-start text-red-700">
                          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                          <span>{candidate.blockers.join(" ")}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {candidate.blockers.length === 0 && (
                    <>
                      <div className="border border-zinc-200 rounded-lg bg-zinc-50 px-4 py-3">
                        <div className="font-semibold mb-2">When you press the button</div>
                        <ol className="list-decimal pl-5 space-y-1.5">
                          <li>
                            {candidate.companyName} is cancelled: its formation job is stopped
                            {candidate.otherOpenServices.length > 0 ? `, ${plural(candidate.otherOpenServices.length, "other open service", "other open services")} (${candidate.otherOpenServices.join(", ")}) cancelled` : ""}
                            {candidate.openTodos > 0 ? `, ${plural(candidate.openTodos, "open to-do", "open to-dos")} closed` : ""}
                            {candidate.pendingDeadlines > 0 ? `, ${plural(candidate.pendingDeadlines, "upcoming deadline", "upcoming deadlines")} cancelled` : ""}
                            , and the company is marked Closed.
                            {candidate.peopleOnCompany > 1 ? ` It has ${candidate.peopleOnCompany} people on it; their portal login stays.` : ""}
                          </li>
                          <li>A new formation job opens for {firstName} on the same paid offer. Nothing is charged again. The signed offer waits for the new company, and anything bought with the formation starts again on it.</li>
                          <li>The formation wizard reopens at step 1 with the people and documents kept and the company names cleared.</li>
                          <li>The message below goes to {firstName} in the portal chat.</li>
                          {candidate.waitingPart && <li>{candidate.waitingPart}</li>}
                        </ol>
                      </div>

                      <div>
                        <label htmlFor="start-new-company-message" className="block text-xs font-semibold text-zinc-500 mb-1.5">
                          Message to the client ({language})
                        </label>
                        <textarea
                          id="start-new-company-message"
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          rows={8}
                          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-[13.5px] leading-relaxed"
                        />
                      </div>
                    </>
                  )}
                </>
              )
            )}

            {formError && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700">{formError}</div>}
          </div>

          <div className="flex justify-end gap-2 px-6 py-4 border-t shrink-0">
            {result ? (
              <>
                {result.finished && result.newDeliveryId && (
                  <Link
                    href={`/flows/${result.newDeliveryId}`}
                    className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
                    data-testid="start-new-company-open-new-job"
                  >
                    Open the new formation job →
                  </Link>
                )}
                <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-zinc-300 text-sm font-semibold hover:bg-zinc-50">
                  Close
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 rounded-lg border border-zinc-300 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSubmit}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Start new company
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function ResultView({ result }: { result: StartNewCompanyResult }) {
  return (
    <div className="space-y-3">
      {result.finished ? (
        <div className="flex items-center gap-2 font-semibold text-emerald-700">
          <CheckCircle2 className="h-5 w-5" />
          {result.resumed ? "Finished the earlier attempt." : "The new company is started."}
        </div>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-5 w-5" />
            Not finished yet.
          </div>
          <div className="mt-1">
            The old company is still open and the client has not been told, unless a line below says the message was sent. Close this window and press &ldquo;State refused the name&rdquo; again: what is already done is not repeated.
          </div>
        </div>
      )}
      <ul className="space-y-1.5">
        {result.steps.map((s, i) => (
          <li key={i} className="flex gap-2 items-start">
            {s.status === "error" ? (
              <AlertTriangle className="h-4 w-4 mt-0.5 text-red-600 shrink-0" />
            ) : s.status === "warning" ? (
              <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
            )}
            <span className={s.status === "error" ? "text-red-700" : undefined}>{s.detail}</span>
          </li>
        ))}
      </ul>
      {result.problems.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900">
          <div className="font-semibold mb-1">These steps need a person:</div>
          <ul className="list-disc pl-5 space-y-1">
            {result.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
