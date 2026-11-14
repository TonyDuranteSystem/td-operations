/**
 * Which left-menu page is "lit" for the current address (dev job 45aa5872).
 *
 * Pure, so the one tricky pair is tested: Inbox and WhatsApp are the SAME page (/inbox) showing one channel each, told apart by
 * the address (`?channel=whatsapp`, or an open chat `?thread=whatsapp:…`). Everything else lights on its own path.
 */
export function inboxChannelFromParams(thread: string | null | undefined, channel: string | null | undefined): 'gmail' | 'whatsapp' {
  return channel === 'whatsapp' || (thread ?? '').startsWith('whatsapp:') ? 'whatsapp' : 'gmail'
}

export function onWhatsappView(pathname: string, search: string): boolean {
  if (pathname !== '/inbox' && !pathname.startsWith('/inbox/')) return false
  const sp = new URLSearchParams(search)
  return inboxChannelFromParams(sp.get('thread'), sp.get('channel')) === 'whatsapp'
}

export function isNavItemActive(item: { id: string; href: string }, pathname: string, search: string): boolean {
  if (item.id === 'whatsapp') return onWhatsappView(pathname, search)
  if (item.id === 'inbox') return (pathname === '/inbox' || pathname.startsWith('/inbox/')) && !onWhatsappView(pathname, search)
  // The Calendar item is lit on BOTH calendar pages (the new work list and the renewals page behind its third tab).
  if (item.id === 'calendar') {
    return pathname === '/calendar' || pathname.startsWith('/calendar/') || pathname === '/new-calendar' || pathname.startsWith('/new-calendar/')
  }
  // The Booking item holds the Leads list (its first tab) AND stays lit on a lead's own page (/leads/<id>) and on the old /leads address, so the person always sees where they are.
  if (item.id === 'booking') {
    return pathname === '/booking' || pathname.startsWith('/booking/') || pathname === '/leads' || pathname.startsWith('/leads/')
  }
  const path = item.href.split(/[?#]/)[0]
  if (path === '/') return pathname === '/'
  return pathname === path || pathname.startsWith(path + '/')
}
