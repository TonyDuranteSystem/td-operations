import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"

const src = (p: string) => readFileSync(p, "utf8")

// TD Talk and the portal chat must not change when the Marketing chats get the computer toolbar: every new part is optional and off by default.
describe("the shared Talk message screen: the computer toolbar is opt-in (TD Talk unchanged)", () => {
  const msgs = src("components/talk/talk-messages.tsx")
  const sheet = src("components/talk/talk-sheet.tsx")
  it("the toolbar and the selectable text only exist when a chat passes `tools`", () => {
    expect(msgs).toMatch(/tools\?: TalkMessageTools/)
    expect(msgs).toMatch(/\{!deleted && tools && \(/)
    expect(msgs).toMatch(/tools \? 'md:select-text' : 'select-none/)
  })
  it("the old hover arrow stays for every chat that does not pass `tools`", () => {
    expect(msgs).toMatch(/\{!deleted && !tools && \(/)
  })
  it("'Mark unread' in the menu is optional", () => {
    expect(sheet).toMatch(/onMarkUnread\?: \(\) => void/)
    expect(sheet).toMatch(/onMarkUnread && !message\.deleted_at/)
  })
  it("TD Talk's own screen and the other chats do not pass the new parts", () => {
    for (const f of ["components/talk/talk-app.tsx"]) {
      const s = src(f)
      expect(s).not.toMatch(/tools=\{/)
      expect(s).not.toMatch(/onMarkUnread/)
    }
  })
  it("the Marketing chat turns them on", () => {
    const m = src("components/marketing/lead-chat.tsx")
    expect(m).toMatch(/tools=\{\{ onEdit/)
    expect(m).toMatch(/onMarkUnread=\{/)
    expect(m).toMatch(/heldUnreadRef/)
  })
})
