import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { adminMemberContext } from "@/lib/marketing/guard"
import { marketingChatUnread } from "@/lib/marketing/menu-unread"
import { draftCount } from "@/lib/marketing/news-server"
import { VIEW_AS_COOKIE, parseViewAs } from "@/lib/marketing/view-as"
import { OwnerNav } from "@/components/marketing/owner-nav"
import { ClearViewAs } from "@/components/marketing/clear-view-as"

/**
 * TD Marketing — Antonio's section of the CRM (dev job 9aec66fa, Addendum H): his one Marketing menu on the left of every page (the same menu also frames the team screens he opens, so he never has to
 * go into Rocco's dashboard to reach one). Admin only (the strict check); each page checks again.
 */
export default async function MarketingAdminLayout({ children }: { children: React.ReactNode }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")
  // the red numbers: unread chats (when he has joined a team) and drafts waiting for his OK; a number that cannot be read is simply not shown
  const member = await adminMemberContext({ id: user.id, email: user.email })
  const [messages, news] = await Promise.all([member.ok ? marketingChatUnread(member.ctx).catch(() => 0) : 0, draftCount()])
  // his own section is HIS: a "View as" left on (it lasts 8 hours) is switched off the moment he is here, so Messages and the other team screens in his menu open as himself
  const viewingAs = parseViewAs(cookies().get(VIEW_AS_COOKIE)?.value) !== null
  return (
    <div className="flex items-start">
      {viewingAs && <ClearViewAs />}
      <aside className="sticky top-0 w-52 shrink-0 self-start border-r bg-white p-3" aria-label="Marketing menu">
        <p className="mb-2 px-3 text-xs uppercase tracking-wide text-slate-400">TD Marketing</p>
        <OwnerNav badges={{ messages, news }} />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
