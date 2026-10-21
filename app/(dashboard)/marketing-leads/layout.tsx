import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { MarketingNav } from "./marketing-nav"

/** TD Marketing — Antonio's section of the CRM (dev job 9aec66fa): one sub-menu above every page. Admin only (the strict check); each page checks again. */
export default async function MarketingAdminLayout({ children }: { children: React.ReactNode }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isSecureAdmin(user)) redirect("/")
  return (
    <div>
      <MarketingNav />
      {children}
    </div>
  )
}
