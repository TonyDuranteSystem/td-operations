'use client'

/**
 * CaptureProvider — the shared open/closed switch between the top-bar button
 * (rendered inside DashboardHeader / Sidebar) and CaptureLayer (mounted once
 * at the dashboard layout level, outside <main>, so it survives page
 * navigation — Antonio, 2026-09-04: "the screenshot page must stay open if I
 * move in different page to send it"). Mirrors components/help/help-provider.tsx's
 * shape on purpose — same codebase, same job (a header toggle + a
 * layout-level consumer), no reason to invent a different pattern.
 *
 * `isBrowseOpen` is the SAME shape for "My captures" (Antonio, 2026-09-04:
 * "when I click on my pictures I don't want to leave the page where I am but
 * a new page should popup") — a second, independent on/off switch, not a
 * shared "mode" with the capture flow, since a browse-open state does not
 * need any of the capture flow's stage machine.
 *
 * `isOpen` and `isBrowseOpen` are mutually exclusive, ENFORCED here, not just
 * by convention — bug-hunter finding, 2026-09-04: the capture button's menu
 * has no idea the OTHER tool is already open, so with no guard here a staff
 * member could have the capture flow open with an unsaved, marked-up
 * screenshot, separately open "My captures" from the same always-reachable
 * top-bar menu, and drop a picture onto it — silently wiping the in-progress
 * one, and, if its upload was still in flight, letting the confirm screen
 * show the NEW picture while the OLD one's id is what actually gets sent
 * (traced end-to-end in portal-chat-destination-picker.tsx, which shows a
 * local `imageFile` prop but sends a separate `captureId` prop — the two
 * were never guaranteed to agree). `open`/`openBrowse` each force the other
 * closed instead of independently flipping their own flag, so the two states
 * can never coexist regardless of which one is opened first.
 *
 * `pendingExternalFile` + `openWithFile` are the hand-off for "drag a picture
 * onto the browse popup and it starts a new capture with it" (Antonio,
 * 2026-09-04) — the browse popup has no stage machine of its own to load a
 * file into, so it hands the file to CaptureLayer via this one slot instead
 * of duplicating CaptureLayer's own `loadExternalFile` validation/markup
 * entry a second time. `openWithFile` closes the browse popup and opens the
 * capture flow in the same update, so the two never show at once.
 *
 * Deliberately minimal otherwise: this context only knows whether each tool
 * is open (+ the one pending-file hand-off). Everything about WHERE the
 * capture flow currently is (choosing a mode, selecting an area, previewing
 * the result) lives as CaptureLayer's own local state — the same separation
 * HelpProvider/HelpDot use.
 */
import { createContext, useCallback, useContext, useState } from 'react'

interface CaptureContextValue {
  isOpen: boolean
  open: () => void
  close: () => void
  isBrowseOpen: boolean
  openBrowse: () => void
  closeBrowse: () => void
  pendingExternalFile: File | null
  openWithFile: (file: File) => void
  clearPendingExternalFile: () => void
}

const CaptureContext = createContext<CaptureContextValue>({
  isOpen: false,
  open: () => {},
  close: () => {},
  isBrowseOpen: false,
  openBrowse: () => {},
  closeBrowse: () => {},
  pendingExternalFile: null,
  openWithFile: () => {},
  clearPendingExternalFile: () => {},
})

export function useCapture() {
  return useContext(CaptureContext)
}

export function CaptureProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const open = useCallback(() => {
    setIsBrowseOpen(false)
    setIsOpen(true)
  }, [])
  const close = useCallback(() => setIsOpen(false), [])

  const [isBrowseOpen, setIsBrowseOpen] = useState(false)
  const openBrowse = useCallback(() => {
    setIsOpen(false)
    setIsBrowseOpen(true)
  }, [])
  const closeBrowse = useCallback(() => setIsBrowseOpen(false), [])

  const [pendingExternalFile, setPendingExternalFile] = useState<File | null>(null)
  const openWithFile = useCallback((file: File) => {
    setPendingExternalFile(file)
    setIsBrowseOpen(false)
    setIsOpen(true)
  }, [])
  const clearPendingExternalFile = useCallback(() => setPendingExternalFile(null), [])

  return (
    <CaptureContext.Provider
      value={{
        isOpen,
        open,
        close,
        isBrowseOpen,
        openBrowse,
        closeBrowse,
        pendingExternalFile,
        openWithFile,
        clearPendingExternalFile,
      }}
    >
      {children}
    </CaptureContext.Provider>
  )
}
