import Link from "next/link"
import { headers } from "next/headers"
import { redirect, notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { chooseLinkBase, originFromHeaders } from "@/lib/esign/link-base"
import { CopyField } from "@/components/esign/copy-field"
import { SendButton } from "@/components/esign/send-button"
import { VoidButton } from "@/components/esign/void-button"

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

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—"
}

export default async function EsignEnvelopeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect("/")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: env } = await db.from("esign_envelopes").select("*").eq("id", id).maybeSingle()
  if (!env) notFound()
  const { data: signers } = await db.from("esign_signers").select("*").eq("envelope_id", id).order("signer_index")
  const { data: events } = await db.from("esign_events").select("event_type, ip, created_at, signer_id").eq("envelope_id", id).order("created_at")

  const h = headers()
  const base = chooseLinkBase(originFromHeaders(n => h.get(n)), process.env.VERCEL_ENV === "production")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signerRows: any[] = signers ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventRows: any[] = events ?? []

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/tools/esign" className="text-sm text-blue-600 hover:underline">← E-Sign</Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{env.document_name}</h1>
          <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[env.status] ?? "bg-zinc-100 text-zinc-600"}`}>
              {String(env.status).replace("_", " ")}
            </span>
            <span>{env.signed_count}/{env.total_signers} signed</span>
            <span>created {fmt(env.created_at)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex gap-2">
            <a href={`/api/esign/envelopes/${id}/document?type=source`} className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-zinc-50">
              Download source
            </a>
            {env.signed_pdf_path && (
              <a href={`/api/esign/envelopes/${id}/document?type=signed`} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
                Download signed PDF
              </a>
            )}
          </div>
          {["draft", "sent", "in_progress"].includes(env.status) && (
            <div className="flex flex-col items-end gap-2">
              {signerRows.some(s => s.status === "pending") && <SendButton envelopeId={id} />}
              <VoidButton envelopeId={id} />
            </div>
          )}
        </div>
      </div>

      {/* Signers */}
      <div className="rounded-lg border bg-white">
        <div className="border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Signers</div>
        <div className="divide-y">
          {signerRows.map(s => (
            <div key={s.id} className="space-y-2 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-zinc-800">
                  {s.name}{s.email ? <span className="text-zinc-400"> · {s.email}</span> : null}
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[s.status] ?? "bg-zinc-100 text-zinc-600"}`}>{s.status}</span>
              </div>
              <div className="text-xs text-zinc-500">
                {s.status === "signed"
                  ? `Signed ${fmt(s.signed_at)} · IP ${s.last_ip ?? "—"} · consent ${s.consent_acknowledged ? "accepted" : "—"}`
                  : `Viewed ${s.viewed_at ? fmt(s.viewed_at) : "never"}`}
              </div>
              {s.status !== "signed" && s.status !== "declined" && (
                <CopyField value={`${base}/sign/${s.token}/${s.access_code}`} label="Copy link" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Audit trail */}
      <div className="rounded-lg border bg-white">
        <div className="border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Audit trail</div>
        <div className="divide-y text-sm">
          {eventRows.map((e, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2">
              <span className="font-medium text-zinc-700">{e.event_type.replace("_", " ")}</span>
              <span className="text-xs text-zinc-400">{e.ip ? `${e.ip} · ` : ""}{fmt(e.created_at)}</span>
            </div>
          ))}
          {eventRows.length === 0 && <div className="px-4 py-3 text-sm text-zinc-400">No events yet.</div>}
        </div>
      </div>
    </div>
  )
}
