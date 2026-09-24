"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { describeExpiry } from "@/lib/esign/expiry"
import { ESIGN_LIST_TABS, countByTab, filterEsignRows, type EsignListTab } from "@/lib/esign/list-filter"
import { ReopenButton } from "@/components/esign/reopen-button"

/** Only an in-flight document has a deadline worth showing. */
const ACTIVE_STATUSES = ["sent", "in_progress"]

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600",
  sent: "bg-blue-100 text-blue-700",
  in_progress: "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  voided: "bg-zinc-200 text-zinc-500",
  expired: "bg-zinc-200 text-zinc-500",
}

export interface EnvelopeListRow {
  id: string
  document_name: string | null
  status: string | null
  total_signers: number | null
  signed_count: number | null
  created_at: string | null
  expires_at: string | null
  company_name: string | null
}

export function EnvelopeList({ rows }: { rows: EnvelopeListRow[] }) {
  const [tab, setTab] = useState<EsignListTab>("action")
  const [query, setQuery] = useState("")
  const counts = useMemo(() => countByTab(rows), [rows])
  const visible = useMemo(() => filterEsignRows(rows, tab, query), [rows, tab, query])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border bg-white p-0.5">
          {ESIGN_LIST_TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded px-3 py-1.5 text-sm font-medium ${tab === t.key ? "bg-blue-600 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
            >
              {t.label} <span className={tab === t.key ? "text-blue-100" : "text-zinc-400"}>({counts[t.key]})</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search document or company…"
          className="w-full max-w-xs rounded-md border bg-white px-3 py-1.5 text-sm"
        />
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border bg-white p-10 text-center text-sm text-zinc-400">
          {query.trim() ? "No documents match your search." : "Nothing here."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">Document</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Progress</th>
                <th className="px-4 py-2.5">Deadline</th>
                <th className="px-4 py-2.5">Created</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(e => (
                <tr key={e.id} className="border-b align-top last:border-0 hover:bg-zinc-50">
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/tools/esign/${e.id}`} className="text-zinc-800 hover:text-blue-700 hover:underline">
                      {e.document_name}
                    </Link>
                    {e.company_name && <div className="text-xs font-normal text-zinc-500">{e.company_name}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[e.status ?? ""] ?? "bg-zinc-100 text-zinc-600"}`}>
                      {String(e.status).replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600">{e.signed_count}/{e.total_signers} signed</td>
                  <td className="px-4 py-2.5">
                    {ACTIVE_STATUSES.includes(e.status ?? "") ? (
                      (() => {
                        const x = describeExpiry(e.expires_at)
                        if (x.tone === "none") return <span className="text-zinc-400">—</span>
                        return (
                          <span
                            className={
                              x.tone === "warning" || x.tone === "past"
                                ? "font-medium text-amber-600"
                                : "text-zinc-500"
                            }
                          >
                            {x.short}
                          </span>
                        )
                      })()
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500">{e.created_at ? new Date(e.created_at).toLocaleDateString() : ""}</td>
                  <td className="px-4 py-2.5 text-right">
                    {/* Same button, same confirmation and client notice as the detail page. */}
                    {e.status === "expired" && <div className="flex justify-end"><ReopenButton envelopeId={e.id} /></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
