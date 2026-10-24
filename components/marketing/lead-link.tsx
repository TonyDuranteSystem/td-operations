'use client'

import { useLeadWindows, leadHref } from '@/components/marketing/lead-windows-host'
import type { WindowTab } from '@/lib/marketing/lead-windows'

/**
 * A lead's name or row anywhere in the workspace: a plain click opens it in a floating window on top of the screen you are on (dev job 9aec66fa). It is a real link too
 * (right-click, open in a new tab, copy the address all still work), so a click with a modifier key is left to the browser.
 */
export function LeadLink({ leadId, name, tab, className, children, testId }: { leadId: string; name: string; tab?: WindowTab; className?: string; children: React.ReactNode; testId?: string }) {
  const { open } = useLeadWindows()
  return (
    <a href={leadHref(leadId)} className={className} data-testid={testId} data-lead={leadId}
      onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); open({ id: leadId, name }, tab) }}>
      {children}
    </a>
  )
}
