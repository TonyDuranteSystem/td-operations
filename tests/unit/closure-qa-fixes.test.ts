/**
 * Company Closure — fixes after the production end-to-end test of 2026-11-07 (dev job eaa4747e, parent a6bbea09).
 * Pure rules first, then source-shape checks so a later edit cannot quietly route around a fix.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CLOSING_STEP_NAME,
  CLOSURE_DOCUMENTS_EMPTY_TEXT,
  COMPANY_CLOSE_NOT_CONFIRMED,
  STEP_BAR_CLOSE_QUESTION,
  closingQuestionButtons,
  movingClosesCompany,
} from "@/lib/closure/closing-step"
import { decideWizardMove, wizardAlreadyMovedJob, wizardMoveNote } from "@/lib/closure/wizard-move-guard"
import { goBackExtraWarnings } from "@/lib/flows/go-back-warnings"
import { isClosureFollowUpTitle } from "@/lib/services/closure-cascade"
import { lockedBoxTypeProblem } from "@/lib/flows/flow-upload-type"

const ROOT = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

describe("movingClosesCompany", () => {
  it("is true only for a Company Closure job WITH a company moving to the last step", () => {
    expect(movingClosesCompany({ serviceType: "Company Closure", targetStage: CLOSING_STEP_NAME, hasCompany: true })).toBe(true)
    expect(movingClosesCompany({ serviceType: "Company Closure", targetStage: CLOSING_STEP_NAME, hasCompany: false })).toBe(false)
    expect(movingClosesCompany({ serviceType: "Company Closure", targetStage: "IRS Closure", hasCompany: true })).toBe(false)
    expect(movingClosesCompany({ serviceType: "Tax Return", targetStage: CLOSING_STEP_NAME, hasCompany: true })).toBe(false)
    expect(movingClosesCompany({ serviceType: null, targetStage: null, hasCompany: true })).toBe(false)
  })
})

describe("closingQuestionButtons — 'Yes' only once staff can see what it does", () => {
  it("loading: nothing can be confirmed yet", () => {
    expect(closingQuestionButtons("loading", false)).toEqual({ canConfirm: false, showSkip: false, showRetry: false })
  })
  it("the read FAILED: no 'Yes' — only Try again (it used to fall back to a generic sentence with Yes enabled)", () => {
    expect(closingQuestionButtons("failed", false)).toEqual({ canConfirm: false, showSkip: false, showRetry: true })
    expect(closingQuestionButtons("failed", true).canConfirm).toBe(false)
  })
  it("shown: Yes; the 'finish without closing' button only with the wizard's warning", () => {
    expect(closingQuestionButtons("ready", false)).toEqual({ canConfirm: true, showSkip: false, showRetry: false })
    expect(closingQuestionButtons("ready", true)).toEqual({ canConfirm: true, showSkip: true, showRetry: false })
  })
  it("nothing to show (the job has no company): Yes is fine, no skip", () => {
    expect(closingQuestionButtons("none", false)).toEqual({ canConfirm: true, showSkip: false, showRetry: false })
  })
})

describe("the words", () => {
  it("the step bar and the server refusal name what happens; the empty Documents box says files may still be arriving", () => {
    expect(STEP_BAR_CLOSE_QUESTION).toContain("CLOSES THE COMPANY")
    expect(COMPANY_CLOSE_NOT_CONFIRMED).toContain("confirmation question")
    // written for staff (the to-do card shows it); the MCP tool adds the agent's sentence (tests/unit/closure-bughunt-fixes.test.ts)
    expect(COMPANY_CLOSE_NOT_CONFIRMED).not.toContain("confirm_company_close")
    expect(CLOSURE_DOCUMENTS_EMPTY_TEXT).toContain("within a few minutes")
  })
})

describe("the wizard's automatic move (fixes 7 and 8)", () => {
  const note = wizardMoveNote("tok-1", "hash-a")

  it("the note names the submission and its content, so a corrected resend is a different note", () => {
    expect(note).toBe("Closure wizard tok-1 received [hash-a]")
    expect(wizardMoveNote("tok-1", "hash-b")).not.toBe(note)
    expect(wizardMoveNote("tok-1", null)).toBe("Closure wizard tok-1 received")
  })

  it("the same content already moved the job -> a retry does not move it again (Go Back by staff is respected)", () => {
    const history = [{ to_stage: "State Compliance Check", notes: note }, { to_stage: "Data Collection", notes: "Reverted via flow Workspace \"Go Back\"" }]
    expect(wizardAlreadyMovedJob(history, note)).toBe(true)
    expect(decideWizardMove({ createdByWizard: false, companyDisagreement: null, alreadyMovedForThisContent: true })).toMatchObject({ move: false })
  })

  it("a corrected resubmission (new content) still moves the job from Data Collection", () => {
    const history = [{ notes: note }]
    expect(wizardAlreadyMovedJob(history, wizardMoveNote("tok-1", "hash-b"))).toBe(false)
    expect(decideWizardMove({ createdByWizard: false, companyDisagreement: null, alreadyMovedForThisContent: false })).toEqual({ move: true, reason: null })
  })

  it("an unreadable or empty history never counts as 'already moved' by itself", () => {
    expect(wizardAlreadyMovedJob(null, note)).toBe(false)
    expect(wizardAlreadyMovedJob([], note)).toBe(false)
    expect(wizardAlreadyMovedJob([null, "x", { notes: 5 }], note)).toBe(false)
  })

  it("the client wrote another company than the job's -> the job is NOT pushed forward (it used to move the person's other open closure)", () => {
    const d = decideWizardMove({ createdByWizard: false, companyDisagreement: "This closure is linked to A, but the client wrote B.", alreadyMovedForThisContent: false })
    expect(d).toMatchObject({ move: false })
    expect(d.reason).toContain("CHECK")
  })

  it("a job the wizard created itself stays put (unchanged)", () => {
    expect(decideWizardMove({ createdByWizard: true, companyDisagreement: null, alreadyMovedForThisContent: false })).toMatchObject({ move: false })
  })

  it("the route uses the guard, writes the note into the move, and treats an unreadable history as 'already moved'", () => {
    const route = read("app/api/closure-form-completed/route.ts")
    expect(route).toContain("wizardMoveNote(token, dedupeKey)")
    expect(route).toContain("notes: moveNote")
    expect(route).toContain("decideWizardMove(")
    expect(route).toContain("companyDisagreement: destination?.disagreement ?? null")
    expect(route).toContain("histErr ? true")
  })
})

describe("Go Back says what it also does (fix 6 and 9)", () => {
  it("names the tracking number and the Closed company only when they apply", () => {
    expect(goBackExtraWarnings({ hasTrackingNumber: false, closureCompanyClosed: false })).toEqual([])
    expect(goBackExtraWarnings({ hasTrackingNumber: true, closureCompanyClosed: false }).join(" ")).toContain("deletes the saved IRS tracking number")
    expect(goBackExtraWarnings({ hasTrackingNumber: false, closureCompanyClosed: true }).join(" ")).toContain("does NOT reopen it")
    expect(goBackExtraWarnings({ hasTrackingNumber: true, closureCompanyClosed: true })).toHaveLength(2)
  })

  it("the page passes the warnings, the button shows them and no longer sticks on 'Going back…'", () => {
    const page = read("app/(dashboard)/flows/[id]/page.tsx")
    expect(page).toContain("goBackExtraWarnings(")
    expect(page).toContain("extraWarnings={goBackExtras}")
    const btn = read("components/flows/go-back-button.tsx")
    expect(btn).toContain("extraWarnings")
    expect(btn).toMatch(/finally \{[\s\S]*setBusy\(false\)/)
  })
})

describe("finishing again must not tick the Harbor follow-up Done (fix 2)", () => {
  it("recognises the follow-up cards by their title prefix and nothing else", () => {
    expect(isClosureFollowUpTitle("[CLOSURE] Remove RA on Harbor Compliance")).toBe(true)
    expect(isClosureFollowUpTitle("[CLOSURE] Cancel CMRA mailing address / lease")).toBe(true)
    expect(isClosureFollowUpTitle("[Company Closure] Cancel Registered Agent on Harbor Compliance")).toBe(false)
    expect(isClosureFollowUpTitle(null)).toBe(false)
  })
})

describe("a locked step only counts the file it asks for (fix 1)", () => {
  it("the right type, an untyped box, a generic 'other document' box and an unlocked step all pass; an unrelated type does not", () => {
    expect(lockedBoxTypeProblem({ locked: true, boxType: "certificate_of_dissolution", chosenSlug: "certificate_of_dissolution" })).toBeNull()
    expect(lockedBoxTypeProblem({ locked: true, boxType: null, chosenSlug: "other_document" })).toBeNull()
    expect(lockedBoxTypeProblem({ locked: true, boxType: "other_document", chosenSlug: "passport" })).toBeNull()
    expect(lockedBoxTypeProblem({ locked: false, boxType: "certificate_of_dissolution", chosenSlug: "other_document" })).toBeNull()
    const refusal = lockedBoxTypeProblem({ locked: true, boxType: "certificate_of_dissolution", chosenSlug: "other_document", boxTypeName: "Certificate of Dissolution" })
    expect(refusal).toContain("Certificate of Dissolution")
    expect(refusal).toContain("only that kind of file")
  })

  it("the upload route checks it after the type is resolved and before anything is downloaded or saved", () => {
    const route = read("app/api/flows/[id]/upload-document/route.ts")
    const typeAt = route.indexOf("const chosenType = await resolveFlowUploadType(")
    const lockAt = route.indexOf("lockedStepUploadProblem(")
    const downloadAt = route.indexOf("// 2. Download from Storage.")
    expect(typeAt).toBeGreaterThan(-1)
    expect(lockAt).toBeGreaterThan(typeAt)
    expect(downloadAt).toBeGreaterThan(lockAt)
  })
})

describe("no door closes a company unasked (fix 3)", () => {
  it("the shared move refuses a move to Closing unless the question was answered, BEFORE anything is written", () => {
    const sd = read("lib/service-delivery.ts")
    const guard = sd.indexOf("// 4h. Closing the company is asked first")
    const history = sd.indexOf("// 5. Build stage history entry")
    expect(guard).toBeGreaterThan(-1)
    expect(history).toBeGreaterThan(guard)
    const block = sd.slice(guard, history)
    expect(block).toContain("movingClosesCompany(")
    expect(block).toContain("!skip_company_close")
    expect(block).toContain("!company_close_confirmed")
    expect(block).toContain("COMPANY_CLOSE_NOT_CONFIRMED")
  })

  it("the advance route, the step-bar route and the MCP tool pass the answer through; the card handler passes nothing (so it is refused)", () => {
    expect(read("app/api/flows/[id]/advance/route.ts")).toContain("company_close_confirmed: body.company_close_confirmed === true")
    expect(read("app/api/flows/[id]/set-stage/route.ts")).toContain("company_close_confirmed: body.company_close_confirmed === true")
    expect(read("app/api/flows/[id]/set-stage/route.ts")).toContain("skip_company_close: body.skip_company_close === true")
    expect(read("lib/operations/move-stage.ts")).toContain("company_close_confirmed: params.company_close_confirmed")
    const mcp = read("lib/mcp/tools/operations.ts")
    expect(mcp).toContain("confirm_company_close")
    expect(mcp).toContain("company_close_confirmed: confirm_company_close")
    expect(read("lib/tasks/workflow-handlers/chain-advance-sd-stage.ts")).not.toContain("company_close_confirmed")
  })

  it("the step bar asks the in-page question for the closing step; the finish button uses the same component and sends the answer", () => {
    const stepper = read("components/flows/stage-stepper.tsx")
    expect(stepper).toContain("<ClosingQuestion")
    expect(stepper).toContain("STEP_BAR_CLOSE_QUESTION")
    expect(stepper).toContain("company_close_confirmed: true")
    expect(read("app/(dashboard)/flows/[id]/page.tsx")).toContain("closesCompanyAt={")
    const buttons = read("components/flows/action-buttons.tsx")
    expect(buttons).toContain("<ClosingQuestion")
    expect(buttons).toContain("company_close_confirmed: true")
  })

  it("the question component has no generic fallback: a failed read offers Try again and keeps Yes off", () => {
    const q = read("components/flows/closing-question.tsx")
    expect(q).toContain("closingQuestionButtons(")
    expect(q).toContain("Try again")
    expect(q).toContain("disabled={busy || !buttons.canConfirm}")
  })
})

describe("the small ones (fix 10)", () => {
  it("a saved tracking number clears the stale red refusal on the step bar and the buttons", () => {
    expect(read("components/flows/irs-tracking-entry.tsx")).toContain("FLOW_TRACKING_SAVED_EVENT")
    expect(read("components/flows/stage-stepper.tsx")).toContain("FLOW_TRACKING_SAVED_EVENT")
    expect(read("components/flows/action-buttons.tsx")).toContain("FLOW_TRACKING_SAVED_EVENT")
  })

  it("a closure job's empty Documents box explains itself and looks again by itself", () => {
    expect(read("components/flows/stage-renderer.tsx")).toContain("CLOSURE_DOCUMENTS_EMPTY_TEXT")
    const viewer = read("components/flows/document-viewer.tsx")
    expect(viewer).toContain("pollWhileEmptyMs")
    expect(viewer).toContain("emptyText")
  })
})
