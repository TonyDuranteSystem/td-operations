import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { loadNewsAdmin } from "@/lib/marketing/news-server"
import { linkTargets } from "@/lib/marketing/news"
import { NewsAdmin } from "@/components/marketing/news-admin"

export const dynamic = "force-dynamic"

/**
 * TD Marketing — What's New, Antonio's side (dev job 9aec66fa, Addendum H): post news for the team, approve or discard the drafts the system prepared when a screen went live, and see who has read each post.
 * Only he posts. Admin only (the strict check).
 */
export default async function MarketingNewsAdminPage() {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")
  const view = await loadNewsAdmin()
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6" data-testid="news-admin-page">
      <div><h1 className="text-2xl font-semibold">What&apos;s New</h1><p className="text-sm text-slate-500">News for Rocco, Ale and the rest of the team. They see it with a number in their menu and a line at the top of their screen, and you see who has read it.</p></div>
      <NewsAdmin
        available={view.available}
        targets={linkTargets().map(t => ({ key: t.key, label: t.label }))}
        drafts={view.drafts}
        posts={view.posts.map(p => ({ id: p.id, title: p.title, body: p.body, titleIt: p.title_it, bodyIt: p.body_it, linkKey: p.link_key, audience: p.audience, status: p.status as "posted" | "withdrawn", postedAt: p.posted_at, editedAt: p.edited_at, read: p.read, total: p.total, unreadNames: p.unreadNames, readers: p.readers }))}
      />
    </div>
  )
}
