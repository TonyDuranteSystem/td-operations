/**
 * The one way a portal page talks to the CLIENT app that shows it (dev job 2c751252, Android Step 1; docs/systems/client-app.md).
 *
 * The page sends short words to the app ("menu", "selection:<company>"). On an iPhone the app listens at `webkit.messageHandlers.tdclient`;
 * the Android app listens at `tdclientAndroid` (a Kotlin object added to the web view under that name, with one method `postMessage`).
 * Before this helper the page only knew the iPhone door, so on Android the Menu button did nothing and the bottom bar always described the
 * first company. Nothing here is a security switch: the app checks that the message comes from this site's main frame and checks the words.
 */
export interface NativeBridgeHost {
  webkit?: { messageHandlers?: { tdclient?: { postMessage?: (message: string) => void } } }
  tdclientAndroid?: { postMessage?: (message: string) => void }
}

/**
 * Sends `message` to the app: the iPhone door first, then the Android one. Returns true when a door took it (false in a plain browser, where
 * there is no app, or when the door threw). Never throws. `host` is the page's window; tests pass a fake.
 */
export function postToApp(message: string, host?: NativeBridgeHost): boolean {
  const target = host ?? (typeof window === 'undefined' ? undefined : (window as unknown as NativeBridgeHost))
  if (!target) return false
  try {
    const ios = target.webkit?.messageHandlers?.tdclient
    // called as a method (never pulled out of its object): the web view's own objects need their `this`
    if (ios && typeof ios.postMessage === 'function') {
      ios.postMessage(message)
      return true
    }
    const android = target.tdclientAndroid
    if (android && typeof android.postMessage === 'function') {
      android.postMessage(message)
      return true
    }
  } catch {
    /* a door that throws is the same as no door: the page keeps working, the app just does not hear it */
  }
  return false
}
