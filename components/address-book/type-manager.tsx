"use client"

/**
 * Address book — "Manage types". Antonio makes every type himself: a name, a colour, and the extra boxes that type needs (text, date, number, yes/no).
 * Nothing is built in and no box depends on another. A type is never deleted: hiding it keeps its people (they show as having no type until it is shown again).
 * Taking a box off a type does not erase what was typed in it for people already saved; the values simply stop being shown.
 */
import { useMemo, useState } from "react"
import { ArrowLeft, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { BOX_KINDS, MAX_BOXES_PER_TYPE, type BoxKind } from "@/lib/address-book/types"
import { TYPE_COLORS, type TypeColor } from "@/lib/address-book/type-colors"
import type { TypeDto } from "@/lib/address-book/people"
import { callApi, messageOf } from "@/components/address-book/api"
import { SWATCH, pillFor } from "@/components/address-book/colors"

interface Props {
  types: TypeDto[]
  onBack: () => void
  /** a type was made or changed: the list shows it at once (the answer already holds it) */
  onType: (t: TypeDto) => void
  /** people may have moved (a hidden type takes its people off it): read the whole list again in the background */
  onChanged: () => Promise<void> | void
}

interface DraftBox {
  key?: string
  label: string
  kind: BoxKind
}
interface Draft {
  id: string | "new"
  name: string
  color: TypeColor | null
  boxes: DraftBox[]
}

const KIND_TEXT: Record<BoxKind, string> = { text: "Text", date: "Date", number: "Number", yesno: "Yes / no" }
const INPUT = "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none"
const LABEL = "mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-500"

const asColor = (c: string | null): TypeColor | null => ((TYPE_COLORS as readonly string[]).includes(c ?? "") ? (c as TypeColor) : null)

function draftOf(t: TypeDto): Draft {
  return { id: t.id, name: t.name, color: asColor(t.color), boxes: t.boxes.map((b) => ({ key: b.key, label: b.label, kind: b.kind })) }
}

export function TypeManager({ types, onBack, onType, onChanged }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = useMemo(() => (draft && draft.id !== "new" ? types.find((t) => t.id === draft.id) ?? null : null), [draft, types])
  const savedDraft = selected ? JSON.stringify(draftOf(selected)) : null
  const changed = draft ? (draft.id === "new" ? true : JSON.stringify(draft) !== savedDraft) : false

  const open = (t: TypeDto) => {
    setError(null)
    setDraft(draftOf(t))
  }

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const body = { name: draft.name, color: draft.color, boxes: draft.boxes }
      if (draft.id === "new") {
        const r = await callApi<{ type: TypeDto }>("/api/address-book/types", { method: "POST", body }, "The type could not be saved. Try again.")
        onType(r.type)
        void onChanged()
        setDraft(draftOf(r.type))
        toast.success("Type made.")
      } else {
        const r = await callApi<{ type: TypeDto }>(`/api/address-book/types/${draft.id}`, { method: "PATCH", body }, "The type could not be saved. Try again.")
        onType(r.type)
        void onChanged()
        setDraft(draftOf(r.type))
        toast.success("Type saved.")
      }
    } catch (e) {
      setError(messageOf(e, "The type could not be saved. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const toggleHidden = async (t: TypeDto) => {
    setBusy(true)
    setError(null)
    try {
      const r = await callApi<{ type: TypeDto }>(`/api/address-book/types/${t.id}`, { method: "PATCH", body: { hidden: !t.hidden } }, "The type could not be changed. Try again.")
      onType(r.type)
      void onChanged()
      toast.success(t.hidden ? "Type shown again." : "Type hidden. Its people are kept.")
    } catch (e) {
      setError(messageOf(e, "The type could not be changed. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const setBox = (i: number, patch: Partial<DraftBox>) => draft && setDraft({ ...draft, boxes: draft.boxes.map((b, j) => (j === i ? { ...b, ...patch } : b)) })

  return (
    <div data-testid="type-manager">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900">
        <ArrowLeft className="h-4 w-4" aria-hidden="true"></ArrowLeft>
        Back to the address book
      </button>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Address book · Types</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-600">You make the types. Each type can have its own extra boxes. Nothing here is fixed in the program, and nothing here touches the Contacts page.</p>

      {error ? (
        <div role="alert" data-testid="type-error" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="mt-5 grid gap-5 lg:grid-cols-[18rem_1fr]">
        <div className="space-y-2">
          {types.length === 0 ? <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-600">No types yet. Make the first one: for example the kinds of people you want to keep here.</p> : null}
          {types.map((t) => (
            <button key={t.id} type="button" data-testid={`type-row-${t.slug}`} onClick={() => open(t)} className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm ${draft?.id === t.id ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 bg-white hover:bg-zinc-50"} ${t.hidden ? "opacity-60" : ""}`}>
              <span className="flex items-center gap-2">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${SWATCH[asColor(t.color) ?? "zinc"]}`}></span>
                <span className="font-medium text-zinc-900">{t.name}</span>
                {t.hidden ? <span className="text-xs text-zinc-500">hidden</span> : null}
              </span>
              <span className="text-xs text-zinc-500">{t.savedCount} saved here</span>
            </button>
          ))}
          <button type="button" data-testid="new-type" onClick={() => { setError(null); setDraft({ id: "new", name: "", color: null, boxes: [] }) }} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-500">
            <Plus className="h-4 w-4" aria-hidden="true"></Plus>
            New type
          </button>
        </div>

        {draft ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-5" data-testid="type-editor">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={LABEL} htmlFor="type-name">Name of the type</label>
                <input id="type-name" data-testid="type-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="For example Supplier" className={INPUT} />
              </div>
              <div>
                <span className={LABEL}>Colour</span>
                <div className="flex flex-wrap gap-2">
                  {TYPE_COLORS.map((c) => (
                    <button key={c} type="button" aria-label={c} aria-pressed={draft.color === c} onClick={() => setDraft({ ...draft, color: draft.color === c ? null : c })} className={`h-7 w-7 rounded-full ${SWATCH[c]} ${draft.color === c ? "ring-2 ring-zinc-900 ring-offset-2" : ""}`}></button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className={LABEL}>Extra boxes for this type</div>
              <div className="space-y-2">
                {draft.boxes.map((b, i) => (
                  <div key={b.key ?? `new-${i}`} className="flex flex-wrap items-center gap-2" data-testid="box-row">
                    <input aria-label="Name of the box" data-testid="box-label" value={b.label} onChange={(e) => setBox(i, { label: e.target.value })} placeholder="For example What they supply us" className={`${INPUT} min-w-[12rem] flex-1`} />
                    <select aria-label="What goes in the box" data-testid="box-kind" value={b.kind} disabled={!!b.key} onChange={(e) => setBox(i, { kind: e.target.value as BoxKind })} title={b.key ? "The kind of a box that exists cannot change. Remove it and add a new one." : undefined} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm disabled:bg-zinc-50 disabled:text-zinc-500">
                      {BOX_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_TEXT[k]}
                        </option>
                      ))}
                    </select>
                    <button type="button" aria-label="Remove this box" onClick={() => setDraft({ ...draft, boxes: draft.boxes.filter((_, j) => j !== i) })} className="rounded-lg border border-zinc-200 p-2 text-zinc-500 hover:bg-zinc-50">
                      <X className="h-4 w-4" aria-hidden="true"></X>
                    </button>
                  </div>
                ))}
                {draft.boxes.length < MAX_BOXES_PER_TYPE ? (
                  <button type="button" data-testid="add-box" onClick={() => setDraft({ ...draft, boxes: [...draft.boxes, { label: "", kind: "text" }] })} className="text-sm font-medium text-zinc-700 underline underline-offset-2">
                    + Add a box
                  </button>
                ) : (
                  <p className="text-xs text-zinc-500">A type can have at most {MAX_BOXES_PER_TYPE} extra boxes.</p>
                )}
              </div>
              <p className="mt-3 text-xs text-zinc-500">Name, company, job title, phone, email, website, address and notes are always there. The types add to them. Taking a box off keeps what was typed in it for people already saved; it just stops showing.</p>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
              <div>
                {selected ? (
                  <button type="button" disabled={busy} data-testid="toggle-hidden" onClick={() => toggleHidden(selected)} className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40">
                    {selected.hidden ? "Show this type again" : "Hide this type"}
                  </button>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                {selected ? <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${pillFor(draft.color)}`}>{draft.name.trim() || "Preview"}</span> : null}
                <button type="button" disabled={busy || !changed || !draft.name.trim()} data-testid="save-type" onClick={save} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40">
                  {draft.id === "new" ? "Make this type" : "Save"}
                </button>
              </div>
            </div>
            {selected?.hidden ? <p className="mt-3 text-xs text-zinc-500">This type is hidden: nobody can choose it, and its {selected.savedCount} people show as having no type until you show it again.</p> : null}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">Choose a type to change it, or make a new one.</div>
        )}
      </div>
    </div>
  )
}
