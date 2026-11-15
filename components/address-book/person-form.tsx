"use client"

/**
 * Address book — the box that saves (or changes) a person who has no place in the CRM. The type is chosen first and its boxes follow it; the always-there details
 * (name, company, job title, phones, emails, website, address, notes) are the same for every type. A person saved here is NOT a CRM contact.
 * If a phone or email is already in the CRM or already saved here, that person is shown instead of a silent duplicate; "Save anyway" is the deliberate choice.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"
import type { MatchDto, PersonRow, TypeDto } from "@/lib/address-book/people"
import { callApi, messageOf, type ApiFailure } from "@/components/address-book/api"
import { pillFor } from "@/components/address-book/colors"

interface Props {
  types: TypeDto[]
  /** the saved person being changed; null = a new person */
  editing: PersonRow | null
  onClose: () => void
  onSaved: () => Promise<void> | void
  /** a type was made from this box: the page shows it at once */
  onTypeCreated: (t: TypeDto) => void
  onOpenSaved: (id: string) => void
}

const INPUT = "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none"
const LABEL = "mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500"

function boxText(v: string | number | boolean | undefined): string {
  if (v === undefined) return ""
  if (typeof v === "boolean") return v ? "yes" : "no"
  return String(v)
}

export function PersonForm({ types, editing, onClose, onSaved, onTypeCreated, onOpenSaved }: Props) {
  const visibleTypes = useMemo(() => types.filter((t) => !t.hidden), [types])
  const detail = editing?.detail ?? null
  const [typeId, setTypeId] = useState<string | null>(editing?.typeId ?? null)
  const [fullName, setFullName] = useState(editing?.name ?? "")
  const [company, setCompany] = useState(editing?.company ?? "")
  const [jobTitle, setJobTitle] = useState(detail?.job_title ?? "")
  const [website, setWebsite] = useState(detail?.website ?? "")
  const [phones, setPhones] = useState<string[]>(detail?.phones.length ? detail.phones : [""])
  const [emails, setEmails] = useState<string[]>(detail?.emails.length ? detail.emails : [""])
  const [address, setAddress] = useState(detail?.address ?? "")
  const [notes, setNotes] = useState(detail?.notes ?? "")
  const [extra, setExtra] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(editing?.extra ?? {}).map(([k, v]) => [k, boxText(v)])))
  const [dupes, setDupes] = useState<MatchDto[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sure, setSure] = useState(false)
  const [newType, setNewType] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const type = typeId ? visibleTypes.find((t) => t.id === typeId) ?? null : null

  useEffect(() => {
    nameRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const cleanList = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean)

  const checkDupes = async () => {
    // when changing a saved person, only a phone or email that is NEW on them can be a duplicate
    const p = cleanList(phones).filter((x) => !(detail?.phones ?? []).includes(x))
    const e = cleanList(emails).filter((x) => !(detail?.emails ?? []).map((m) => m.toLowerCase()).includes(x.toLowerCase()))
    if (p.length === 0 && e.length === 0) {
      setDupes([])
      return
    }
    try {
      const r = await callApi<{ matches: MatchDto[] }>("/api/address-book/check", { method: "POST", body: { phones: p, emails: e, exceptSavedId: editing?.id } })
      setDupes(r.matches)
    } catch {
      // the check is a courtesy; the save checks again on the server
    }
  }

  const save = async () => {
    setError(null)
    if (!fullName.trim()) {
      setError("Enter the person's name.")
      return
    }
    setBusy(true)
    try {
      const body = {
        full_name: fullName,
        company,
        job_title: jobTitle,
        website,
        phones: cleanList(phones),
        emails: cleanList(emails),
        address,
        notes,
        type_entry_id: typeId,
        extra,
        force: dupes.length > 0,
      }
      if (editing) await callApi(`/api/address-book/people/${editing.id}`, { method: "PATCH", body }, "The changes could not be saved. Try again.")
      else await callApi("/api/address-book/people", { method: "POST", body }, "The person could not be saved. Try again.")
      toast.success(editing ? "Changes saved." : "Saved to the address book.")
      await onSaved()
    } catch (e) {
      const f = e as ApiFailure
      if (f.status === 409 && Array.isArray(f.data?.matches)) setDupes(f.data.matches as MatchDto[])
      setError(messageOf(e, "The person could not be saved. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!editing) return
    if (!sure) {
      setSure(true)
      setTimeout(() => setSure(false), 4000)
      return
    }
    setBusy(true)
    try {
      await callApi(`/api/address-book/people/${editing.id}`, { method: "DELETE" }, "The person could not be removed. Try again.")
      toast.success("Removed from the address book.")
      await onSaved()
    } catch (e) {
      setError(messageOf(e, "The person could not be removed. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const makeType = async () => {
    const name = (newType ?? "").trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      const r = await callApi<{ type: TypeDto }>("/api/address-book/types", { method: "POST", body: { name } }, "The type could not be made. Try again.")
      onTypeCreated(r.type)
      setTypeId(r.type.id)
      setNewType(null)
    } catch (e) {
      setError(messageOf(e, "The type could not be made. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const listField = (label: string, values: string[], set: (v: string[]) => void, placeholder: string, testId: string, inputType: string) => (
    <div>
      <label className={LABEL}>{label}</label>
      <div className="space-y-2">
        {values.map((v, i) => (
          <div key={i} className="flex gap-2">
            <input
              data-testid={`${testId}-${i}`}
              type={inputType}
              value={v}
              placeholder={placeholder}
              onChange={(e) => set(values.map((x, j) => (j === i ? e.target.value : x)))}
              onBlur={checkDupes}
              className={INPUT}
            />
            {values.length > 1 ? (
              <button type="button" aria-label={`Remove this ${label.toLowerCase()}`} onClick={() => set(values.filter((_, j) => j !== i))} className="rounded-lg border border-zinc-200 px-2 text-zinc-500 hover:bg-zinc-50">
                <X className="h-4 w-4" aria-hidden="true"></X>
              </button>
            ) : null}
          </div>
        ))}
        {values.length < 6 ? (
          <button type="button" onClick={() => set([...values, ""])} className="text-xs font-medium text-zinc-600 underline underline-offset-2">
            + another {label.toLowerCase()}
          </button>
        ) : null}
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:items-center" onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" aria-label={editing ? "Change this person" : "Save to the address book"} data-testid="person-form" className="my-4 w-full max-w-xl rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">{editing ? "Change this person" : "Save to the address book"}</h2>
            <p className="mt-0.5 text-sm text-zinc-600">{editing ? "Saved here only. Not a CRM contact." : "Not a CRM contact: this person appears only in the address book."}</p>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-zinc-500 hover:text-zinc-800">
            Close
          </button>
        </div>

        <div className="mt-4">
          <label className={LABEL}>What are they?</label>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setTypeId(null)} aria-pressed={typeId === null} className={`rounded-full px-3 py-1 text-sm ring-1 ring-inset ${typeId === null ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-200 hover:ring-zinc-400"}`}>
              No type
            </button>
            {visibleTypes.map((t) => (
              <button key={t.id} type="button" data-testid={`form-type-${t.slug}`} onClick={() => setTypeId(t.id)} aria-pressed={typeId === t.id} className={`rounded-full px-3 py-1 text-sm ring-1 ring-inset ${typeId === t.id ? "ring-2 ring-zinc-900" : "ring-zinc-200 hover:ring-zinc-400"} ${pillFor(t.color)}`}>
                {t.name}
              </button>
            ))}
            {newType === null ? (
              <button type="button" onClick={() => setNewType("")} className="rounded-full px-3 py-1 text-sm text-zinc-600 ring-1 ring-inset ring-dashed ring-zinc-300 hover:ring-zinc-500">
                + New type
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <input autoFocus value={newType} onChange={(e) => setNewType(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void makeType() } }} placeholder="Name of the type" className="w-40 rounded-full border border-zinc-300 px-3 py-1 text-sm focus:outline-none" />
                <button type="button" disabled={busy || !newType.trim()} onClick={makeType} className="rounded-full bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-40">
                  Add
                </button>
                <button type="button" onClick={() => setNewType(null)} className="text-sm text-zinc-500">
                  Cancel
                </button>
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">The extra boxes below follow the type. You choose them in Manage types.</p>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="ab-name">Full name *</label>
            <input id="ab-name" ref={nameRef} data-testid="field-name" value={fullName} onChange={(e) => setFullName(e.target.value)} className={INPUT} />
          </div>
          <div>
            <label className={LABEL} htmlFor="ab-company">Company</label>
            <input id="ab-company" data-testid="field-company" value={company} onChange={(e) => setCompany(e.target.value)} className={INPUT} />
          </div>
          <div>
            <label className={LABEL} htmlFor="ab-title">Job title</label>
            <input id="ab-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} className={INPUT} />
          </div>

          {type
            ? type.boxes.map((b) => (
                <div key={b.key}>
                  <label className={LABEL} htmlFor={`ab-box-${b.key}`}>{b.label}</label>
                  {b.kind === "yesno" ? (
                    <select id={`ab-box-${b.key}`} data-testid={`box-${b.key}`} value={extra[b.key] ?? ""} onChange={(e) => setExtra({ ...extra, [b.key]: e.target.value })} className={INPUT}>
                      <option value="">—</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  ) : (
                    <input id={`ab-box-${b.key}`} data-testid={`box-${b.key}`} type={b.kind === "date" ? "date" : "text"} inputMode={b.kind === "number" ? "decimal" : undefined} value={extra[b.key] ?? ""} onChange={(e) => setExtra({ ...extra, [b.key]: e.target.value })} className={INPUT} />
                  )}
                </div>
              ))
            : null}

          <div>{listField("Phone", phones, setPhones, "+1 555 010 0100", "field-phone", "tel")}</div>
          <div>{listField("Email", emails, setEmails, "name@example.com", "field-email", "email")}</div>
          <div>
            <label className={LABEL} htmlFor="ab-web">Website</label>
            <input id="ab-web" value={website} onChange={(e) => setWebsite(e.target.value)} className={INPUT} />
          </div>
          <div>
            <label className={LABEL} htmlFor="ab-addr">Address</label>
            <input id="ab-addr" value={address} onChange={(e) => setAddress(e.target.value)} className={INPUT} />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="ab-notes">Notes</label>
            <textarea id="ab-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth remembering" className={INPUT}></textarea>
          </div>
        </div>

        {dupes.length > 0 ? (
          <div data-testid="duplicate-box" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-semibold">Already here</div>
            <ul className="mt-1 space-y-1">
              {dupes.map((m) => (
                <li key={m.key} className="flex flex-wrap items-center gap-x-2">
                  <span>
                    {m.name} · {m.what}
                    {m.company ? ` · ${m.company}` : ""} · {m.source === "crm" ? "in the CRM" : "saved here"}
                  </span>
                  {m.href ? (
                    <Link href={m.href} target="_blank" className="font-medium underline">
                      Open that person
                    </Link>
                  ) : (
                    <button type="button" onClick={() => onOpenSaved(m.id)} className="font-medium underline">
                      Open that person
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs">Not a duplicate? Press &quot;Save anyway&quot;.</p>
          </div>
        ) : null}

        {error ? (
          <div role="alert" data-testid="form-error" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <div>
            {editing ? (
              <button type="button" disabled={busy} onClick={remove} className="rounded-lg px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-40">
                {sure ? "Click again to remove" : "Remove from the address book"}
              </button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
              Cancel
            </button>
            <button type="button" data-testid="save-person" disabled={busy} onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50">
              <Plus className="h-4 w-4" aria-hidden="true"></Plus>
              {dupes.length > 0 ? "Save anyway" : editing ? "Save changes" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
