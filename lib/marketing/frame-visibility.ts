/**
 * Is this lead window hidden from the person (minimized, or behind another window)? The board tells the window page (lead-windows-host.tsx → lead-window-tabs.tsx).
 * A hidden window's chat keeps listening but must not mark messages as read: nobody is looking at them. A page that is not inside a window is never hidden.
 */
let hidden = false
export const setFrameHidden = (h: boolean): void => { hidden = h }
export const isFrameHidden = (): boolean => hidden
