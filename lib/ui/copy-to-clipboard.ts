/**
 * Put text on the clipboard from a button press. Never throws; returns whether it worked.
 *
 * First choice is the browser's clipboard (needs a secure page and a real tap). The fallback is the old
 * select-a-hidden-box-and-copy trick, which some in-app web views still need. Call it straight from the
 * click handler, not after a network wait — iPhone refuses a copy that is no longer "inside" the tap.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the older method
  }
  try {
    if (typeof document === 'undefined') return false
    const box = document.createElement('textarea')
    box.value = text
    box.setAttribute('readonly', '')
    box.style.position = 'fixed'
    box.style.top = '0'
    box.style.left = '0'
    box.style.opacity = '0'
    document.body.appendChild(box)
    box.select()
    box.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(box)
    return ok
  } catch {
    return false
  }
}
