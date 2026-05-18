import { notFound, redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { ServiceEditClient } from "../../service-edit-client"
import { loadServiceComplete } from "../../actions"

export const dynamic = "force-dynamic"

interface Params {
  params: { slug: string }
}

/**
 * /service-catalog/[slug]/edit — edit an existing service end-to-end.
 *
 * Loads basics + stages server-side, hands to the client editor.
 */
export default async function EditServicePage({ params }: Params) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) redirect("/")

  const { basics, stages, workflow } = await loadServiceComplete(params.slug)
  if (!basics) notFound()

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <ServiceEditClient mode="edit" initial={{ basics, stages, workflow }} />
    </div>
  )
}
