"use client"

/** Booking page — "Make a link". Who is it for, what kind of call, how long, then the live "When it gets booked, the system will:" and the link. FREE links only. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { KindDto } from "@/lib/booking/kinds-admin"
import type { PersonHit } from "@/lib/booking/person"
import type { PreviewLine } from "@/lib/booking/preview"
import type { AllQuestions } from "@/lib/booking/questions"
import { callApi, messageOf } from "@/components/booking/api"
import type { MakeAgain } from "@/components/booking/booking-workspace"
import { OFF_REASON } from "@/lib/booking/mode-text"

type MadeLink = { id: string; publicId: string; url: string; email: string | null; language: "Italian" | "English" | null }
type Preview = { ok: true; lines: PreviewLine[]; once: boolean; minutes: number; ready: boolean; template: "sales" | "plain"; autoTemplate: "sales" | "plain" } | { ok: false; errors: string[] }
type QuestionsAnswer = { questions: AllQuestions; editUrl: string }

const QUESTION_CHOICES: Array<["auto" | "full" | "short", string]> = [["auto", "Let the system decide"], ["full", "The full questions"], ["short", "Just the short note"]]

const DURATIONS: Array<[string, string]> = [["30", "30 min"], ["45", "45 min"], ["60", "1 hour"], ["90", "90 min"], ["120", "2 hours"], ["other", "Other"]]

const BADGE_CLASS: Record<string, string> = {
  Client: "bg-green-100 text-green-800",
  Lead: "bg-blue-100 text-blue-800",
  Partner: "bg-purple-100 text-purple-800",
  Contact: "bg-zinc-200 text-zinc-700",
}

function lengthWords(n: number): string {
  return n === 60 ? "1 hour" : n === 120 ? "2 hours" : `${n} minutes`
}

function parseMinutes(pick: string, other: string): number | null {
  const t = pick === "other" ? other.trim() : pick
  if (!/^\d{1,3}$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= 720 ? n : null
}

function draftTexts(url: string, language: "Italian" | "English" | null) {
  return language === "Italian"
    ? { subject: "Prenota una chiamata con Tony Durante", body: `Ecco il link per prenotare la nostra chiamata: ${url}` }
    : { subject: "Book a call with Tony Durante", body: `Here is the link to book our call: ${url}` }
}

export function LinkMaker({
  kinds,
  kindsError,
  refreshKinds,
  onMade,
  again,
  callTypesReady,
  off,
}: {
  kinds: KindDto[] | null
  kindsError: string | null
  refreshKinds: () => Promise<KindDto[]>
  onMade: () => Promise<void> | void
  again: MakeAgain | null
  callTypesReady: boolean
  /** the page is turned off: the whole maker is visibly inactive */
  off: boolean
}) {
  const [who, setWho] = useState<"old" | "new">("old")
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<PersonHit[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [picked, setPicked] = useState<{ type: "contact" | "lead"; id: string; name: string; sub: string; badge: string; suggestedKind: string } | null>(null)
  const [newName, setNewName] = useState("")
  const [newEmail, setNewEmail] = useState("")
  const [kindSlug, setKindSlug] = useState<string>("")
  const [kindHint, setKindHint] = useState<string>("")
  const [durPick, setDurPick] = useState("30")
  const [durOther, setDurOther] = useState("")
  const [firstOnly, setFirstOnly] = useState(true)
  const [questions, setQuestions] = useState<"auto" | "full" | "short">("auto")
  const [asked, setAsked] = useState<QuestionsAnswer | null>(null)
  const [askedError, setAskedError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<MadeLink | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  // new kind
  const [addingKind, setAddingKind] = useState(false)
  const [newKindName, setNewKindName] = useState("")
  const [newKindChoice, setNewKindChoice] = useState<"record" | "none">("record")
  const [kindBusy, setKindBusy] = useState(false)
  const [kindMsg, setKindMsg] = useState<string | null>(null)

  const minutes = parseMinutes(durPick, durOther)
  const standard = minutes === 30
  const effectiveFirstOnly = minutes !== null && minutes !== 30 ? true : firstOnly

  const activeKinds = useMemo(() => (kinds ?? []).filter((k) => k.status === "active"), [kinds])
  const kindOk = activeKinds.some((k) => k.slug === kindSlug && k.ready)

  const personRef = useMemo(() => {
    if (who === "old") return picked ? { type: picked.type, id: picked.id } : null
    return { type: "new" as const, name: newName, email: newEmail }
  }, [who, picked, newName, newEmail])

  // what each Calendly call type asks the booker, read from Calendly once when the maker opens
  useEffect(() => {
    let stop = false
    callApi<QuestionsAnswer>("/api/booking/questions", {}, "The booker's questions could not be read. Try again.")
      .then((r) => { if (!stop) { setAsked(r); setAskedError(null) } })
      .catch((e) => { if (!stop) setAskedError(messageOf(e, "The booker's questions could not be read. Try again.")) })
    return () => { stop = true }
  }, [])

  // search as the person types
  useEffect(() => {
    if (off || who !== "old") return
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setSearchError(null)
      return
    }
    let stop = false
    const t = setTimeout(async () => {
      try {
        const r = await callApi<{ hits: PersonHit[] }>(`/api/booking/people?q=${encodeURIComponent(q)}`, {}, "The search could not run. Try again.")
        if (!stop) { setHits(r.hits); setSearchError(null) }
      } catch (e) {
        if (!stop) setSearchError(messageOf(e, "The search could not run. Try again."))
      }
    }, 250)
    return () => { stop = true; clearTimeout(t) }
  }, [query, who, off])

  // the live preview, from the same rules the link will be made with
  useEffect(() => {
    if (off || !personRef || !kindOk || minutes === null) { setPreview(null); setPreviewError(null); return }
    let stop = false
    const t = setTimeout(async () => {
      try {
        const r = await callApi<Preview>("/api/booking/preview", { method: "POST", body: { person: personRef, kindSlug, minutes, firstBookingOnly: effectiveFirstOnly, questions } }, "The preview could not be made. Try again.")
        if (!stop) { setPreview(r); setPreviewError(null) }
      } catch (e) {
        if (!stop) { setPreview(null); setPreviewError(messageOf(e, "The preview could not be made. Try again.")) }
      }
    }, 300)
    return () => { stop = true; clearTimeout(t) }
  }, [personRef, kindSlug, kindOk, minutes, effectiveFirstOnly, questions, off])

  // a different choice means the link shown above is no longer the one on screen
  useEffect(() => { setMade(null); setError(null) }, [personRef, kindSlug, minutes, effectiveFirstOnly, questions])

  const pickPerson = (h: PersonHit) => {
    setPicked({ type: h.type, id: h.id, name: h.name, sub: h.sub, badge: h.badge, suggestedKind: h.suggestedKind })
    const suggestion = activeKinds.find((k) => k.slug === h.suggestedKind && k.ready)
    if (suggestion) {
      setKindSlug(suggestion.slug)
      setKindHint(`Suggested from the record: ${h.name} is a ${h.badge.toLowerCase()}. Change it if this call is something else.`)
    } else {
      setKindHint("")
    }
  }

  // "Make again" from Links I made: fill the form with that link's choices
  const lastAgain = useRef<number>(0)
  useEffect(() => {
    if (!again || again.nonce === lastAgain.current) return
    lastAgain.current = again.nonce
    if (again.contactId || again.leadId) {
      setWho("old")
      setPicked({ type: again.contactId ? "contact" : "lead", id: (again.contactId ?? again.leadId) as string, name: again.name ?? "Same person", sub: "", badge: again.contactId ? "Contact" : "Lead", suggestedKind: again.kindSlug ?? "" })
    } else {
      setWho("new")
      setNewName(again.name ?? "")
      setNewEmail(again.email ?? "")
    }
    if (again.kindSlug) setKindSlug(again.kindSlug)
    setKindHint("")
    const m = again.minutes ?? 30
    if (DURATIONS.some(([v]) => v === String(m))) { setDurPick(String(m)); setDurOther("") } else { setDurPick("other"); setDurOther(String(m)) }
    setFirstOnly(again.once)
    setQuestions(again.asks ?? "auto")
    document.getElementById("make")?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [again])

  const makeLink = useCallback(async () => {
    if (!personRef || !kindOk || minutes === null) return
    setMaking(true)
    setError(null)
    try {
      const r = await callApi<{ link: MadeLink }>("/api/booking/links", { method: "POST", body: { person: personRef, kindSlug, minutes, firstBookingOnly: effectiveFirstOnly, questions } }, "The link could not be made. Try again.")
      setMade(r.link)
      await onMade()
    } catch (e) {
      setError(messageOf(e, "The link could not be made. Try again."))
    } finally {
      setMaking(false)
    }
  }, [personRef, kindOk, minutes, kindSlug, effectiveFirstOnly, questions, onMade])

  const flash = (t: string) => { setCopied(t); setTimeout(() => setCopied((c) => (c === t ? null : c)), 1800) }
  const copy = async () => {
    if (!made) return
    try { await navigator.clipboard.writeText(made.url); flash("Copied") } catch { flash("Select the link and press Cmd+C") }
  }

  const saveKind = async () => {
    setKindBusy(true)
    setKindMsg(null)
    try {
      const r = await callApi<{ kind: KindDto }>("/api/booking/kinds", { method: "POST", body: { name: newKindName, choice: newKindChoice } }, "The kind could not be added. Try again.")
      await refreshKinds()
      setKindSlug(r.kind.slug)
      setKindHint("")
      setNewKindName("")
      setAddingKind(false)
    } catch (e) {
      setKindMsg(messageOf(e, "The kind could not be added. Try again."))
    } finally {
      setKindBusy(false)
    }
  }

  const changeKind = async (slug: string, body: { rename?: string; status?: "active" | "retired" }) => {
    setKindBusy(true)
    setKindMsg(null)
    try {
      await callApi(`/api/booking/kinds/${encodeURIComponent(slug)}`, { method: "PATCH", body }, "The change could not be saved. Try again.")
      await refreshKinds()
      if (body.status === "retired" && slug === kindSlug) setKindSlug("")
    } catch (e) {
      setKindMsg(messageOf(e, "The change could not be saved. Try again."))
    } finally {
      setKindBusy(false)
    }
  }

  const canMake = !off && !!personRef && kindOk && minutes !== null && !!preview && preview.ok && preview.ready && !making && callTypesReady
  const shownName = who === "old" ? picked?.name : newName.trim()
  const draft = made ? draftTexts(made.url, made.language) : null

  return (
    <section id="make" className="rounded-lg border bg-white" data-testid="link-maker">
      <div className="px-4 pt-4">
        <h2 className="text-base font-semibold">Make a link</h2>
        {off && <p className="mt-1 text-sm font-semibold text-amber-900" data-testid="maker-off">{OFF_REASON}: you can look, but a link cannot be made yet.</p>}
      </div>
      <fieldset disabled={off} className={`m-0 min-w-0 space-y-5 border-0 px-4 pb-4 pt-3 ${off ? "opacity-60" : ""}`} data-testid="maker-fieldset">
        {/* WHO */}
        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">Who is it for?</span>
          <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="Who">
            {([["old", "Someone in the system"], ["new", "Someone new"]] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={who === k} onClick={() => setWho(k)} className={`px-3 py-1.5 text-sm font-medium ${who === k ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}>{label}</button>
            ))}
          </div>
          {who === "old" ? (
            <div>
              <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clients, leads, partners…" aria-label="Search people" className="mt-2 w-full rounded-md border px-3 py-2 text-sm" data-testid="person-search" />
              {picked && (
                <p className="mt-2 text-sm" data-testid="person-picked">Chosen: <b>{picked.name}</b> <span className={`ml-1 rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE_CLASS[picked.badge] ?? BADGE_CLASS.Contact}`}>{picked.badge}</span></p>
              )}
              {searchError && <p className="mt-2 text-sm text-red-700" role="alert">{searchError}</p>}
              <div className="mt-2 grid max-h-52 gap-1 overflow-auto">
                {hits.map((h) => (
                  <button key={`${h.type}-${h.id}`} type="button" aria-pressed={picked?.id === h.id} onClick={() => pickPerson(h)} className={`flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-sm ${picked?.id === h.id ? "border-blue-500 bg-blue-500/10" : "border-transparent bg-zinc-100 hover:border-zinc-400"}`} data-testid="person-hit">
                    <span className="min-w-0"><span className="block truncate">{h.name}</span><small className="block truncate text-xs text-zinc-500">{h.sub}</small></span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE_CLASS[h.badge] ?? BADGE_CLASS.Contact}`}>{h.badge}</span>
                  </button>
                ))}
                {query.trim().length >= 2 && hits.length === 0 && !searchError && <p className="text-xs text-zinc-500">No one found. Use &quot;Someone new&quot; for a person who is not in the system.</p>}
              </div>
            </div>
          ) : (
            <div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional)" aria-label="Name" className="rounded-md border px-3 py-2 text-sm" data-testid="new-name" />
                <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email (optional)" aria-label="Email" className="rounded-md border px-3 py-2 text-sm" data-testid="new-email" />
              </div>
              <p className="mt-1.5 text-xs text-zinc-500">Leave them empty and the person types their own details when they book.</p>
            </div>
          )}
        </div>

        {/* KIND */}
        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">What kind of call?</span>
          {kindsError && <p className="text-sm text-red-700" role="alert">{kindsError}</p>}
          <div className="flex flex-wrap gap-1.5" data-testid="kinds">
            {activeKinds.map((k) => (
              <button key={k.slug} type="button" disabled={!k.ready} aria-pressed={kindSlug === k.slug} onClick={() => { setKindSlug(k.slug); setKindHint("") }} className={`rounded-full border px-3 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${kindSlug === k.slug ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500" : "hover:border-zinc-400"}`}>
                {k.name}{!k.ready && <span className="ml-1 text-xs text-amber-700">needs setup</span>}
              </button>
            ))}
            <button type="button" onClick={() => setAddingKind(true)} className="rounded-full border border-dashed px-3 py-1 text-sm font-medium text-zinc-500 hover:border-zinc-400" data-testid="add-kind">+ New kind</button>
          </div>
          <p className="mt-1.5 text-xs text-zinc-500">{kindHint || (picked && who === "old" ? "Change it if this call is something else." : "You decide what this call is. Add your own kind if none fits.")}</p>
          {addingKind && (
            <div className="mt-2 grid gap-2 rounded-md border border-dashed bg-zinc-50 p-3" data-testid="new-kind-box">
              <input type="text" value={newKindName} onChange={(e) => setNewKindName(e.target.value)} placeholder="Name of the new kind, for example Vendor" aria-label="New kind name" className="rounded-md border px-3 py-2 text-sm" />
              <label className="flex items-start gap-2 text-sm"><input type="radio" name="kr" checked={newKindChoice === "record"} onChange={() => setNewKindChoice("record")} className="mt-1" /><span>Put the booking on the person&apos;s page, or make one if they are new</span></label>
              <label className="flex items-start gap-2 text-sm"><input type="radio" name="kr" checked={newKindChoice === "none"} onChange={() => setNewKindChoice("none")} className="mt-1" /><span>Calendar only, no page</span></label>
              <div className="flex gap-2">
                <button type="button" disabled={kindBusy || !newKindName.trim()} onClick={saveKind} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Add this kind</button>
                <button type="button" onClick={() => { setAddingKind(false); setKindMsg(null) }} className="rounded-md border px-3 py-1.5 text-sm font-medium">Cancel</button>
              </div>
            </div>
          )}
          {kindMsg && <p className="mt-2 text-sm text-red-700" role="alert">{kindMsg}</p>}
          <details className="mt-2 text-sm" data-testid="edit-kinds">
            <summary className="cursor-pointer text-xs text-zinc-500">Rename or retire a kind</summary>
            <ul className="mt-2 space-y-1.5">
              {(kinds ?? []).map((k) => <KindRow key={k.slug} kind={k} busy={kindBusy} onRename={(name) => changeKind(k.slug, { rename: name })} onStatus={(status) => changeKind(k.slug, { status })} />)}
            </ul>
          </details>
        </div>

        {/* LENGTH */}
        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">How long?</span>
          <div className="flex flex-wrap gap-1.5" data-testid="durations">
            {DURATIONS.map(([v, label]) => (
              <button key={v} type="button" aria-pressed={durPick === v} onClick={() => setDurPick(v)} className={`rounded-full border px-3 py-1 text-sm font-medium ${durPick === v ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500" : "hover:border-zinc-400"}`}>{label}</button>
            ))}
          </div>
          {durPick === "other" && <input type="text" inputMode="numeric" value={durOther} onChange={(e) => setDurOther(e.target.value)} placeholder="Minutes, for example 90" aria-label="Minutes" className="mt-2 w-full rounded-md border px-3 py-2 text-sm" data-testid="minutes-other" />}
          <p className="mt-1.5 text-xs text-zinc-500">
            {minutes === null ? "Type a number of minutes from 1 to 720." : standard ? "30 minutes is the standard length. Any other length makes a one-time link." : `Made as a one-time Calendly link of ${lengthWords(minutes)}. Calendly closes it after the first booking, even if that booking is cancelled, so you would make a new link.`}
          </p>
        </div>

        {/* USE */}
        <div className="grid gap-1.5">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={effectiveFirstOnly} disabled={minutes !== 30} onChange={(e) => setFirstOnly(e.target.checked)} data-testid="first-only" /> Attach to the first booking only</label>
          <p className="text-xs text-zinc-500">
            {minutes !== 30 ? "A link with its own length is closed by Calendly after one booking." : effectiveFirstOnly ? "A standard 30-minute link cannot be closed by Calendly, so a later booking on it is saved as usual and a card asks you." : "The link stays open: every booking on it is attached the same way."} Their name and email are filled in by us when they open the link; they never appear in the link you send.
          </p>
        </div>

        {/* QUESTIONS FOR THE BOOKER */}
        <div data-testid="questions-block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-zinc-500">What is the booker asked?</span>
          <div className="flex flex-wrap gap-1.5" data-testid="question-choices">
            {QUESTION_CHOICES.map(([v, label]) => (
              <button key={v} type="button" aria-pressed={questions === v} onClick={() => setQuestions(v)} className={`rounded-full border px-3 py-1 text-sm font-medium ${questions === v ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500" : "hover:border-zinc-400"}`}>{label}</button>
            ))}
          </div>
          <QuestionsList questions={questions} preview={preview} asked={asked} askedError={askedError} />
        </div>

        {/* PREVIEW */}
        <div className="grid gap-2 rounded-lg border p-3" data-testid="preview">
          <h3 className="text-sm font-semibold">When it gets booked, the system will:</h3>
          {previewError && <p className="text-sm text-red-700" role="alert">{previewError}</p>}
          {preview && preview.ok === true && (
            <ul className="grid gap-1.5">
              {preview.lines.map((l) => (
                <li key={l.label} className="grid grid-cols-[86px_minmax(0,1fr)] gap-2.5 text-sm"><b className="pt-px text-xs font-semibold uppercase tracking-wide text-zinc-500">{l.label}</b><span>{l.text}</span></li>
              ))}
            </ul>
          )}
          {preview && preview.ok === false && <ul className="grid gap-1 text-sm text-red-700" role="alert">{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          {!preview && !previewError && <p className="text-sm text-zinc-500">{off ? "Turned off. Nothing is live yet." : !personRef ? "Choose who it is for." : !kindOk ? "Choose what kind of call it is." : minutes === null ? "Choose how long it is." : "…"}</p>}
        </div>

        {/* MAKE + THE LINK */}
        <div className="grid gap-3">
          <button type="button" disabled={!canMake} onClick={makeLink} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" data-testid="make-link">{making ? "Making…" : "Make the link"}</button>
          {error && <p className="text-sm text-red-700" role="alert" data-testid="make-error">{error}</p>}
          {made && (
            <div className="grid gap-2.5 rounded-lg bg-zinc-100 p-3.5" aria-live="polite" data-testid="made-link">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Your link</span>
              <div className="break-all text-sm font-semibold" data-testid="made-url">{made.url}</div>
              <p className="text-xs text-zinc-500">For {shownName || "someone new"} · {lengthWords(minutes ?? 30)} · {effectiveFirstOnly ? "first booking only" : "every booking"}. Nothing personal is in the link you send, only a random id.</p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={copy} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white" data-testid="copy-link">Copy link</button>
                {draft && <a href={`mailto:${made.email ?? ""}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`} className="rounded-md border bg-white px-3 py-1.5 text-sm font-medium">Email it</a>}
                {draft && <a href={`https://wa.me/?text=${encodeURIComponent(draft.body)}`} target="_blank" rel="noreferrer" className="rounded-md border bg-white px-3 py-1.5 text-sm font-medium">WhatsApp</a>}
                {copied && <span className="text-xs font-semibold text-green-700">{copied}</span>}
              </div>
            </div>
          )}
        </div>
      </fieldset>
    </section>
  )
}

/** Under the three choices: what "let the system decide" means for this person, and the questions the chosen call type asks (read from Calendly). */
function QuestionsList({ questions, preview, asked, askedError }: { questions: "auto" | "full" | "short"; preview: Preview | null; asked: QuestionsAnswer | null; askedError: string | null }) {
  const role: "sales" | "plain" | null = questions === "full" ? "sales" : questions === "short" ? "plain" : preview && preview.ok ? preview.autoTemplate : null
  const words = (r: "sales" | "plain") => (r === "sales" ? "the full questions" : "just the short note")
  const shown = role && asked ? asked.questions[role] : null
  return (
    <div className="mt-1.5 text-xs text-zinc-500" data-testid="questions-list">
      {questions === "auto" && <p>{role ? `Right now that means ${words(role)}, for this person and kind of call.` : "Choose who it is for and what kind of call it is, to see what the system would ask."}</p>}
      {questions !== "auto" && <p>You chose {words(role as "sales" | "plain")}, whoever books.</p>}
      {askedError && <p className="mt-1 text-red-700" role="alert">{askedError}</p>}
      {role && shown && shown.ok === true && (
        <div className="mt-1.5 rounded-md bg-zinc-100 p-2.5" data-testid="questions-shown">
          <p className="mb-1 font-semibold text-zinc-700">The booker will be asked{shown.callName ? ` (${shown.callName})` : ""}:</p>
          {shown.questions.length === 0 ? (
            <p>Nothing: this call type has no questions.</p>
          ) : (
            <ol className="list-decimal space-y-0.5 pl-4">
              {shown.questions.map((q) => (
                <li key={q.text} title={q.text}>{q.text.split("\n")[0]}{q.required ? <span className="ml-1 font-semibold text-zinc-700">(required)</span> : <span className="ml-1">(optional)</span>}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      {role && shown && shown.ok === false && <p className="mt-1 text-amber-800" role="status">{shown.error}</p>}
      {asked && (
        <p className="mt-1.5">
          <a href={asked.editUrl} target="_blank" rel="noreferrer" className="font-semibold text-blue-700 underline" data-testid="edit-in-calendly">Edit the questions in Calendly</a>
          {" "}— open the call type there. A change in Calendly applies to every link that uses that call type, and to the public booking page.
        </p>
      )}
    </div>
  )
}

function KindRow({ kind, busy, onRename, onStatus }: { kind: KindDto; busy: boolean; onRename: (name: string) => void; onStatus: (s: "active" | "retired") => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(kind.name)
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid="kind-row">
      {editing ? (
        <>
          <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-md border px-2 py-1 text-sm" aria-label={`New name for ${kind.name}`} />
          <button type="button" disabled={busy || !name.trim()} onClick={() => { onRename(name); setEditing(false) }} className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50">Save</button>
          <button type="button" onClick={() => { setEditing(false); setName(kind.name) }} className="rounded-md border px-2 py-1 text-xs font-medium">Cancel</button>
        </>
      ) : (
        <>
          <span className={kind.status === "retired" ? "text-zinc-400 line-through" : ""}>{kind.name}</span>
          {kind.status === "retired" && <span className="text-xs text-zinc-500">retired</span>}
          {!kind.ready && <span className="text-xs text-amber-700">needs setup</span>}
          <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded-md border px-2 py-0.5 text-xs font-medium">Rename</button>
          {kind.status === "active"
            ? <button type="button" disabled={busy} onClick={() => onStatus("retired")} className="rounded-md border px-2 py-0.5 text-xs font-medium">Retire</button>
            : <button type="button" disabled={busy} onClick={() => onStatus("active")} className="rounded-md border px-2 py-0.5 text-xs font-medium">Restore</button>}
        </>
      )}
    </li>
  )
}
