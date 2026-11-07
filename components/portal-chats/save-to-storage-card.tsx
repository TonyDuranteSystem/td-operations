'use client'

/**
 * "Save to Storage" card — opened from a client's chat message that carries attachments (Antonio 2026-11-07, dev job fb49265a: Peter Papik sent
 * his own ITIN letter and Radomir Knapec's in one message). For EVERY attachment it shows the scan itself next to what was read from it,
 * proposes whose it is and where it goes, and saves only what staff confirm. Nothing is saved, written or sent until "Save".
 *
 *  - whose: only the member the letter NAMES is proposed (never the sender); another choice needs a tick;
 *  - what was read: the ITIN and the notice date, each with the words it came from; a value the reader is unsure about must be ticked
 *    "checked against the scan" (or edited) before it can be saved; an empty field is fine — nothing is guessed, never today's date;
 *  - the client: hidden by default (nothing sent) — or shown quietly — or shown and notified (that person only; never a chat message);
 *  - a letter an open ITIN case is waiting for is refused here (the workspace closes the case and tells the client).
 * The server re-checks everything (app/api/crm-store/save-from-chat/*).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react'
import { trapTabKey } from '@/components/storage/focus-trap'
import { CLIENT_CHOICES, defaultLetterName, type CardField, type CardItem, type CardResponse, type SaveItemResult } from '@/lib/crm-store/save-from-chat-rules'
import { blockersFor, candidateOf, crossItemBlockers, initialForm, normDigits, trustedLetterDateOfBirth, type Form } from '@/lib/crm-store/save-from-chat-card-state'

/** a file is "done" once saved with every step finished; a partly finished one (amber) can be saved again to retry */
const isDone = (r: SaveItemResult | undefined): boolean => !!r && r.ok && !r.partial

/** What the preview can show: a PDF in the viewer, a picture as a picture; anything else (a TIFF) is opened in a new tab. */
function previewKind(item: CardItem): 'pdf' | 'image' | 'none' {
  const m = (item.mimeType ?? '').toLowerCase()
  if (m === 'application/pdf') return 'pdf'
  if (/^image\/(jpeg|png|gif|webp|bmp)$/.test(m)) return 'image'
  return 'none'
}

function StatusBadge({ f, checked }: { f: CardField | null; checked?: boolean }) {
  if (!f) return null
  if (f.status === 'unsure' && checked) return <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">Checked by you</span>
  if (f.status === 'ok') return <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">Read clearly</span>
  if (f.status === 'unsure') return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">Check against the scan</span>
  return <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">Not found — type it</span>
}

function Evidence({ f }: { f: CardField | null }) {
  if (!f) return null
  return (
    <>
      {f.evidence && <p className="mt-0.5 break-words font-mono text-[10px] text-zinc-500">read from: “{f.evidence}”</p>}
      {f.note && f.status !== 'ok' && <p className="mt-0.5 text-[11px] text-amber-700">{f.note}</p>}
      {f.others.length > 0 && <p className="mt-0.5 text-[10px] text-zinc-500">also found: {f.others.join(', ')}</p>}
    </>
  )
}

function ItemSection({ item, form, setForm, locked, saving, result, resultFor }: { item: CardItem; form: Form; setForm: (f: Form) => void; locked: boolean; saving: boolean; result: SaveItemResult | undefined; resultFor: string | null }) {
  const cand = candidateOf(item, form)
  const blockers = blockersFor(item, form)
  // the year comes straight from the typed date — no time-zone maths: the renewal is June 1 of (issue year + 3)
  const renewalYear = /^\d{4}-\d{2}-\d{2}$/.test(form.issueDate) ? Number(form.issueDate.slice(0, 4)) + 3 : null
  const savedHere = cand?.alreadySaved ?? null
  // a copy saved EARLIER (when the card opened) or JUST NOW in this card (a partly finished save still leaves its file in that person's storage)
  const savedNowFor = result?.ok ? resultFor : null
  const savedElsewhere = item.candidates.filter((c) => c.contactId !== form.contactId && (c.alreadySaved || c.contactId === savedNowFor))
  // the server stopped because the ITIN is on another contact's record: the "I checked" tick belongs to the person that answer was about
  const holderAsked = !!result?.itinHeldBy && resultFor === form.contactId
  const itinTyped = form.itin.trim()
  const sameItin = !!cand?.existingItin && !!itinTyped && normDigits(cand.existingItin) === normDigits(itinTyped)
  const diffItin = !!cand?.existingItin && !!itinTyped && !sameItin
  // a held issue date also needs "replace" when the record has NO ITIN number yet (the server keeps it and says so)
  const diffDate = (!cand?.existingItin || sameItin) && !!cand?.existingIssueDate && !!form.issueDate && cand.existingIssueDate !== form.issueDate
  // while a save is running the form is frozen too: what is shown when the answer arrives must be what was sent
  const disabled = locked || saving
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch })

  return (
    <section className="rounded-lg border border-zinc-200 bg-white" data-testid={`save-card-item-${item.index}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-800">
          <input type="checkbox" checked={form.include} disabled={disabled || !item.readable} onChange={(e) => set({ include: e.target.checked })} data-testid={`save-card-include-${item.index}`} />
          <span className="break-all">{item.name}</span>
        </label>
        {item.recognized ? (
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800">IRS ITIN notice{item.noticeKind ? ` (${item.noticeKind})` : ''}</span>
        ) : item.readable ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">Not recognised as an ITIN notice</span>
        ) : null}
        {savedHere && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800" title="Tick it to save again: the file is not copied twice — only the contact's ITIN fields and the client choice are applied." data-testid={`save-card-already-${item.index}`}>Already saved for {cand?.name}</span>}
      </div>

      {!item.readable ? (
        <p className="px-3 py-3 text-sm text-zinc-600">{item.unsupportedReason ?? 'This file cannot be saved from here.'}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2">
          {/* the scan itself */}
          <div className="min-w-0">
            <div className="h-[420px] overflow-hidden rounded-md border border-zinc-200 bg-zinc-50">
              {previewKind(item) === 'image'
                // eslint-disable-next-line @next/next/no-img-element -- a staff-only preview of an attachment
                ? <img src={item.previewUrl} alt={item.name} className="h-full w-full object-contain" />
                : previewKind(item) === 'pdf'
                  ? <iframe src={item.previewUrl} title={`Preview of ${item.name}`} className="h-full w-full border-0 bg-white" data-testid={`save-card-preview-${item.index}`} />
                  : <p className="p-3 text-xs text-zinc-600" data-testid={`save-card-nopreview-${item.index}`}>This kind of file cannot be shown here. Use “Open full size in a new tab”.</p>}
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
              <a href={item.previewUrl} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">Open full size in a new tab</a>
              {item.rawText && <button type="button" className="text-blue-700 hover:underline" onClick={() => set({ showText: !form.showText })}>{form.showText ? 'Hide the text the reader saw' : 'Show the text the reader saw'}</button>}
            </div>
            {form.showText && item.rawText && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-zinc-200 bg-zinc-50 p-2 text-[10px] text-zinc-700" data-testid={`save-card-text-${item.index}`}>{item.rawText}</pre>}
          </div>

          {/* what was read, whose, where */}
          <div className={`min-w-0 space-y-3 text-sm ${form.include ? '' : 'opacity-60'}`}>
            {item.readError && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">{item.readError}</p>}
            {!item.recognized && !item.readError && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">This does not look like an IRS ITIN notice. Tick the box above only if it is one — then type the ITIN and date from the picture.</p>}

            <div>
              <label className="mb-0.5 block text-xs font-medium text-zinc-600" htmlFor={`who-${item.index}`}>Whose letter is it?</label>
              <select id={`who-${item.index}`} value={form.contactId} disabled={disabled} onChange={(e) => {
                const c = item.candidates.find((x) => x.contactId === e.target.value)
                // a new person starts clean: the "I checked" and the "replace" ticks belong to the person they were given for, and what the client is told
                // is a choice made for THAT person — back to "hidden" until it is made again
                set({ contactId: e.target.value, ownerChecked: false, replaceItin: false, holderChecked: false, client: 'hidden', ...(form.fileNameTouched || !c ? {} : { fileName: defaultLetterName(c.name, item.proposedFileName) }) })
              }} className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm" data-testid={`save-card-who-${item.index}`}>
                <option value="">Choose…</option>
                {item.candidates.map((c) => <option key={c.contactId} value={c.contactId}>{c.name}{c.namedInLetter ? ' — named on the letter' : ''}</option>)}
              </select>
              <p className="mt-0.5 text-[11px] text-zinc-500">{item.ownerReason}</p>
              {savedElsewhere.length > 0 && (
                <p className="mt-0.5 text-[11px] text-amber-700" data-testid={`save-card-elsewhere-${item.index}`}>This file is already saved for {savedElsewhere.map((c) => c.name).join(', ')}. Saving it for {cand?.name ?? 'another person'} makes a SECOND copy — if the first was a mistake, move it to the trash in Storage.</p>
              )}
              {cand && !cand.namedInLetter && (
                <label className="mt-1 flex items-start gap-1.5 text-xs text-amber-800">
                  <input type="checkbox" className="mt-0.5" checked={form.ownerChecked} disabled={disabled} onChange={(e) => set({ ownerChecked: e.target.checked })} data-testid={`save-card-owner-ok-${item.index}`} />
                  <span>I checked: this letter is {cand.name}&apos;s.</span>
                </label>
              )}
            </div>

            <div>
              <p className="text-xs font-medium text-zinc-600">Where it goes</p>
              <p className="text-sm text-zinc-800" data-testid={`save-card-place-${item.index}`}>{cand ? `${cand.name} › ITIN folder` : '—'} <span className="text-xs text-zinc-500">(the person&apos;s own storage, type “ITIN Letter”; Personal documents if that storage has no ITIN folder yet)</span></p>
              <label className="mt-1 block text-xs font-medium text-zinc-600" htmlFor={`name-${item.index}`}>File name</label>
              <input id={`name-${item.index}`} value={form.fileName} disabled={disabled} onChange={(e) => set({ fileName: e.target.value, fileNameTouched: true })} className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm" data-testid={`save-card-name-${item.index}`} />
            </div>

            <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2">
              <p className="text-xs font-semibold text-zinc-700">What was read from the letter</p>
              <div>
                <div className="flex items-center justify-between gap-2"><label className="text-xs font-medium text-zinc-600" htmlFor={`itin-${item.index}`}>ITIN</label><StatusBadge f={item.itin} checked={form.itinChecked || itinTyped !== (item.itin?.value ?? '')} /></div>
                <input id={`itin-${item.index}`} value={form.itin} disabled={disabled} onChange={(e) => set({ itin: e.target.value })} placeholder="9XX-XX-XXXX" className="w-full rounded-md border border-zinc-300 px-2 py-1.5 font-mono text-sm" data-testid={`save-card-itin-${item.index}`} />
                <Evidence f={item.itin} />
                {item.itin?.status === 'unsure' && item.itin.value === itinTyped && (
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-amber-800"><input type="checkbox" checked={form.itinChecked} disabled={disabled} onChange={(e) => set({ itinChecked: e.target.checked })} /> I checked the ITIN against the scan</label>
                )}
              </div>
              <div>
                <div className="flex items-center justify-between gap-2"><label className="text-xs font-medium text-zinc-600" htmlFor={`date-${item.index}`}>Notice date (the ITIN issue date)</label><StatusBadge f={item.noticeDate} checked={form.dateChecked || form.issueDate !== (item.noticeDate?.value ?? '')} /></div>
                <input id={`date-${item.index}`} type="date" value={form.issueDate} disabled={disabled} onChange={(e) => set({ issueDate: e.target.value })} className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm" data-testid={`save-card-date-${item.index}`} />
                <Evidence f={item.noticeDate} />
                {item.noticeDate?.status === 'unsure' && item.noticeDate.value === form.issueDate && (
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-amber-800"><input type="checkbox" checked={form.dateChecked} disabled={disabled} onChange={(e) => set({ dateChecked: e.target.checked })} data-testid={`save-card-date-ok-${item.index}`} /> I checked the notice date against the scan</label>
                )}
                {renewalYear && <p className="mt-0.5 text-[11px] text-zinc-500">Renewal date that follows: June 1, {renewalYear}</p>}
              </div>
              {item.dateOfBirth?.value && <p className="text-[11px] text-zinc-500">Date of birth on the letter: {item.dateOfBirth.value} — shown only to keep it out of the issue date; it is not saved.</p>}
              {cand && (
                <p className={`text-[11px] ${diffItin || diffDate ? 'text-amber-800' : 'text-zinc-500'}`} data-testid={`save-card-record-${item.index}`}>
                  {!cand.existingItin
                    ? `${cand.name}'s record has no ITIN yet — it will be filled in.${cand.existingIssueDate ? ` It already holds the issue date ${cand.existingIssueDate}, which is kept unless you tick “replace”.` : ''}`
                    : sameItin
                      ? `${cand.name}'s record already has this ITIN${cand.existingIssueDate ? ` (issue date ${cand.existingIssueDate})` : ''}.`
                      : `${cand.name}'s record already has a DIFFERENT ITIN (${cand.existingItin}) — it is kept unless you tick “replace”.`}
                </p>
              )}
              {holderAsked && (
                <label className="flex items-start gap-1.5 text-xs text-amber-800">
                  <input type="checkbox" className="mt-0.5" checked={form.holderChecked} disabled={disabled} onChange={(e) => set({ holderChecked: e.target.checked })} data-testid={`save-card-holder-ok-${item.index}`} />
                  <span>I checked: this ITIN really is {cand?.name ?? 'this person'}&apos;s — {result?.itinHeldBy} is the same person (two contact records).</span>
                </label>
              )}
              {(diffItin || diffDate || !!result?.keptNeedsReplace) && (
                <label className="flex items-center gap-1.5 text-xs text-amber-800"><input type="checkbox" checked={form.replaceItin} disabled={disabled} onChange={(e) => set({ replaceItin: e.target.checked })} data-testid={`save-card-replace-${item.index}`} /> Replace what the record has</label>
              )}
              {diffItin && form.replaceItin && !form.issueDate && !!cand?.existingIssueDate && (
                <p className="text-[11px] text-amber-800" data-testid={`save-card-clear-date-${item.index}`}>The old issue date ({cand.existingIssueDate}) belongs to the old ITIN, so it will be cleared. Enter the new notice date to set it instead.</p>
              )}
            </div>

            <fieldset className="space-y-1" disabled={disabled}>
              <legend className="text-xs font-medium text-zinc-600">The client</legend>
              {CLIENT_CHOICES.map((c) => (
                <label key={c.key} className="flex items-start gap-1.5 text-sm text-zinc-800">
                  <input type="radio" name={`client-${item.index}`} className="mt-1" checked={form.client === c.key} onChange={() => set({ client: c.key })} data-testid={`save-card-client-${item.index}-${c.key}`} />
                  <span>{c.label}</span>
                </label>
              ))}
              <p className="text-[11px] text-zinc-500">A chat message is never sent for a personal paper — the company chat is read by every member. A notification goes to that person only.</p>
            </fieldset>

            {blockers.length > 0 && !locked && (
              <ul className="space-y-0.5 rounded bg-red-50 p-2 text-xs text-red-700" data-testid={`save-card-blockers-${item.index}`}>
                {blockers.map((b) => <li key={b} className="flex gap-1"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> <span>{b}</span></li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className={`border-t px-3 py-2 text-xs ${!result.ok ? 'border-red-200 bg-red-50 text-red-800' : result.partial ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`} data-testid={`save-card-result-${item.index}`}>
          {result.ok ? (
            <ul className="space-y-0.5">{result.notes.map((n) => (
              <li key={n.text} className={`flex gap-1 ${n.level === 'warn' ? 'font-medium text-amber-900' : ''}`}>
                {n.level === 'warn' ? <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />} <span>{n.text}</span>
              </li>
            ))}</ul>
          ) : (
            <p className="flex gap-1"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> <span>{result.error}</span></p>
          )}
        </div>
      )}
    </section>
  )
}

export function SaveToStorageCard({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const [data, setData] = useState<CardResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forms, setForms] = useState<Record<number, Form>>({})
  const [results, setResults] = useState<Record<number, SaveItemResult>>({})
  // the person each file was LAST sent to save for (the answer in `results` is about that person, not about whoever is chosen now)
  const [resultFor, setResultFor] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const anySaved = Object.values(results).some((r) => r.ok)

  useEffect(() => {
    let live = true
    setData(null); setLoadError(null); setResults({}); setResultFor({}); setSaveError(null)
    fetch('/api/crm-store/save-from-chat/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId }) })
      .then(async (res) => {
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(d.error || 'Could not read the attachments — please try again.')
        return d as CardResponse
      })
      .then((d) => {
        if (!live) return
        setData(d)
        const f: Record<number, Form> = {}
        for (const it of d.items) f[it.index] = initialForm(it)
        setForms(f)
      })
      .catch((e) => { if (live) setLoadError(e instanceof Error && e.message ? e.message : 'Could not read the attachments — please try again.') })
    return () => { live = false }
  }, [messageId])

  useEffect(() => {
    // once anything was saved the result lines (amber warnings above all) are the only record of what happened: Escape and a click outside no longer close the card
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving && !anySaved) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving, anySaved])

  useEffect(() => { rootRef.current?.focus() }, [data])

  // a file saved with every step finished is done; one saved only in part (amber) stays ticked-able so it can be saved again to retry
  const included = useMemo(() => (data?.items ?? []).filter((it) => forms[it.index]?.include && !isDone(results[it.index])), [data, forms, results])
  const blocked = included.some((it) => blockersFor(it, forms[it.index]).length > 0)
  const crossBlockers = useMemo(() => crossItemBlockers(included, forms), [included, forms])
  const canSave = included.length > 0 && !blocked && crossBlockers.length === 0 && !saving
  // why Save is grey, said next to the button (the full list sits inside each file, which may be scrolled out of sight)
  const whyNot = useMemo(() => {
    for (const it of included) {
      const b = blockersFor(it, forms[it.index])
      if (b.length > 0) return `${it.name}: ${b[0]}`
    }
    return crossBlockers[0] ?? null
  }, [included, forms, crossBlockers])

  async function save() {
    if (!data || !canSave) return
    setSaving(true); setSaveError(null)
    try {
      const body = {
        messageId: data.messageId,
        items: included.map((it) => {
          const f = forms[it.index]
          return { index: it.index, contactId: f.contactId, fileName: f.fileName, itin: f.itin.trim() || null, issueDate: f.issueDate || null, client: f.client, replaceItin: f.replaceItin, itinHolderOk: f.holderChecked, letterDateOfBirth: trustedLetterDateOfBirth(it) }
        }),
      }
      const res = await fetch('/api/crm-store/save-from-chat/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not save — please try again.')
      const next = { ...results }
      const nextFor = { ...resultFor }
      for (const r of (d.results ?? []) as SaveItemResult[]) {
        next[r.index] = r
        nextFor[r.index] = forms[r.index]?.contactId ?? ''
      }
      setResults(next)
      setResultFor(nextFor)
    } catch (e) {
      setSaveError(e instanceof Error && e.message ? e.message : 'Could not save — please try again.')
    } finally {
      setSaving(false)
    }
  }

  const allDone = !!data && data.items.every((it) => isDone(results[it.index]) || !forms[it.index]?.include)

  return (
    <div className="fixed inset-0 z-[62] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Save to Storage" data-testid="save-to-storage-card" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving && !anySaved) onClose() }}>
      <div ref={rootRef} tabIndex={-1} onKeyDown={trapTabKey} className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-xl bg-zinc-50 shadow-xl outline-none">
        <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Save to Storage</h3>
            <p className="text-xs text-zinc-500">The files stay in the chat. Nothing is saved, written or sent until you press Save.</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {!data && !loadError && <p className="flex items-center gap-2 text-sm text-zinc-600" data-testid="save-card-loading"><Loader2 className="h-4 w-4 animate-spin" /> Reading the files…</p>}
          {loadError && <p className="rounded bg-red-50 p-3 text-sm text-red-700" data-testid="save-card-load-error">{loadError}</p>}
          {data && data.items.map((it) => (
            forms[it.index] ? <ItemSection key={it.index} item={it} form={forms[it.index]} setForm={(f) => setForms({ ...forms, [it.index]: f })} locked={isDone(results[it.index])} saving={saving} result={results[it.index]} resultFor={resultFor[it.index] ?? null} /> : null
          ))}
          {crossBlockers.length > 0 && (
            <ul className="space-y-0.5 rounded bg-red-50 p-2 text-xs text-red-700" data-testid="save-card-cross-blockers">
              {crossBlockers.map((b) => <li key={b} className="flex gap-1"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> <span>{b}</span></li>)}
            </ul>
          )}
          {saveError && <p className="rounded bg-red-50 p-3 text-sm text-red-700" data-testid="save-card-save-error">{saveError}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-200 bg-white px-4 py-3">
          {whyNot && !saving ? (
            <p id="save-card-why-not" className="text-xs text-red-700" data-testid="save-card-why-not" role="status">Cannot save yet — {whyNot}</p>
          ) : (
            <p className="text-xs text-zinc-500">{data ? (included.length > 0 ? `${included.length} file${included.length === 1 ? '' : 's'} ticked to save` : anySaved ? 'Saved.' : 'Nothing ticked yet.') : ''}</p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={saving} className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50" data-testid="save-card-close">{allDone && anySaved ? 'Done' : anySaved ? 'Close' : 'Cancel'}</button>
            {!(allDone && anySaved) && (
              <button type="button" onClick={save} disabled={!canSave} aria-describedby={whyNot && !saving ? 'save-card-why-not' : undefined} className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="save-card-save">
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save{included.length > 1 ? ` ${included.length} files` : ''}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
