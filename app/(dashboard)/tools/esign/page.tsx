import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-600",
  sent: "bg-blue-100 text-blue-700",
  in_progress: "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  voided: "bg-zinc-200 text-zinc-500",
  expired: "bg-zinc-200 text-zinc-500",
}

export default async function EsignLandingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect("/")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: envelopes } = await db
    .from("esign_envelopes")
    .select("id, document_name, status, total_signers, signed_count, created_at")
    .eq("origin", "staff")
    .order("created_at", { ascending: false })
    .limit(50)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = envelopes ?? []

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">E-Sign</h1>
          <p className="mt-1 text-sm text-muted-foreground">Send documents for signature and track their status.</p>
        </div>
        <Link href="/tools/esign/new" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          New envelope
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-white p-10 text-center text-sm text-zinc-400">
          No envelopes yet. Create your first one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="border-b bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">Document</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Progress</th>
                <th className="px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(e => (
                <tr key={e.id} className="border-b last:border-0">
                  <td className="px-4 py-2.5 font-medium text-zinc-800">{e.document_name}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[e.status] ?? "bg-zinc-100 text-zinc-600"}`}>
                      {String(e.status).replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600">{e.signed_count}/{e.total_signers} signed</td>
                  <td className="px-4 py-2.5 text-zinc-500">{e.created_at ? new Date(e.created_at).toLocaleDateString() : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
