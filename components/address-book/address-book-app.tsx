"use client"

/**
 * Address book — the page. Everyone the CRM already has (read only) and the people saved here, in one list, with filters that follow the types.
 * The browser holds the whole list and filters it itself, so a click is instant. Nothing here changes the Contacts data: a person saved here stays here,
 * and the type Antonio confirms for a CRM person is kept in the address book's own table.
 */
import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import { BookUser, ExternalLink, Plus, Search, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { CRM_KIND_IDS, CRM_KIND_TEXT, canRetype, type CrmKind } from "@/lib/address-book/crm-kind"
import { chipCounts, filterRows, kindText, parseFilter, type FilterId, type PersonRow, type TypeDto } from "@/lib/address-book/people"
import { callApi, messageOf } from "@/components/address-book/api"
import { CRM_PILL, pillFor } from "@/components/address-book/colors"
import { PersonForm } from "@/components/address-book/person-form"
import { TypeManager } from "@/components/address-book/type-manager"

interface Props {
  initialRows: PersonRow[]
  initialTypes: TypeDto[]
  loadError: string | null
}

const CHIP = "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors"
const CHIP_OFF = "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
const CHIP_ON = "border-zinc-900 bg-zinc-900 text-white"

function Chip({ label, count, on, onClick, warn = false, testId }: { label: string; count: number; on: boolean; onClick: () => void; warn?: boolean; testId?: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} aria-pressed={on} className={`${CHIP} ${on ? CHIP_ON : count === 0 ? "border-zinc-100 bg-white text-zinc-400" : warn ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100" : CHIP_OFF}`}>
      {label}
      <b className={`text-xs font-semibold ${on ? "text-zinc-200" : "text-zinc-500"}`}>{count}</b>
    </button>
  )
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>
}

/** The cell value of one of a type's boxes. */
function boxValue(row: PersonRow, key: string, kind: string): string {
  const v = row.extra[key]
  if (v === undefined) return "—"
  if (kind === "yesno") return v === true ? "Yes" : "No"
  return String(v)
}

type Column = { id: string; label: string }

function columnsFor(filter: FilterId, types: readonly TypeDto[]): Column[] {
  if (filter === "crm:banker" || filter === "crm:partner") {
    return [{ id: "name", label: "Name" }, { id: "company", label: "Company" }, { id: "area", label: "Service area" }, { id: "phone", label: "Phone" }, { id: "email", label: "Email" }]
  }
  if (filter.startsWith("type:")) {
    const t = types.find((x) => x.id === filter.slice(5))
    const boxes = (t?.boxes ?? []).slice(0, 2).map((b) => ({ id: `box:${b.key}`, label: b.label }))
    return [{ id: "name", label: "Name" }, { id: "company", label: "Company" }, ...boxes, { id: "phone", label: "Phone" }, { id: "email", label: "Email" }]
  }
  return [{ id: "name", label: "Name" }, { id: "what", label: "What they are" }, { id: "company", label: "Company" }, { id: "phone", label: "Phone" }, { id: "email", label: "Email" }]
}

export function AddressBookApp({ initialRows, initialTypes, loadError }: Props) {
  const [rows, setRows] = useState<PersonRow[]>(initialRows)
  const [types, setTypes] = useState<TypeDto[]>(initialTypes)
  const [filter, setFilter] = useState<FilterId>("all")
  const [query, setQuery] = useState("")
  const [view, setView] = useState<"list" | "types">("list")
  const [form, setForm] = useState<{ editing: PersonRow | null } | null>(null)
  const [crmOpen, setCrmOpen] = useState<PersonRow | null>(null)
  const [sorting, setSorting] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(loadError)

  const visibleTypes = useMemo(() => types.filter((t) => !t.hidden), [types])
  const counts = useMemo(() => chipCounts(rows), [rows])
  const shown = useMemo(() => filterRows(rows, filter, query), [rows, filter, query])
  const columns = useMemo(() => columnsFor(filter, types), [filter, types])
  const activeType = filter.startsWith("type:") ? types.find((t) => t.id === filter.slice(5)) : undefined

  const reload = useCallback(async () => {
    try {
      const d = await callApi<{ rows: PersonRow[]; types: TypeDto[] }>("/api/address-book", {}, "The address book could not be refreshed. Reload the page.")
      setRows(d.rows)
      setTypes(d.types)
      setFilter((f) => parseFilter(f, d.types))
      setError(null)
    } catch (e) {
      setError(messageOf(e, "The address book could not be refreshed. Reload the page."))
    }
  }, [])

  /** a type was made or changed in Manage types: show it at once, keeping Antonio's order */
  const applyType = useCallback((t: TypeDto) => {
    setTypes((prev) => (prev.some((x) => x.id === t.id) ? prev.map((x) => (x.id === t.id ? t : x)) : [...prev, t]).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)))
  }, [])

  const sortPerson = async (row: PersonRow, typeId: string | null) => {
    setBusyKey(row.key)
    try {
      await callApi("/api/address-book/label", { method: "POST", body: { kind: "contact", id: row.id, typeId } }, "The type could not be saved. Try again.")
      setSorting(null)
      await reload()
      toast.success(typeId ? "Saved in the address book. The Contacts page is not changed." : "Taken back.")
    } catch (e) {
      toast.error(messageOf(e, "The type could not be saved. Try again."))
    } finally {
      setBusyKey(null)
    }
  }

  const openRow = (row: PersonRow) => {
    if (row.source === "saved") setForm({ editing: row })
    else setCrmOpen(row)
  }

  const cell = (row: PersonRow, col: Column) => {
    if (col.id === "name") {
      return (
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-900">{row.name}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${row.source === "crm" ? "bg-zinc-100 text-zinc-500" : "bg-emerald-50 text-emerald-700"}`}>{row.source === "crm" ? "CRM" : "Saved here"}</span>
        </div>
      )
    }
    if (col.id === "what") {
      const type = row.typeId ? types.find((t) => t.id === row.typeId) : undefined
      const sortable = row.source === "crm" && row.crmKind !== null && canRetype(row.crmKind)
      const pill = type ? (
        <Pill className={pillFor(type.color)}>{type.name}</Pill>
      ) : row.source === "saved" ? (
        <Pill className="bg-zinc-100 text-zinc-500">No type</Pill>
      ) : row.crmKind ? (
        <Pill className={CRM_PILL[row.crmKind]}>{kindText(row, types)}</Pill>
      ) : null
      if (!sortable) return pill
      return (
        <div className="relative inline-block">
          <button type="button" data-testid="sort-person" onClick={(e) => { e.stopPropagation(); setSorting(sorting === row.key ? null : row.key) }} className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400" aria-label="What is this person?">
            {pill}
          </button>
          {sorting === row.key ? (
            <>
              <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setSorting(null) }} aria-hidden="true"></div>
              <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
                <div className="mb-2 font-semibold text-zinc-900">What is {row.name}?</div>
                {visibleTypes.length === 0 ? (
                  <p className="text-zinc-600">You have no types yet. Make one in Manage types first.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {visibleTypes.map((t) => (
                      <button key={t.id} type="button" disabled={busyKey === row.key} onClick={() => sortPerson(row, t.id)} className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ring-zinc-200 hover:ring-zinc-400 ${pillFor(t.color)} ${row.typeId === t.id ? "ring-2 ring-zinc-900" : ""}`}>
                        {t.name}
                      </button>
                    ))}
                  </div>
                )}
                {row.typeId ? (
                  <button type="button" disabled={busyKey === row.key} onClick={() => sortPerson(row, null)} className="mt-2 text-xs font-medium text-zinc-600 underline">
                    Take the type back
                  </button>
                ) : null}
                <p className="mt-2 text-xs text-zinc-500">Saved in the address book only. The Contacts page is not changed.</p>
              </div>
            </>
          ) : null}
        </div>
      )
    }
    if (col.id === "company") return row.company ?? <span className="text-zinc-400">—</span>
    if (col.id === "phone") return row.phone ?? <span className="text-zinc-400">—</span>
    if (col.id === "email") return row.email ?? <span className="text-zinc-400">—</span>
    if (col.id === "area") return row.serviceArea ?? <span className="text-zinc-400">—</span>
    if (col.id.startsWith("box:")) {
      const key = col.id.slice(4)
      const box = activeType?.boxes.find((b) => b.key === key)
      return <span>{box ? boxValue(row, key, box.kind) : "—"}</span>
    }
    return null
  }

  if (view === "types") {
    return (
      <TypeManager
        types={types}
        onBack={() => setView("list")}
        onType={applyType}
        onChanged={reload}
      ></TypeManager>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BookUser className="h-6 w-6 text-zinc-500" aria-hidden="true"></BookUser>
            Address book
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600">The people from the CRM (read only) and the people you saved here, in one list. The Contacts page is not changed by anything on this page.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" data-testid="manage-types" onClick={() => setView("types")} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50">
            <Settings2 className="h-4 w-4" aria-hidden="true"></Settings2>
            Manage types
          </button>
          <button type="button" data-testid="add-person" onClick={() => setForm({ editing: null })} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800">
            <Plus className="h-4 w-4" aria-hidden="true"></Plus>
            Add to address book
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      <div className="relative mt-5 max-w-xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true"></Search>
        <input data-testid="address-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, company, phone or email" className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none" />
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip label="Everyone" count={counts.all} on={filter === "all"} onClick={() => setFilter("all")} testId="chip-all"></Chip>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">From the CRM · read only</div>
          <div className="flex flex-wrap items-center gap-2">
            {CRM_KIND_IDS.map((k: CrmKind) => (
              <Chip key={k} label={CRM_KIND_TEXT[k].chip} count={counts.crm[k]} on={filter === `crm:${k}`} warn={k === "unsorted"} onClick={() => setFilter(`crm:${k}`)} testId={`chip-crm-${k}`}></Chip>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Saved here · your types</div>
          <div className="flex flex-wrap items-center gap-2">
            {visibleTypes.map((t) => (
              <Chip key={t.id} label={t.name} count={counts.types[t.id] ?? 0} on={filter === `type:${t.id}`} onClick={() => setFilter(`type:${t.id}`)} testId={`chip-type-${t.slug}`}></Chip>
            ))}
            {counts.savedNone > 0 ? <Chip label="No type" count={counts.savedNone} on={filter === "saved:none"} onClick={() => setFilter("saved:none")} testId="chip-saved-none"></Chip> : null}
            {visibleTypes.length === 0 && counts.savedNone === 0 ? <span className="text-sm text-zinc-500">No types yet. </span> : null}
            <button type="button" onClick={() => setView("types")} className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900">
              + Manage types
            </button>
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto rounded-lg border border-zinc-200 bg-white" data-testid="address-table">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              {columns.map((c) => (
                <th key={c.id} className="px-4 py-2 font-semibold">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {shown.map((row) => (
              <tr key={row.key} data-testid="address-row" onClick={() => openRow(row)} className="cursor-pointer hover:bg-zinc-50">
                {columns.map((c) => (
                  <td key={c.id} className="px-4 py-2 align-middle text-zinc-700">
                    {cell(row, c)}
                  </td>
                ))}
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-zinc-500">
                  {rows.length === 0 ? "Nothing here yet." : "No one matches. Clear the search or choose another filter."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-500" data-testid="address-count">
        Showing {shown.length} of {rows.length}
      </p>

      {form ? (
        <PersonForm
          types={types}
          editing={form.editing}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null)
            await reload()
          }}
          onTypeCreated={(t) => {
            applyType(t)
            void reload()
          }}
          onOpenSaved={(id) => {
            const target = rows.find((r) => r.key === `saved:${id}`)
            if (target) setForm({ editing: target })
          }}
        ></PersonForm>
      ) : null}

      {crmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setCrmOpen(null)} role="presentation">
          <div role="dialog" aria-modal="true" aria-label={crmOpen.name} className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-zinc-900">{crmOpen.name}</div>
                <div className="mt-1 text-sm text-zinc-600">{kindText(crmOpen, types)} · from the CRM, read only</div>
              </div>
              <button type="button" onClick={() => setCrmOpen(null)} className="text-sm text-zinc-500 hover:text-zinc-800">
                Close
              </button>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              {[
                ["Company", crmOpen.company],
                ["Phone", crmOpen.phone],
                ["Email", crmOpen.email],
                ["Service area", crmOpen.serviceArea],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k as string} className="flex gap-3">
                    <dt className="w-24 shrink-0 text-zinc-500">{k}</dt>
                    <dd className="text-zinc-900">{v}</dd>
                  </div>
                ))}
            </dl>
            <p className="mt-4 text-xs text-zinc-500">To change this person, open them in the CRM. Nothing is changed from the address book.</p>
            <Link href={crmOpen.key.startsWith("partner:") ? `/partners/${crmOpen.id}` : `/contacts/${crmOpen.id}`} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800">
              Open in the CRM
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true"></ExternalLink>
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  )
}
