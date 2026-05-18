import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { ServiceEditClient } from "../service-edit-client"

export const dynamic = "force-dynamic"

/**
 * /service-catalog/new — author a brand-new service end-to-end.
 *
 * Same client as /service-catalog/[slug]/edit but with empty initial state.
 * One scrollable page: Basics + Stages + Workflow steps + Save.
 */
export default async function NewServicePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) redirect("/")

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <ServiceEditClient mode="new" initial={null} />
    </div>
  )
}
