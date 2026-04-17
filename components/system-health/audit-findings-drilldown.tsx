"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { AuditFinding } from "@/lib/system-health/queries"

interface Props {
  findings: AuditFinding[]
}

const SEVERITY_STYLES: Record<AuditFinding["severity"], string> = {
  P0: "bg-red-100 text-red-700 ring-1 ring-red-300",
  P1: "bg-amber-100 text-amber-700 ring-1 ring-amber-300",
  P2: "bg-zinc-100 text-zinc-700 ring-1 ring-zinc-300",
}

export function AuditFindingsDrilldown({ findings }: Props) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})

  if (findings.length === 0) {
    return (
      <p className="text-sm text-emerald-700">
        No findings on the latest audit run.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
      {findings.map((f, idx) => {
        const open = expanded[idx] ?? false
        return (
          <li key={`${f.check_name}-${idx}`} className="text-sm">
            <button
              type="button"
              onClick={() => setExpanded((s) => ({ ...s, [idx]: !s[idx] }))}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-50"
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
              )}
              <span
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ${SEVERITY_STYLES[f.severity]}`}
              >
                {f.severity}
              </span>
              <span className="font-mono text-xs text-zinc-700">{f.check_name}</span>
              <span className="ml-auto font-mono text-xs tabular-nums text-zinc-900">
                {f.records_affected}
              </span>
            </button>
            {open && (
              <div className="space-y-1 border-t border-zinc-100 bg-zinc-50 px-9 py-2 text-xs text-zinc-700">
                <div>
                  <span className="font-semibold">Table:</span>{" "}
                  <code className="text-zinc-900">{f.table_name}</code>
                </div>
                <div>
                  <span className="font-semibold">Description:</span> {f.description}
                </div>
                {f.sample_ids && (
                  <div>
                    <span className="font-semibold">Sample IDs:</span>{" "}
                    <code className="break-all text-[11px] text-zinc-900">
                      {f.sample_ids}
                    </code>
                  </div>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
