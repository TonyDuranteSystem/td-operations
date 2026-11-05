/**
 * TD Social — who is the signed-in person, as the SERVER sees them (server; dev job 2072bc3e, Step 2 pull request A).
 *
 * Builds the facts the tab list needs from the session cookie and the existing guards: the login role (app_metadata only, never the
 * self-writable user_metadata), the CRM admin rule, and the Marketing membership (the Marketing guard re-reads the membership, the team's
 * status and the permissions on every call, so a paused person or team has no Marketing tab on the very next request).
 * Anything that fails to resolve counts as "no": a Marketing lookup error never grants a tab.
 */
import { createClient } from "@/lib/supabase/server"
import { getUserDisplayName, isAdmin, isStaffUser } from "@/lib/auth"
import { normalizeRole } from "@/lib/auth/role-door"
import { adminMemberContext, resolveMarketingContext } from "@/lib/marketing/guard"
import { hasPermission } from "@/lib/marketing/permissions"
import type { AppIdentity } from "@/lib/app/tabs"

export interface ResolvedAppIdentity {
  user: { id: string; email: string | null; name: string }
  identity: AppIdentity
}

async function hasMarketingChat(user: { id: string; email?: string | null }, admin: boolean, role: string): Promise<boolean> {
  try {
    // an admin works Marketing as an ACTIVE member of a team (no "View as" involved); a marketing login through its own guard; nobody else
    const g = admin
      ? await adminMemberContext({ id: user.id, email: user.email ?? null })
      : role === "marketing"
        ? await resolveMarketingContext()
        : null
    return !!g && g.ok === true && hasPermission(g.ctx.permissions, "chat")
  } catch {
    return false
  }
}

/** null = nobody is signed in. */
export async function resolveAppIdentity(): Promise<ResolvedAppIdentity | null> {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return null
  const role = normalizeRole(user.app_metadata?.role)
  const admin = isAdmin(user)
  return {
    user: { id: user.id, email: user.email ?? null, name: getUserDisplayName(user) },
    identity: {
      authRole: role,
      isAdmin: admin,
      isStaff: isStaffUser(user),
      marketingChat: await hasMarketingChat(user, admin, role),
    },
  }
}
