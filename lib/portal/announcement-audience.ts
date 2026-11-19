// Portal announcements can be limited to the client iPhone app (`app_only`, set in CRM Config → Announcements). The website's portal home must
// never draw those: until the app is in the store, website clients could read "Welcome to the new TD App" with nothing to download. The app's
// News list and floating banner read the full list; the website reads this filtered one.

export interface AnnouncementAudience {
  app_only?: boolean | null
}

/** The announcements the WEBSITE may draw: everything except the ones limited to the app. */
export function visibleOnWebsite<T extends AnnouncementAudience>(announcements: T[]): T[] {
  return announcements.filter(a => a.app_only !== true)
}
