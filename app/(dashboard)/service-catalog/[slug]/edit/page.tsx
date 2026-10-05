import { createHash } from "crypto"
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

  // The editor keeps its own copy of what it loaded (the starting point it compares a save against, and the step ids
  // it knows). After a save the page re-reads the service; keying the editor on the loaded data restarts it from the
  // saved state, so a second save in the same tab compares against what is really stored (N1a C2).
  const loadedKey = createHash("sha1").update(JSON.stringify({ basics, stages, workflow })).digest("hex")

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <ServiceEditClient key={loadedKey} mode="edit" initial={{ basics, stages, workflow }} />
    </div>
  )
}
