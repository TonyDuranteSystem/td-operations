# CRM Storage — end-to-end QA scenarios (run before every ship)

_Created 2026-09-28 (extended the same day after the browser run) at Antonio's request ("create a list of the entire scenarios that we will use later before shipping and save it"). Covers everything built in the new CRM storage up to build `cce38deca` plus the E2E fixes of 2026-09-28 (sandbox). Run it top to bottom in a real browser on the environment being shipped, logged in as the right person for each block. Record PASS / FAIL / NOT RUN + a note for each line. A FAIL blocks the ship._

**Test data rule:** use only test companies and people named "ZZ …" (never a sandbox copy of a real client), the sandbox logins antonio.durante@ (owner), jodi@ (owner), luca@ and support@ (staff), and the QA client portal login. Never press "Send fax to IRS". Clean up test files after (Delete → they go to the trash).

**Logins used:** O = an owner (Antonio / Jodi) · S = staff (Luca / support@) · C = the client in the portal.

---

## A. Getting around (the left side)
| # | Who | Do | Expect |
|---|---|---|---|
| A1 | O | Open Storage → New storage | Left side shows **Clients**, **Business**, **My files** ("owners only"); right side "Pick a client, Business or My files on the left." |
| A2 | O | Open Clients | State groups (Wyoming, Florida…), People, Companies being formed, Closed / Cancelled, Missing state; counts shown |
| A3 | O | Open a state → a company → its folders | Company folders 1–5 listed under it; they open/close with the arrow without changing the right side |
| A4 | O | Click a folder NAME on the left | Right side shows that folder, path at the top (Storage › state › company › folder), each step clickable |
| A5 | O | Search "ZZ" | Groups open automatically, only matching storages listed; Business / My files hidden unless the search matches them |
| A6 | S | Log in as staff | No **My files**; a **Shared with me** entry instead |
| A7 | O | Open Business, then My files | Each opens on the right; folders listed under them on the left |
| A8 | O | Long tree (open many groups) | The left box grows (no inner scroll); page scrolls; menus not cut off |

## B. Folders
| # | Who | Do | Expect |
|---|---|---|---|
| B1 | O | Hover a company folder → **+** → type "Bank of America" → Create | Folder appears under it (left and right) |
| B2 | O | Same name again (any case) | Red message under the box BEFORE saving, button disabled |
| B3 | O | Names with "/" or "\" | Red message, cannot save |
| B4 | O | ⋯ on the new folder → Rename | Renamed everywhere |
| B5 | O | ⋯ → Move to… | Tree picker; the folder itself and its sub-folders can't be chosen; "2. Contacts" can't be chosen; moves |
| B6 | O | ⋯ → Delete (folder with a file the client sees) | Question lists the visible files → Continue / Hide first / Pick which / Cancel; then "Move to trash?" with counts |
| B7 | O | Fixed folders (top, 1–5, a person's 3) | Lock icon, no ⋯ menu, no rename / move / delete |
| B8 | O | Hover **3. Tax** → New tax year | Next missing year pre-filled; only 4 digits accepted; year folders newest first |
| B9 | O | Move a year folder out of Tax | Refused: "a tax-year folder — it can only go inside a Tax folder" |
| B10 | O | Business → + → folder; My files → + → folder | Created; Business / My files top accept files |

## C. Uploads and the questions (Upload panel)
| # | Who | Do | Expect |
|---|---|---|---|
| C1 | O | Upload a company paper into 1. Company, "Show to client" ticked | Saved; client can see it; client alert |
| C2 | O | Upload with "Show to client" unticked | Saved hidden |
| C3 | O | Same name, different content | Both files side by side → Replace / Keep both "(2)" / Cancel; Replace keeps the old copy under Versions |
| C4 | O | Replace a SHARED file with "Show to client" unticked | The file becomes hidden (the answer wins) |
| C5 | O | Exact same file already stored elsewhere in this client | "Already stored" + where → Don't add / Rename the existing one / Add a second copy / Cancel |
| C6 | O | Exact same file stored in ANOTHER client | No "Rename the existing one"; "Add a second copy" suggested |
| C7 | O | Upload into a Closed company | Question: Store here / Choose another client or folder… / Business folders… / Decide later; closing the question = nothing saved |
| C8 | O | Upload a tax form (Form 1120) into 3. Tax itself | "Which tax year?" → existing years / New year folder / Choose another folder / Cancel |
| C9 | O | Upload a prepared return | "Filed or draft?" → Filed (can be shown) / Draft (never shown) / Decide later |
| C10 | O | Decide later | File saved hidden with red **Needs review**; ⋯ → Mark reviewed clears it; it can't be shown while red |
| C11 | O | Upload a passport into 2. Contacts → "Whose document?" | Lands in that person's own storage, both links (company + person) |
| C12 | O | Upload a company paper into a person's folder from the company page | Refused ("only the person's own documents") |
| C13 | O | Upload into the Business area | No CRM listing, can never be shown; a personal type refused there |
| C14 | O | Custom… document type | Added once to the list, then reused |
| C15 | O | Pick a staff-only type (Formation Summary) | "Show to client" greys out with the reason; the file is saved hidden, "Can't be shown" |
| C16 | O | First upload after the page sat idle | Finishes (a first request can take up to ~20 s on a cold server — note the time); the spinner never hangs for ever |

## D. Files
| # | Who | Do | Expect |
|---|---|---|---|
| D1 | O | Click a file name | Opens INSIDE the CRM (preview panel) |
| D2 | O | Show / hide control on a row | One control; tooltip; changes what the client sees |
| D3 | O | Show a personal document | Question: who would see it → "Show it to <person> only" / Keep hidden |
| D4 | O | Staff-only / internal file | "Can't be shown" with the reason on hover |
| D5 | O | ⋯ → Rename (extension kept) | Renamed; CRM list follows |
| D6 | O | ⋯ → Move to… a visible file | "Keep visible / Hide / Cancel"; category follows the new folder |
| D7 | O | Drag a file onto another folder (same storage) | Moved; a drop onto another client refused |
| D8 | O | ⋯ → Delete | "Move to trash?" → gone from the list and from the portal |
| D9 | O | Versions (N) | Every saved copy listed, each opens |
| D10 | O | ⋯ → Details | Where, type, year, filed/draft, client can see, shared with, uploaded by/when, versions |
| D11 | O | Read scanned text | Opens the OCR text |
| D12 | O | A draft return → ⋯ → Mark filed | Asks first (can't be undone); becomes a filed return that can be shown; refused while Needs review |
| D13 | O | A draft return → Show to client | Can't be shown ("a draft is never shown") |
| D14 | O | A workspace document the client always sees (e.g. Formation Articles) | Locked "Client can see" badge (hover: which workspace); no Hide; Move only offers "stays visible"; a same-name replace with Show unticked is refused ("Keep both") |
| D15 | O | A passport whose details can't be read | Plain message ("enter them on the contact by hand"), never technical text |

## E. "2. Contacts" and people
| # | Who | Do | Expect |
|---|---|---|---|
| E1 | O | Open a company's 2. Contacts | One branch per person ("also in <other company>") |
| E2 | O | Open a person's branch | Only "Personal documents" (+ staff folders); NEVER their ITIN / Tax |
| E3 | O | + Folder in a person's branch | Question: the folder shows in all their companies → person's storage / this company's folders / Cancel |
| E4 | O | Open the person under People | All 3 folders (Personal, ITIN, Tax) |
| E5 | O | A person's FIRST document (no personal storage yet — "no documents yet"), via upload AND via drag onto 2. Contacts | Saved; their storage is created; never "failed" |

## F. Trash
| # | Who | Do | Expect |
|---|---|---|---|
| F1 | O | Delete a file, open **Trash** | Listed with deleted when / by whom / deleted for good on |
| F2 | O | Restore | Back where it was, hidden from the client, CRM listing back |
| F3 | O | Restore a deleted folder | Folder + files back; a name taken meanwhile → renamed |
| F4 | O | Restore a file whose folder was deleted too | Asked where to put it (picker) |
| F5 | O | Preview a file inside the trash | Opens |
| F6 | S | Trash of My files | Refused |
| F7 | O | Company Trash after deleting a member's passport from 2. Contacts | Listed "In <person>'s own storage"; restore puts it back in the person's storage |
| F8 | O | Open a restored file from the company's Documents list | Opens (the link was renewed on restore) |
| F9 | O | Restore a folder, look at its count before opening it | Never an old count (e.g. "1 shown to client" for a file that came back hidden) |
| F10 | O | Escape in the Trash window / details panel | Closes it (not while a question or preview is open on top) |

## G. Drag from the computer
| # | Who | Do | Expect |
|---|---|---|---|
| G1 | O | Drop 3 files onto a folder | Panel: type per file, "Same type for all", name shown, status per file; all arrive hidden |
| G2 | O | Drop onto a closed company / a tax folder / a same-name file | The usual questions, one file at a time; closing a question skips that file only |
| G3 | O | Drop a whole folder (with sub-folders and .DS_Store) | Panel shows the folders to be made; hidden files skipped; sub-folders made once |
| G4 | O | Drop a folder "2024" onto 3. Tax | "2024" becomes a real year folder; files get year 2024 |
| G5 | O | Drop outside any folder | Nothing happens (the page does not open the file) |
| G6 | O | Drop while an upload runs | Refused with a message |
| G7 | O | Drop > 500 files | Refused with a message |

## H. Many files at once
| # | Who | Do | Expect |
|---|---|---|---|
| H1 | O | Tick 3 files → Hide from client | Summary with counts → hidden |
| H2 | O | Tick incl. a passport → Show to client | Passport skipped (one by one only), others shown |
| H3 | O | Tick → Move to… | Picker; visible files → keep/hide once |
| H4 | O | Tick → Delete | "Move N files to the trash?" |
| H5 | O | Tick files of two storages | Refused ("one client at a time") |
| H6 | O | Sort: newest first | Order changes; remembered after reload |
| H7 | O | Filter: Shown to client / Needs review / Needs a type | One list across the client's own folders, folder name clickable |
| H8 | O | Hover a folder → Zip | Downloads; an empty folder gives a message; the download is recorded |
| H9 | O | Folder with a workspace document → Delete/Move → the question | The workspace file is listed as "always shown by its workspace", never offered for hiding; the rest can be hidden |
| H10 | O | Zip of 300+ files | Complete (open the zip: every file, none empty), well under a minute |

## I. My files, owners and "Shared with staff"
| # | Who | Do | Expect |
|---|---|---|---|
| I1 | O (Antonio) and O (Jodi) | Open My files | The SAME area for both |
| I2 | O | My files → Shared with staff → upload | Asks who can see it; nobody by default |
| I3 | O | "Not shared" → tick Luca → Save | "Shared with 1" |
| I4 | S (Luca) | Shared with me | That file only; opens; download; no rename / move / delete; nothing else from My files |
| I5 | S (support@) | Shared with me | Not listed |
| I6 | O | Move the file out of Shared with staff | Luca no longer sees it |
| I7 | O | Delete + restore a shared file | Comes back shared with nobody |
| I8 | S | Try to open a My files folder / file by its address | "Not found" |
| I9 | O (Jodi) | My Finances | Opens (owner) — production only after "ship it" |

## J. The client portal (what the client really sees)
| # | Who | Do | Expect |
|---|---|---|---|
| J1 | C | Documents | Only files marked "client can see"; hidden, draft, needs-review, staff-only never listed |
| J2 | C | A member's passport | Only that member sees it (never another member) |
| J3 | C | After a restore | The restored file is NOT listed until staff show it |
| J4 | C | After a delete | Gone from the portal |
| J5 | C | Services page → each service's documents | Only files the client can see; a hidden file is neither listed nor downloadable (job 197e13ad — production leak on this page today) |
| J6 | C | Tax documents page | Hidden / draft / needs-review returns never listed, not even by name |
| J7 | C | Portal search | Never returns the name of a hidden file |
| J8 | C | Open a hidden file's download address directly | Refused |
| J10 | O→C | Run block J with "View as client" on a company whose client has a portal login (sandbox: Uxio Test LLC) | On the sandbox the portal and CRM share one address: exiting signs the staff login out — sign in again |
| J9 | C | A file in a workspace stage the client sees (e.g. Formation) | Shown with the locked "client can see" badge in storage; it stays on the portal (it can't be hidden from the storage) |

## K. Company and contact pages (the same browser, scoped)
| # | Who | Do | Expect |
|---|---|---|---|
| K1 | O | Company page of a pilot company → Files | The new storage for that company only (no left side) |
| K2 | O | Contact page → Documents → Personal / company tabs | The person's storage / each company's storage |
| K3 | O | Everything in B–H from the company page | Works the same |

## L. Stress and edge cases
| # | Do | Expect |
|---|---|---|
| L1 | Double-click buttons (create, delete, restore, save sharing) | One action, no duplicates |
| L2 | Two tabs changing the same folder | The later change sees the new state or a clear message |
| L3 | 300+ files in one folder | Opens, filters and zip work, no timeouts |
| L4 | Very long names, accents, emojis in names | Saved and shown correctly; zip file name readable |
| L5 | Slow network / an error from the server | A clear message, never a blank or stuck screen |
| L6 | Browser back / reload mid-action | No half-done state |
| L7 | Console | No red errors during the whole run |
| L8 | After every action | The changed folder updates within a couple of seconds; "Moving…/Renaming…" shows while it runs; a storage never looks empty while loading ("Loading…") |
| L9 | Reload the Storage page | Opens on the tab used last on this computer |

## M. Move a company from Drive (pilot company "ZZ Drive Pilot LLC", TEST Drive only)
| # | Do | Expect |
|---|---|---|
| M1 | Company page → Documents → "Move this company to the new storage…" → Yes | Progress "Moving… N of M files"; then "Moved — every file checked" |
| M2 | Read the report | Every Drive folder with In Drive = Moved + Kept once + Not moved; 0 failed; Google Docs listed under "Not moved"; untyped visible files under "Waiting for a type" |
| M3 | Open the storage on the company page | Only the new storage + the note with the old Drive folder link; files in 1–5 folders, sub-folders and year folders as in Drive; the loose top file in Correspondence marked Needs review |
| M4 | "2. Contacts" → each person | Their passport/ID in their own storage; the identical copy kept once |
| M5 | Open a moved document from the CRM documents list | It opens (from the new storage) |
| M6 | View as client → Documents | Exactly the same documents as before the move |
| M7 | Press Move in a second tab while it runs | No file moved twice; one report |
| M8 | Close the page mid-move, reopen, "Continue" | Finishes; nothing lost |
| M9 | "Undo the move…" → Yes | Records open from Drive again; the copies in the storage trash; the company page shows Drive again |
| M10 | Move again after the undo | Works; same report |
| M11 | Open the TEST Drive folder | Nothing changed there |

## N. Set type and type questions
| # | Do | Expect |
|---|---|---|
| N1 | Any file row → click its type label (or "Needs a type") | The Set type box opens with the current type |
| N2 | A company file wrongly labelled (e.g. Operating Agreement) → set **Passport** | Asks "whose is it?"; after the answer the file is in that person's storage, shows in the company's "2. Contacts", the client still sees it if they did before |
| N3 | A file in a person's storage → set a company type (EIN Letter) from the company page | It moves to that company's folder; from the person's own page it asks "move to <company> / keep it" |
| N4 | A visible file → set **Formation Summary** (staff only) | Hidden from the client, said so |
| N5 | A visible file → set **Form 1120** | Asks "filed copy / hide until filed"; each answer does what it says |
| N6 | A filed return → change type | Refused (filed and frozen) |
| N7 | Storage → Type questions → "Look for unknown labels" | Labels used by 2+ records listed with their record counts; one-offs not listed |
| N8 | Answer one "Same as…", one "New type", one "Not a type" | Each disappears from the list; a new type appears in the Set type list |
| N9 | Moved company → report → "Re-check types" | Files whose label is now answered get their type; "Waiting for a type" shrinks |
| N10 | Report → "Waiting for a type" → Set type | The file gets its type, its record opens from the new storage, the client sees it as before |
| N11 | Undo the move after N9/N10 | Every record opens from Drive again |
