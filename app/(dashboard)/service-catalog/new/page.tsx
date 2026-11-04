import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { ServiceEditClient } from "../service-edit-client"
import { loadWaitKinds } from "@/lib/services/wait-kinds-load"

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
  if (!user) redirect("/")
  if (!isAdmin(user)) {
    // The offer builder links here ("Add a new service"). Someone who cannot add services gets a plain answer, not the home screen.
    return (
      <div className="p-6 max-w-xl mx-auto">
        <h1 className="text-lg font-semibold">Only an administrator can add a service</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Ask Antonio or Jodi to add it, then go back to your offer. The offer you were building is still open in the other tab.
        </p>
      </div>
    )
  }
  const { kinds } = await loadWaitKinds()

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <ServiceEditClient mode="new" waitKinds={kinds} initial={null} />
    </div>
  )
}
