import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { EnvelopeList, type EnvelopeListRow } from "@/components/esign/envelope-list"

export const dynamic = "force-dynamic"

/**
 * Every staff envelope — no row cap. The old `.limit(50)` silently hid older
 * documents, including expired ones still waiting on a Reopen (td-bug
 * 2026-09-24). Tabs + search live client-side in EnvelopeList.
 */
const PAGE_SIZE = 1000
const ACCOUNT_CHUNK = 100

export default async function EsignLandingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect("/")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // Page through explicitly: PostgREST caps a single response, and a silent
  // cap is exactly the bug this page had.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envelopes: any[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("esign_envelopes")
      .select("id, document_name, status, total_signers, signed_count, created_at, expires_at, owner_account_id")
      .eq("origin", "staff")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error("[esign list] envelope query failed", error)
      break
    }
    envelopes.push(...(data ?? []))
    if (!data || data.length < PAGE_SIZE) break
  }

  // No FK from envelopes to accounts, so resolve company names separately
  // (chunked to keep the id list out of URL-length trouble).
  const accountIds = Array.from(new Set(envelopes.map(e => e.owner_account_id).filter(Boolean))) as string[]
  const companyById = new Map<string, string>()
  for (let i = 0; i < accountIds.length; i += ACCOUNT_CHUNK) {
    const { data, error } = await db
      .from("accounts")
      .select("id, company_name")
      .in("id", accountIds.slice(i, i + ACCOUNT_CHUNK))
    if (error) console.error("[esign list] account lookup failed", error)
    for (const a of data ?? []) companyById.set(a.id, a.company_name)
  }

  const rows: EnvelopeListRow[] = envelopes.map(e => ({
    id: e.id,
    document_name: e.document_name,
    status: e.status,
    total_signers: e.total_signers,
    signed_count: e.signed_count,
    created_at: e.created_at,
    expires_at: e.expires_at,
    company_name: e.owner_account_id ? companyById.get(e.owner_account_id) ?? null : null,
  }))

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
        <EnvelopeList rows={rows} />
      )}
    </div>
  )
}
