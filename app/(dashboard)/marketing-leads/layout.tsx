import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { adminMemberContext } from "@/lib/marketing/guard"
import { marketingChatUnread } from "@/lib/marketing/menu-unread"
import { draftCount } from "@/lib/marketing/news-server"
import { OwnerNav } from "@/components/marketing/owner-nav"

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
  return (
    <div className="flex items-start">
      <aside className="sticky top-0 w-52 shrink-0 self-start border-r bg-white p-3" aria-label="Marketing menu">
        <p className="mb-2 px-3 text-xs uppercase tracking-wide text-slate-400">TD Marketing</p>
        <OwnerNav badges={{ messages, news }} />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
