import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { EsignEditor } from "./esign-editor"

export const dynamic = "force-dynamic"

export default async function NewEsignPage({ searchParams }: { searchParams: Promise<{ account?: string; contact?: string; sd?: string; name?: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect("/")

  // Optional pre-fill when opened from a client page ("Create e-sign document").
  const sp = await searchParams
  let initialAccount: { id: string; company_name: string } | null = null
  let initialSigner: { contact_id: string; full_name: string; email: string | null; company: string | null } | null = null
  if (sp?.account) {
    const { data } = await supabase.from("accounts").select("id, company_name").eq("id", sp.account).maybeSingle()
    if (data) initialAccount = { id: data.id, company_name: data.company_name ?? "Account" }
  }
  if (sp?.contact) {
    const { data: c } = await supabase.from("contacts").select("id, full_name, email").eq("id", sp.contact).maybeSingle()
    if (c) initialSigner = { contact_id: c.id, full_name: c.full_name ?? "", email: c.email ?? null, company: initialAccount?.company_name ?? null }
  }

  // Opened from a service workspace (Company Change Name): link the envelope to that delivery so the
  // delivery moves on by itself when the client has signed. Only a delivery that exists is linked.
  let serviceDeliveryId: string | null = null
  if (sp?.sd) {
    const { data: sdRow } = await supabase.from("service_deliveries").select("id").eq("id", sp.sd).maybeSingle()
    if (sdRow) serviceDeliveryId = sdRow.id
  }
  const initialDocumentName = typeof sp?.name === "string" ? sp.name.slice(0, 200) : ""

  return (
    <div className="space-y-5 p-6 lg:p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New E-Sign envelope</h1>
          <p className="mt-1 text-sm text-muted-foreground">Upload a PDF, place fields, and get a signing link.</p>
        </div>
        <Link href="/tools/esign" className="text-sm text-blue-600 hover:underline">← E-Sign</Link>
      </div>
      <EsignEditor initialAccount={initialAccount} initialSigner={initialSigner} serviceDeliveryId={serviceDeliveryId} initialDocumentName={initialDocumentName} />
    </div>
  )
}
