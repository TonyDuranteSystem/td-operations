/**
 * Type-level proof that the alert label is REQUIRED (TD Social Step 2 / pull request C1, dev job 2072bc3e). Never imported, never run.
 *
 * It lives in `lib/` on purpose: `next build` (the CI Build job) checks every non-test file and IGNORES test files, so a `@ts-expect-error` proof placed in a
 * test would never fail a build. Here, loosening the rule (making the label optional, letting a Marketing kind through the staff sender, or the other way
 * round) makes one of the lines below stop being an error, and `@ts-expect-error` then turns that into a build failure.
 * The positive lines prove the rule is not tightened past what the real senders send.
 */
import type { StaffPushPayload } from "@/lib/portal/web-push"
import type { MarketingPushPayload } from "@/lib/marketing/push"

// @ts-expect-error — a staff alert without its label does not compile
export const _staffWithoutLabel: StaffPushPayload = { title: "t", body: "b" }

// @ts-expect-error — a Marketing kind cannot go through the staff sender (that one reads the staff-only table)
export const _staffWithMarketingKind: StaffPushPayload = { title: "t", body: "b", alertKind: "marketing_news" }

// @ts-expect-error — a made-up kind does not compile
export const _staffWithMadeUpKind: StaffPushPayload = { title: "t", body: "b", alertKind: "made_up" }

// @ts-expect-error — a Marketing alert without its label does not compile
export const _marketingWithoutLabel: MarketingPushPayload = { title: "t", body: "b", url: "/" }

// @ts-expect-error — a staff kind cannot go through the Marketing sender
export const _marketingWithStaffKind: MarketingPushPayload = { title: "t", body: "b", url: "/", alertKind: "client_chat" }

export const _staffOk: StaffPushPayload = { title: "t", body: "b", url: "/", tag: "x", dm: true, alertKind: "talk_direct_message" }
export const _marketingOk: MarketingPushPayload = { title: "t", body: "b", url: "/", tag: "x", alertKind: "marketing_lead_chat" }
