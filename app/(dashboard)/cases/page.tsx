import Link from "next/link"
import { getCaseViewRows, type CasePhase, type CaseViewRow } from "@/lib/case-view/queries"
import { RefreshCw, AlertTriangle, RotateCcw } from "lucide-react"

export const dynamic = "force-dynamic"
export const revalidate = 0

type SortKey = "last_activity_at" | "case_phase" | "overdue_invoice_count" | "company_name"
type SortDir = "asc" | "desc"

const PHASE_ORDER: Record<CasePhase, number> = {
  Offboarded: 5,
  Closure: 4,
  Formation: 1,
  Onboarding: 2,
  Active: 3,
}

const PHASE_BADGE: Record<CasePhase, string> = {
  Offboarded: "bg-zinc-100 text-zinc-500 ring-zinc-200",
  Closure: "bg-red-100 text-red-800 ring-red-200",
  Formation: "bg-violet-100 text-violet-800 ring-violet-200",
  Onboarding: "bg-sky-100 text-sky-800 ring-sky-200",
  Active: "bg-emerald-100 text-emerald-800 ring-emerald-200",
}

function daysSince(iso: string | null): string {
  if (!iso) return "—"
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (diff === 0) return "today"
  if (diff === 1) return "1d ago"
  return `${diff}d ago`
}

function SortLink({
  col,
  label,
  current,
  dir,
  phase,
  renewal,
  closure,
}: {
  col: SortKey
  label: string
  current: SortKey
  dir: SortDir
  phase: string
  renewal: string
  closure: string
}) {
  const nextDir: SortDir = current === col && dir === "asc" ? "desc" : "asc"
  const params = new URLSearchParams({ sort: col, dir: nextDir, phase, renewal, closure })
  const active = current === col
  return (
    <Link
      href={`/cases?${params}`}
      className={`inline-flex items-center gap-1 font-semibold text-xs uppercase tracking-wide hover:text-zinc-900 transition-colors ${active ? "text-zinc-900" : "text-zinc-400"}`}
    >
      {label}
      {active && <span className="text-zinc-400">{dir === "asc" ? "↑" : "↓"}</span>}
    </Link>
  )
}

export default async function CasesPage({
  searchParams,
}: {
  searchParams: {
    sort?: string
    dir?: string
    phase?: string
    renewal?: string
    closure?: string
  }
}) {
  const rows = await getCaseViewRows()

  const sortKey = (["last_activity_at", "case_phase", "overdue_invoice_count", "company_name"].includes(
    searchParams.sort ?? ""
  )
    ? searchParams.sort
    : "last_activity_at") as SortKey

  const sortDir: SortDir = searchParams.dir === "asc" ? "asc" : "desc"
  const phaseFilter = searchParams.phase ?? ""
  const renewalFilter = searchParams.renewal === "1"
  const closureFilter = searchParams.closure === "1"

  const filtered = rows.filter(r => {
    if (phaseFilter && r.case_phase !== phaseFilter) return false
    if (renewalFilter && !r.has_active_renewal) return false
    if (closureFilter && !r.has_active_closure) return false
    return true
  })

  filtered.sort((a, b) => {
    let cmp = 0
    if (sortKey === "last_activity_at") {
      const aVal = a.last_activity_at ?? ""
      const bVal = b.last_activity_at ?? ""
      cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0
    } else if (sortKey === "case_phase") {
      cmp = PHASE_ORDER[a.case_phase] - PHASE_ORDER[b.case_phase]
    } else if (sortKey === "overdue_invoice_count") {
      cmp = a.overdue_invoice_count - b.overdue_invoice_count
    } else {
      cmp = a.company_name.localeCompare(b.company_name)
    }
    return sortDir === "asc" ? cmp : -cmp
  })

  const phases: CasePhase[] = ["Active", "Formation", "Onboarding", "Closure", "Offboarded"]

  function filterHref(overrides: { phase?: string; renewal?: string; closure?: string }) {
    const p = new URLSearchParams({
      sort: sortKey,
      dir: sortDir,
      phase: phaseFilter,
      renewal: renewalFilter ? "1" : "",
      closure: closureFilter ? "1" : "",
      ...overrides,
    })
    return `/cases?${p}`
  }

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Cases</h1>
          <p className="text-sm text-zinc-500 mt-0.5">{filtered.length} account{filtered.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-500 font-medium">Phase:</span>
        <Link
          href={filterHref({ phase: "" })}
          className={`px-2.5 py-1 rounded-full ring-1 transition-colors ${!phaseFilter ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-600 ring-zinc-200 hover:ring-zinc-400"}`}
        >
          All
        </Link>
        {phases.map(p => (
          <Link
            key={p}
            href={filterHref({ phase: p })}
            className={`px-2.5 py-1 rounded-full ring-1 transition-colors ${phaseFilter === p ? `${PHASE_BADGE[p]} ring-1` : "bg-white text-zinc-600 ring-zinc-200 hover:ring-zinc-400"}`}
          >
            {p}
          </Link>
        ))}

        <span className="ml-4 text-zinc-300">|</span>

        <Link
          href={filterHref({ renewal: renewalFilter ? "" : "1" })}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ring-1 transition-colors ${renewalFilter ? "bg-amber-100 text-amber-800 ring-amber-200" : "bg-white text-zinc-600 ring-zinc-200 hover:ring-zinc-400"}`}
        >
          <RotateCcw className="h-3 w-3" />
          Renewal
        </Link>

        <Link
          href={filterHref({ closure: closureFilter ? "" : "1" })}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ring-1 transition-colors ${closureFilter ? "bg-red-100 text-red-800 ring-red-200" : "bg-white text-zinc-600 ring-zinc-200 hover:ring-zinc-400"}`}
        >
          <AlertTriangle className="h-3 w-3" />
          Closure
        </Link>

        {(phaseFilter || renewalFilter || closureFilter) && (
          <Link
            href={filterHref({ phase: "", renewal: "", closure: "" })}
            className="inline-flex items-center gap-1 px-2 py-1 text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Reset
          </Link>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50">
              <th className="px-4 py-2.5 text-left">
                <SortLink col="company_name" label="Account" current={sortKey} dir={sortDir} phase={phaseFilter} renewal={renewalFilter ? "1" : ""} closure={closureFilter ? "1" : ""} />
              </th>
              <th className="px-4 py-2.5 text-left">
                <SortLink col="case_phase" label="Phase" current={sortKey} dir={sortDir} phase={phaseFilter} renewal={renewalFilter ? "1" : ""} closure={closureFilter ? "1" : ""} />
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">
                In Phase
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Services
              </th>
              <th className="px-4 py-2.5 text-right">
                <SortLink col="overdue_invoice_count" label="Overdue" current={sortKey} dir={sortDir} phase={phaseFilter} renewal={renewalFilter ? "1" : ""} closure={closureFilter ? "1" : ""} />
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Exceptions
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Unread
              </th>
              <th className="px-4 py-2.5 text-right">
                <SortLink col="last_activity_at" label="Last Activity" current={sortKey} dir={sortDir} phase={phaseFilter} renewal={renewalFilter ? "1" : ""} closure={closureFilter ? "1" : ""} />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-zinc-400">
                  No accounts match the current filters.
                </td>
              </tr>
            )}
            {filtered.map(row => (
              <CaseRow key={row.account_id} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CaseRow({ row }: { row: CaseViewRow }) {
  return (
    <tr className="hover:bg-zinc-50 transition-colors group">
      <td className="px-4 py-3">
        <Link
          href={`/accounts/${row.account_id}`}
          className="font-medium text-zinc-900 group-hover:text-blue-700 transition-colors"
        >
          {row.company_name}
        </Link>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ring-1 ${PHASE_BADGE[row.case_phase]}`}
          >
            {row.case_phase}
          </span>
          {row.has_active_renewal && (
            <span
              title="Active renewal"
              className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200"
            >
              <RotateCcw className="h-3 w-3" />
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-zinc-500 text-xs">
        {daysSince(row.case_phase_entered_at)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-600">
        {row.active_service_count || "—"}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {row.overdue_invoice_count > 0 ? (
          <span className="font-semibold text-red-600">{row.overdue_invoice_count}</span>
        ) : (
          <span className="text-zinc-300">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {row.open_exception_count > 0 ? (
          <span className="font-semibold text-amber-600">{row.open_exception_count}</span>
        ) : (
          <span className="text-zinc-300">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {row.unread_thread_count > 0 ? (
          <span className="font-semibold text-blue-600">{row.unread_thread_count}</span>
        ) : (
          <span className="text-zinc-300">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right text-zinc-500 text-xs whitespace-nowrap">
        {daysSince(row.last_activity_at)}
      </td>
    </tr>
  )
}
