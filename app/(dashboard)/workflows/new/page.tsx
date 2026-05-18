import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { WorkflowEditClient } from "../workflow-edit-client"

export const dynamic = "force-dynamic"

/**
 * /workflows/new — author a brand-new workflow.
 *
 * Renders the edit client with an empty initial state. The client manages
 * the draft locally and posts to server actions on Save / Publish.
 */
export default async function NewWorkflowPage() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    redirect("/")
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <WorkflowEditClient mode="new" initial={null} />
    </div>
  )
}
