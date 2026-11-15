import { notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isAddressBookStaff } from "@/lib/address-book/access"
import { loadAddressBook, type AddressBookData } from "@/lib/address-book/store"
import { AddressBookApp } from "@/components/address-book/address-book-app"

/**
 * Address book (dev job 055f2400, Antonio 14 Nov 2026) — a standalone page that lists everyone the CRM already has (Contacts people and Partners, READ ONLY)
 * together with the people saved here. Any staff login (an administrator or a team login) may open it; everyone else gets the ordinary "page not found".
 * The visitor is checked FIRST, before any read. The Contacts page and the Contacts data are never touched.
 * (Tags that follow a `}` are closed with an explicit closing tag, not `/>`: the standing access scan reads `/>` after a `}` as the start of a regex and would refuse to read the file.)
 */
export const dynamic = "force-dynamic"

export default async function AddressBookPage() {
  const {
    data: { user },
  } = await createClient().auth.getUser()
  if (!isAddressBookStaff(user ?? null)) notFound()

  let data: AddressBookData | null = null
  let loadError: string | null = null
  try {
    data = await loadAddressBook()
  } catch (e) {
    console.error("[address-book] page read failed:", e instanceof Error ? e.message : e)
    loadError = "The address book could not be read just now. Reload the page in a moment."
  }

  return (
    <div data-testid="address-book-page" className="px-6 py-6 lg:px-8 lg:py-8">
      <AddressBookApp initialRows={data?.rows ?? []} initialTypes={data?.types ?? []} loadError={loadError}></AddressBookApp>
    </div>
  )
}
