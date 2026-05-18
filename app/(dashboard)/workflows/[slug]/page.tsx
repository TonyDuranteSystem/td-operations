import { notFound, redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { getEntry } from "@/lib/catalog/framework"
import { WorkflowEditClient } from "../workflow-edit-client"

export const dynamic = "force-dynamic"

const CATALOG_ID = "task_workflows"

interface Params {
  params: { slug: string }
}

/**
 * /workflows/[slug] — edit an existing workflow.
 *
 * Loads the row server-side, renders the edit client with the row as
 * initial state. The client tracks the original `updated_at` so the
 * server action can reject stale saves (another machine wrote first).
 */
export default async function EditWorkflowPage({ params }: Params) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    redirect("/")
  }

  const entry = await getEntry(CATALOG_ID, params.slug)
  if (!entry) notFound()

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <WorkflowEditClient mode="edit" initial={entry} />
    </div>
  )
}
