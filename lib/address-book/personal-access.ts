/**
 * Who may open the Personal book: ONE login, the primary owner (Antonio). Not the other owners (NEXT_PUBLIC_EXTRA_OWNER_EMAILS), not admins, not the team.
 * Every read and write of address_book_personal goes through personalOwnerId(); a row is only ever matched on owner_user_id = that id.
 * Pure. The Personal book is also switched off while the key is missing (lib/address-book/crypto.ts personalSecretFromEnv).
 */
import { PRIMARY_OWNER_EMAIL } from "@/lib/auth"

export interface PersonalUserLike {
  id?: string | null
  email?: string | null
}

export function canUsePersonalBook(user: PersonalUserLike | null | undefined): boolean {
  if (!user?.id) return false
  return (user.email ?? "").trim().toLowerCase() === PRIMARY_OWNER_EMAIL.toLowerCase()
}

/** The id to scope every Personal query to, or null when this login may not use the book. */
export function personalOwnerId(user: PersonalUserLike | null | undefined): string | null {
  return canUsePersonalBook(user) ? (user!.id as string) : null
}
