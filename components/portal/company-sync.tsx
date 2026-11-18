'use client'

// Keeps every open portal tab on the same company (dev job 58cb7a82; the rule and the why are in lib/portal/company-sync.ts).
// Renders nothing. A tab that hears the company changed in another tab, or comes back to the front, compares the saved company with
// the one it drew and refreshes itself at once, then says so in one line, so a half-typed message is never sent to the other company
// without the person noticing.
import { useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'
import { interpolateString } from '@/lib/template-interpolation'
import { COMPANY_SYNC_STORAGE_KEY, announceCompanyChange, companyChangedElsewhere, companySignature, wasAnnouncedHere } from '@/lib/portal/company-sync'

export function CompanySync({ selectedKey, selectedLabel }: { selectedKey: string; selectedLabel: string }) {
  const router = useRouter()
  const { t } = useLocale()
  // The saved company as it was when this tab last drew itself.
  const renderedSignature = useRef<string | null>(null)
  // Set while a refresh caused by ANOTHER tab is on its way, so the one-line notice shows for that and not for the person's own switch.
  const externalRefresh = useRef(false)
  const lastLabel = useRef(selectedLabel)

  // Every draw of the page (first load, own switch, a refresh) records what it drew with, and tells the other tabs when that is new.
  useEffect(() => {
    const now = companySignature(document.cookie)
    const first = renderedSignature.current === null
    renderedSignature.current = now
    // A tab that opens on a different company than the others (a "new message" link, a fresh sign-in) is itself a change.
    if (first) {
      try {
        const last = (localStorage.getItem(COMPANY_SYNC_STORAGE_KEY) ?? '').split('@')[0]
        if (last !== now) announceCompanyChange()
      } catch { /* storage blocked */ }
    }
  }, [selectedKey])

  const check = useCallback(() => {
    if (renderedSignature.current === null) return
    const now = companySignature(document.cookie)
    if (!companyChangedElsewhere(renderedSignature.current, now)) return
    renderedSignature.current = now // one refresh per change, even if several signals arrive together
    if (wasAnnouncedHere(now)) return // this tab made the change itself: its own refresh is already on its way
    externalRefresh.current = true
    window.setTimeout(() => { externalRefresh.current = false }, 6000)
    router.refresh()
  }, [router])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === COMPANY_SYNC_STORAGE_KEY) check() }
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check])

  // The one-line notice, only for a change that came from another tab.
  useEffect(() => {
    if (lastLabel.current === selectedLabel) return
    lastLabel.current = selectedLabel
    if (!externalRefresh.current || !selectedLabel) return
    externalRefresh.current = false
    toast.info(interpolateString(t('company.changedInAnotherTab'), { company: selectedLabel }))
  }, [selectedLabel, t])

  return null
}
