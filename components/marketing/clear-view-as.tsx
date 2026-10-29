'use client'

import { useEffect } from 'react'

/**
 * TD Marketing — "View as" ends by itself when Antonio opens his OWN Marketing section (dev job 9aec66fa, 29 Oct 2026: "I click View as Setter, go back to my dashboard, click Messages and I see the setter's messages").
 * The View-as choice is a cookie that lasts 8 hours and was cleared only by the Exit button, so leaving by any other door left every team screen he opened afterwards "as the setter". This sits in his CRM Marketing
 * layout, which only renders when the cookie is on, and switches it off. It renders nothing.
 */
export function ClearViewAs() {
  useEffect(() => { fetch('/api/marketing-admin/view-as', { method: 'DELETE' }).catch(() => null) }, [])
  return null
}
