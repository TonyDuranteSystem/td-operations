'use client'

import { useEffect } from 'react'

/**
 * Drops a 90-day first-party cookie (td_ref=<code>) so a referral can still be
 * attributed if the visitor later converts directly on our domain. Client-side
 * because a server component cannot set cookies during render and middleware.ts
 * is a protected file. Not HttpOnly — it only needs to be readable server-side
 * at conversion, and carries no sensitive data (just the public referral code).
 */
export function RefCookie({ code }: { code: string }) {
  useEffect(() => {
    const expires = new Date(Date.now() + 90 * 864e5).toUTCString()
    document.cookie = `td_ref=${encodeURIComponent(code)}; path=/; expires=${expires}; samesite=lax`
  }, [code])
  return null
}
