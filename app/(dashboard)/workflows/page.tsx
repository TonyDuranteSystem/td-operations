import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { listEntries } from "@/lib/catalog/framework"
import { WorkflowsListClient } from "./workflows-list-client"

export const dynamic = "force-dynamic"

const CATALOG_ID = "task_workflows"

/**
 * /workflows — Workflow Editor.
 *
 * Antonio + Luca can list, create, and edit task_workflows catalog rows
 * from the UI without writing SQL. Phase 3 ships the list view + the
 * "New Workflow" entry point; Phase 4 + 5 fill in the edit page.
 *
 * Admin-only: page redirects non-admins to the dashboard root. The
 * dashboard layout already enforces dashboard access (login required);
 * this adds the second tier (admin vs team) because workflow definitions
 * affect everyone on the team and shouldn't be edited by non-admins.
 */
export default async function WorkflowsPage() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    redirect("/")
  }

  const entries = await listEntries(CATALOG_ID, { includeDeprecated: true })

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Workflows</h1>
        <p className="text-sm text-gray-500 mt-1">
          Build, edit, and publish task workflows. Each row defines a workflow that the
          system runs when its trigger fires (a form is submitted or a service delivery
          is created). Changes affect only NEW tasks — in-flight tasks keep their
          pinned snapshot.
        </p>
      </div>
      <WorkflowsListClient entries={entries} />
    </div>
  )
}
