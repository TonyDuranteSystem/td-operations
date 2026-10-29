/**
 * Which frame a Marketing screen is shown in (pure; TD Marketing, dev job 9aec66fa — Antonio, 28 Oct 2026: "I still don't have my dashboard. If I click Messages it goes into Rocco's
 * dashboard"). THE RULE, written down so it is not flipped again (it was flipped twice on 28 Oct):
 *   - Antonio on his OWN login (an admin, not "View as"): HIS frame — his own Marketing menu on every screen (Messages, Board, Calendar, Documents, Templates, Team activity, Reports…),
 *     never the team's name or the team's menu.
 *   - "View as" (an admin looking at a role): the TEAM's frame, with the amber bar — it is a preview of what that person sees.
 *   - Everybody else (Rocco, Ale): the team's frame.
 */
export type FrameKind = "owner" | "team"

export function frameFor(i: { admin: boolean; viewAs: boolean }): FrameKind {
  return i.admin && !i.viewAs ? "owner" : "team"
}
