import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { EsignEditor } from "./esign-editor"

export const dynamic = "force-dynamic"

export default async function NewEsignPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect("/")

  return (
    <div className="space-y-5 p-6 lg:p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New E-Sign envelope</h1>
          <p className="mt-1 text-sm text-muted-foreground">Upload a PDF, place fields, and get a signing link.</p>
        </div>
        <Link href="/tools/esign" className="text-sm text-blue-600 hover:underline">← E-Sign</Link>
      </div>
      <EsignEditor />
    </div>
  )
}
