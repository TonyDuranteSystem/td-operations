// What the TD Social phone app's own version tells the web screens (the version rides in the browser name: "... TDSocial/0.2.0").
// Pure, so it is unit-tested without a phone. Used to show the round "You" button inside the list screens ONLY on app versions that can
// open the "You" screen from a web page (0.2.0 and up); older builds still draw their own strip and need no button.

// "1.0" and "1.0.0" are the same version (the App Store's first version may be written either way); the third number is optional
const TOKEN = /TDSocial\/(\d+)\.(\d+)(?:\.(\d+))?/

export function appVersionFromUserAgent(ua: string | null | undefined): [number, number, number] | null {
  const m = typeof ua === 'string' ? TOKEN.exec(ua) : null
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

/** 0.2.0 is the first app build with no top strip and a web-to-app "open You" message. */
export function appHasYouBridge(ua: string | null | undefined): boolean {
  const v = appVersionFromUserAgent(ua)
  if (!v) return false
  const [a, b] = v
  return a > 0 || b >= 2
}

/** The same rule the app uses for its initials circle: "Antonio Durante" -> "AD", "Luca" -> "L"; with no name the first letter of the email; else "?". */
export function initialsOf(name: string | null | undefined, email: string | null | undefined): string {
  const letters = (name ?? '').split(' ').filter(Boolean).slice(0, 2).map(w => Array.from(w)[0].toUpperCase()).join('')
  if (letters) return letters
  const e = (email ?? '').trim()
  return e ? Array.from(e)[0].toUpperCase() : '?'
}
