# -*- coding: utf-8 -*-
"""Hostinger and operations tasks, the import, acceptance, reviews, and the people the build waits for."""
from plan_core import T, ROLLBACK_NONE as RBN, ROLLBACK_REVIEW as RBR

# =============================================================================================== REVIEWS
T("RV0", "RV", "Plan review: two fresh agents read this plan and its generator, then the fixes",
  agent="C", repo="api", lo=0.5, hi=1.5, deps=[],
  reqs=[], tests=[], gate="G-P (plan gate)",
  do="Two fresh agents (never the writer of this plan): one for traceability (every spec line a task and a test; can each test pass "
     "where it is introduced; are dependencies complete; is any task over 1.5 plan-days; is anything the plan says is done really "
     "done), one for schedule, risk, people and Hostinger (are the estimates honest, the tripwires placed where the speed will "
     "show, every wait on a person a task, the dates computed from the critical path, the cut line priced). They write "
     "`plan-review.md` and `plan-review-2.md`; the writer answers every finding in `plan.md` section 11 and re-runs "
     "`python3 _plan-build/build_plan.py`. Two rounds without progress go to Harsh.",
  files=[], done="`plan-review.md` exists with every finding closed or ruled, `python3 _plan-build/build_plan.py` prints 'coverage OK', and "
                 "Harsh has read the short Hinglish summary and said go (PH01).",
  rollback=RBR)

T("RV1", "RV", "Implementation review 1: access and security (fresh agent) - gate G-A",
  agent="C", repo="api", lo=0.5, hi=1.0, grp="review",
  deps=["API05", "API07", "API08", "API09", "API10", "API11", "API12", "API13", "API13b", "WEB02", "WEB14"],
  reqs=[], tests=[], gate="G-A",
  do="A fresh agent reads the diff against spec sections 3, 4.1, 5 and 6.2 and runs: the generated cell tests, the static "
     "checks, the secrets scan; tries to read the original weight as a biller and staff by every route including function "
     "results; tries sessions (fixation, expiry, deactivation), CSRF without the header and with a wrong Origin, the admin "
     "door without a token and with an Origin header; reads the dev-tooling findings of `npm audit` that API10 prints but does not gate (on 17 Oct vitest 3.2.7 brought two critical, dev-only ones, and the fix is vitest 5, a major step) and rules on them; mutation check: breaks one rule at a time (a matrix cell, the "
     "customer-role read, the CSRF layer, the idle limit) and each must fail a test. Writes `impl-review-1.md`.",
  files=[], done="`impl-review-1.md` has no open Critical or High finding; every deliberate breakage failed a test; the local advisor-free "
                 "checks of A7 are green.", rollback=RBR)

T("RV2", "RV", "Implementation review 2: the money core with a mutation check (fresh agent) - gate G-M",
  agent="A", repo="api", lo=1.0, hi=2.0, grp="review",
  deps=["API29", "API30", "API31"],
  reqs=[], tests=[], gate="G-M",
  do="A fresh agent re-derives the money rules from spec Part B (not from the code), runs the A, B and C suites three times in a "
     "row, and applies its own mutations one rule at a time: a rebalance that rewrites an old allocation, a cancel that skips a "
     "voided receipt's allocation, a void using `paid_on` for its day, a lock order with the counter first, a customer lock "
     "removed, a piece lock sorted in code, a refund not capped by the advance, a walk-in advance allowed, a cash limit off by "
     "one paisa, a trailing-zero decimal accepted; each must fail a test. It also reads the reviewer's earlier "
     "`rm5-experiments` as a cross-check. Writes `impl-review-2.md`.",
  files=[], done="`impl-review-2.md` has no open Critical or High; all A, B and C tests pass three times in a row; each mutation failed at least one "
                 "test.", rollback=RBR)

T("RV3", "RV", "Implementation review 3: jobs, backups and restore (fresh agent) - gate G-B",
  agent="C", repo="api", lo=0.5, hi=1.0, grp="review",
  deps=["API33", "API33b", "API34", "API35", "API36", "OPS05"],
  reqs=[], tests=[], gate="G-B",
  do="A fresh agent reads B1 to B6, I8, I12 and L6 against the code, runs the T-R tests, kills the dump at three points, "
     "removes a photo from the folder, fills the folder past the prune count, runs two ticks at once, sets the clock to day "
     "27, 28, 35 and 36, and checks that no secret is in the repository. It repeats the restore on a second lane database. "
     "Writes `impl-review-3.md`.",
  files=[], done="`impl-review-3.md` has no open Critical or High; the restore drill log of OPS05 is checked against the code.", rollback=RBR)

T("RV4", "RV", "Implementation review 4: end to end on staging (fresh agent) - gate G-E",
  agent="A", repo="api", lo=0.5, hi=1.0, grp="review",
  deps=["WEB12b", "WEB13", "WEB14", "WEB15", "WEB16", "OPS04", "RV1", "RV2", "RV3"],
  reqs=[], tests=[], gate="G-E",
  do="A fresh agent runs a hand billing day on the staging pair: create a customer, a bill (with the worked example), a part "
     "payment, a fine settlement, a cancel, a re-issue, a void, a refund, an opening balance; reads the nightly check and the "
     "dashboard line; checks the printed estimate for 1, 6 and 40 items; tries the three roles; breaks one thing on purpose "
     "(a staging deploy rolled back by a revert). Writes `impl-review-4.md`.",
  files=[], done="`impl-review-4.md` has no open Critical or High; the staging run log is attached.", rollback=RBR)

# =============================================================================================== PEOPLE: HARSH
T("PH01", "PH", "WITH-HARSH: read the plan, give the go, choose the date plan",
  who="WITH-HARSH", lead=(0, 2), deps=["RV0"], reqs=[], tests=[],
  do="Needed from Harsh: a go on the plan (nothing is bought and nothing is created on Hostinger, GitHub or Vercel by this "
     "plan without his say in the step that does it) and the date plan: switch billing after Bhai Dooj (not before Thu 12 Nov, most likely the week of 16 to 23 Nov). "
     "A switch before Dhanteras week would overrule his own rule in PLAN.md 3.1 rule 4 (no change between 29 Oct and 11 Nov), so the plan does not offer it; if he wants it he says so in his own words and the plan is recomputed. "
     "Latest day: the go must arrive on the day RV0 ends; every day later moves every date by a day.",
  done="Harsh writes the go and the date plan in the ledger.", rollback=RBN)

T("PH02", "PH", "WITH-HARSH: private GitHub repository for the API, pushed by Harsh, Hostinger's GitHub app connected",
  who="WITH-HARSH", lead=(1, 3), deps=["PH01"], reqs=[], tests=[],
  do="Needed from Harsh (he pushes; Claude never does): make `iamharshvishwas/jewelvault-api` a PRIVATE repository from GitHub Desktop "
     "and push `main` and, from the same commit, a branch `staging` (PH05b creates the staging app from it); check that Hostinger's GitHub app (one GitHub account per plan, all Node sites share it) can see it; "
     "later pushes of the staging and production branches are his too. The website repository `jewelvault-app` is already on "
     "GitHub and Vercel: until PH08 Harsh pushes only the work branch `api-web` of it (never `main`), so that Vercel's production site keeps showing what it shows today and a half-built login cannot reach it; "
     "Vercel makes a preview for the branch. Latest day: before OPS03a (the first staging deploy).",
  done="The repository is visible in hPanel's 'Add website, Node.js web app' list.", rollback=RBN)

T("PH03", "PH", "WITH-HARSH: remove the failed Hostinger test app and find the unlisted test cron job (keep the two named proof apps for now)",
  who="WITH-HARSH", lead=(1, 4), deps=["PH01"], reqs=[], tests=[],
  do="Needed from Harsh in hPanel (names as of 17 Oct, after the domain was connected; the temporary `*.hostingersite.com` addresses now answer 403): "
     "remove the failed app `skyblue-rat-675449`. **Do not remove the two proof apps yet:** the runtime proof app sits under `billing-api-staging.jaishrigoldpalace.com` "
     "(formerly `deepskyblue-hare-853248`) and carries the cookie page that passed in Chrome; OPS01 reuses it, by zip upload, for the API skeleton, and the database proof app "
     "(formerly `floralwhite-wombat-443130`, with the test folder `jv-backup-test`) keeps `billing-staging.` until PH04 points that name at Vercel. PH05b removes both proof apps "
     "and the database `u992795260_proof` once OPS01 and OPS02a are done (**removing an app frees its domain name, so the real staging app can take `billing-api-staging`**, "
     "HOSTINGER-SPIKE section 6). **Never touch `flybytheway.com`: it is the live site in the same account.** The Node.js-type cron job made for the proof is not listed in hPanel "
     "and cannot be deleted from the screen: if it does not vanish with its website, ask Hostinger support. The plan has 5 Node app slots; staging and production need two; "
     "nothing is assumed done until Harsh has done it. Latest day: before PH05b.",
  done="hPanel no longer lists `skyblue-rat-675449`; the two proof apps are still there; the support answer about the cron job is written down.", rollback=RBN)

T("PH04", "PH", "WITH-HARSH: the domain's DNS for Vercel, and (after go-live) the hand-over of the domain to Siddhi",
  who="WITH-HARSH", lead=(0, 2), deps=["PH01"], reqs=["O38"], tests=[],
  do="**Corrected on 17 Oct 2026, in Harsh's words: `jaishrigoldpalace.com` is SIDDHI's domain (her name and her money); it is registered in HARSH's own Hostinger account (API-00C-RESULTS.md section 5) and stays there until hand-over.** So the old plan of "
     "asking Siddhi for a domain is gone because she has already supplied the name (`MESSAGE-FOR-SIDDHI-domain.md` stays marked not needed). The names are fixed: production `billing.jaishrigoldpalace.com` (the website, "
     "on Vercel) and `billing-api.jaishrigoldpalace.com` (the API, Hostinger); staging `billing-staging.` and `billing-api-staging.`. Two staging names are already connected "
     "to the proof apps, with Let's Encrypt certificates (17 Oct to 15 Jan 2027), and the cookie, CORS and image flow passed in Chrome 155. **Needed from Harsh:** (1) in "
     "Hostinger's DNS for the domain, the record that Vercel asks for, for `billing-staging` (a Vercel preview project) and later for `billing` (production), "
     "replacing the connection to the proof app (that name is now served by a Hostinger app); (2) the hand-over (O38): after go-live (the plan suggests after the first month, with Siddhi's say) the registrant moves to an account in Siddhi's name; until then "
     "the registrant and the Hostinger hosting stay together in Harsh's one account (a registrant in Siddhi's account while the apps stay in Harsh's "
     "can break the connected names the way `harshvishwas.com` was refused), and the yearly renewal is Siddhi's to pay by default, with the price stated by Harsh in the go or no-go list. Nothing else is hosted on any subdomain of this domain (same-site with the API).",
  done="The website name resolves to Vercel and the API name to Hostinger, each with a certificate; Harsh has written the ownership and renewal decision in the ledger.", rollback=RBN)

T("PH05", "PH", "WITH-HARSH: staging database and a scratch database created in hPanel with exactly the ten boxes",
  who="WITH-HARSH", lead=(1, 3), deps=["PH01"], reqs=[], tests=[],
  do="Needed from Harsh, guided click by click: a staging database and its user with exactly the ten boxes of A3 ticked (Select, Insert, Update, Create, Alter, Index, References, "
     "Trigger, Create temporary tables, Lock tables) and Delete, Drop, Create view, Show view, Execute, Create routine, Alter routine, Event UNticked, **and a second scratch "
     "database with the same ten boxes** (for the proofs of OPS02a and OPS02w and the restore drills). **Ask for these EARLY: Hostinger makes a restore point once a day and "
     "a database can be restored only from a point taken after it exists (OPS02w waits for that).** Remote MySQL allowed for his own current address only, only while a "
     "tool needs it; the database password typed by him into the app's environment variables or a hidden prompt, never in chat. Latest day: the day OPS02w should start.",
  done="hPanel shows the staging database and the scratch database; the ten-box list is checked by OPS02a and by OPS03's start-up check.", rollback=RBN)

T("PH05b", "PH", "WITH-HARSH: remove the two proof apps, then create the staging Node app from the private repository under the two staging names",
  who="WITH-HARSH", lead=(0, 1), deps=["PH02", "PH03", "PH05", "OPS01", "OPS02a"], reqs=[], tests=[],
  do="Needed from Harsh, after OPS01 and OPS02a are done (the proof apps are still needed until then): remove the runtime proof app, the database proof app and the database "
     "`u992795260_proof` (**removing an app frees its domain name**); add a Node.js web app for staging from the private repository (branch `staging`) and give it "
     "`billing-api-staging.jaishrigoldpalace.com`; `billing-staging.` stays with Vercel (PH04). **Connecting a domain renames the site's folder** (API-00C-RESULTS section 7), so "
     "`JV_BACKUP_DIR` and the cron commands are typed only AFTER the domain is connected, with `JV_BACKUP_DIR` at the default `/home/<user>/jv-backup` outside `domains/`. "
     "Latest day: before OPS03a.",
  done="hPanel shows the staging app under its name; no proof app and no `u992795260_proof` is left.", rollback=RBN)

T("PH06a", "PH", "WITH-HARSH: the backup key pair, the token hashes and the Actions secret (needed for the first full staging deploy)",
  who="WITH-HARSH", lead=(1, 4), deps=["PH01", "API09"], reqs=["O40"], tests=[],
  do="Needed from Harsh before OPS03, once the two tools exist (`npm run keygen` and `npm run make-token`, both of API09): make the backup key pair on his Mac (the private key kept as a file in his password manager, a second copy for Siddhi on a USB stick in "
     "a sealed envelope or in her password manager, never on the server or in the repository, O40); the admin token and the job token, of which only the HASHES go "
     "into the app's environment (`npm run make-token` prints each token and its hash once; a Hinglish line in the runbook draft tells him how; no token is ever typed in chat); the GitHub Actions secret for the job token. "
     "Each tool on his Mac (migrations, import, restore, the pull) asks for the database password at a hidden prompt or reads a local file outside the repository that he "
     "creates himself; Claude never types, stores or echoes it; Remote MySQL needs his current public address, re-entered in hPanel at each window and removed after.",
  done="The public key is in the staging environment; the private key is in his password manager; the token hashes and the Actions secret are set.", rollback=RBN)

T("PH06b", "PH", "WITH-HARSH: security and accounts for go-live (two-step login, plan and domain renewal, certificates)",
  who="WITH-HARSH", lead=(2, 10), deps=["PH01"], reqs=["B6", "O46"], tests=[],
  do="Needed from Harsh before go-live: two-step login on GitHub, Hostinger, Vercel, the Hostinger account that holds the domain and the DNS (the same account as the hosting) and the password "
     "manager; the Hostinger plan renewed with auto-renew ON and a calendar reminder 30 days before the end date (it expires on 22 March 2027; the hosting promised to Siddhi "
     "runs to 30 April 2027; set the reminder for 20 February 2027); **the yearly renewal of `jaishrigoldpalace.com` (Siddhi's domain, registered in Harsh's account until hand-over): who pays it (default: Siddhi), its price stated by Harsh, a calendar reminder 30 days before the domain's renewal date, "
     "and the renewal price and term of the Hostinger plan, all written in the go or no-go list** (this plan buys nothing); the database and the plan are never deleted without Harsh "
     "and the owner both agreeing in writing; Hostinger issues 90-day Let's Encrypt certificates (the staging ones expire on 15 Jan 2027): a reminder to look at them before; "
     "read hPanel's Details for the plan's real limits (version, database size, backup retention, O46). Latest day: all of it ticked in the go or no-go checklist (QA04).",
  done="The go or no-go checklist (QA04) shows each item ticked with a date; the renewal dates and the reminders are written down.", rollback=RBN)

T("PH07", "PH", "WITH-HARSH: the decisions he may veto (every open item with a default)",
  who="WITH-HARSH", lead=(0, 3), deps=["PH01"],
  reqs=["O8", "O17", "O18", "O19", "O22", "O32", "O36", "O39", "O41", "O43", "O44", "O51", "O52", "O54", "O55", "O56"], tests=[],
  soft_before=["API08", "API09", "API17", "API20", "API24", "API35", "WEB12"],
  do="Needed from Harsh: either 'defaults stand' or a different answer for each of these, in one reply: O8 opening balances as ordinary "
     "rows; O17 old Credit payments not carried over; O18 all bills in memory in M1; O19 database tests on the local Docker MariaDB "
     "(creating the Hostinger staging app needs his OK, PH05b); O22 per-line rounding to paise (a ruling: the bill total "
     "differs by Rs 1 from the prototype on about 0.8 percent of bills); O32 the Reports date controls and exports hidden in M1 "
     "(his option: the Reports fix in M1, about 0.5 day); O36 the region; O39 the website stays on Vercel Hobby with the terms risk "
     "his own; O41 the admin door shut after the first owner and no route changes a role; O43 the staging app stays after "
     "go-live; O44 go on Hostinger, the proof being a hard gate (a priced VPS comparison if it fails); O51 no DELETE at all; O52 "
     "a walk-in silver settlement names its bill; O54 the weekly pull to his Mac (yes, and it is his duty); O55 the login "
     "throttle of A13 as written; O56 the photo caps (60 unattached photos or 100 MB). Latest day: before the task that "
     "uses each one (the earliest are O22 and O52, before API20 and API24).",
  done="The ledger shows 'defaults stand' or the changed answer for each item, with the date.", rollback=RBN)

T("PH08", "PH", "WITH-HARSH: go-live day steps in Vercel, hPanel and on his Mac",
  who="WITH-HARSH", lead=(0, 1), deps=["QA04"], reqs=[], tests=[],
  do="Needed from Harsh on the cut-over day, each in the checklist: merge `api-web` into `main` of `jewelvault-app` in GitHub Desktop and push, so that Vercel builds production from the new code (a redeploy of the old `main` would ship the old demo; to roll back he promotes the previous deployment); set `NEXT_PUBLIC_API_URL` to the production API in the "
     "Vercel project and REMOVE `NEXT_PUBLIC_PREVIEW_MODE` there (preview mode must not exist in the live build; WEB15 "
     "removed the code, this removes the variable), redeploy and wait; switch Remote MySQL OFF again after the import "
     "window; remove `JV_ADMIN_TOKEN_HASH` from the production environment once the first owner exists (O41 default); check "
     "that both cron jobs show in hPanel's list; start the weekly pull on his Mac (O54) and put the monthly Download "
     "everything in Siddhi's calendar. Latest day: the cut-over morning.",
  done="The checklist shows each step ticked with the time; the live site opens on the login screen.", rollback="Vercel: promote the previous deployment; hPanel: re-tick Remote MySQL only for the time a fix needs.")

# =============================================================================================== PEOPLE: SIDDHI AND HER CA
T("PS01", "PS", "WITH-SIDDHI: the data request, items 1, 3 to 8 (how she bills, GST invoices, staff, devices, testers, Order Book, printer, rates)",
  who="WITH-SIDDHI", lead=(3, 7), deps=["PH01"], reqs=["H6", "O30"], tests=[],
  do="Harsh sends Siddhi the eight-item data request of `PLAN.md` section 6 in Hinglish (no questionnaire, no new paper). Needed: "
     "(1) how she bills today, whether she is GST-registered and who issues her GST invoices (decides whether estimate-only "
     "billing is safe and whether paper is a real fallback); (3) the staff list with roles (Owner, Biller, Staff) and who owns the "
     "accounts; (4) the devices at the counter (PC and phone, model and browser; Next.js 16 needs Chrome 111 or newer); "
     "(5) two named testers and the two days they are free; (6) whether she takes custom orders in the app (Order Book) and how "
     "often; (7) the printer model and a photo of a tag roll; (8) today's gold and silver rates by purity. Status on 16 Oct "
     "2026: not known to have been sent; the plan treats it as NOT sent. Latest day: answers 1 and 3 to 5 are needed for the "
     "UAT dates (QA02) and the logins (OPS07); the devices before QA04.",
  done="Written answers in the ledger; the device check (H6) is ticked for each counter device.", rollback=RBN)

T("PS02", "PS", "WITH-SIDDHI: a sample of her stock list and customer balances (ten rows each), to write the converter",
  who="WITH-SIDDHI", lead=(3, 8), deps=["PH01"], reqs=[], tests=[],
  do="Asked in the same message as PS01. Needed from Siddhi: ten rows of her stock list (Excel, or a photo of her register) with her existing piece codes, and ten "
     "customer balances (dues, fine, advances), exactly in the shape she keeps them. Nobody has seen the sheet; the converter "
     "(IMP01) cannot be written before. Latest day: IMP01 must finish with enough time for the staging rehearsal (IMP02).",
  done="The sample is in `jewelvault-api-design/siddhi-data/` (outside the repository) and Harsh has checked that no one else's "
       "private data is in it beyond what the shop already holds.", rollback=RBN)

T("PS03", "PS", "WITH-SIDDHI: the full, final stock list and customer balances (and how many designs and photos)",
  who="WITH-SIDDHI", lead=(7, 16), deps=["PH01"], reqs=["O47"], tests=[],
  do="Asked in the same message as PS01. Needed from Siddhi: the complete stock list with her codes and all customer balances (dues, fine, advances) as of the day "
     "before cut-over, plus how many designs she has and how many photos each (decides whether photos stay in the "
     "database: about 2,600 to 3,300 designs is the limit, O47). The stock list changes every day, so the final version is "
     "taken on the cut-over eve (IMP03); a first complete version is needed earlier for the staging rehearsal (IMP02). "
     "If her list is not usable, go-live slides day by day and Harsh tells her.",
  done="IMP02's reconciliation runs on the first complete version with no unexplained difference.", rollback=RBN)

T("PS04", "PS", "WITH-SIDDHI: her business answers (every default stands unless she changes it)",
  who="WITH-SIDDHI", lead=(3, 10), deps=["PH01"],
  reqs=["O1", "O3", "O4", "O5", "O6", "O7", "O9", "O10", "O11", "O12", "O13", "O21", "O23", "O24", "O25", "O26", "O27", "O33", "O37", "O42"],
  tests=[], soft_before=["API20", "API22", "WEB08"],
  do="Needed from Siddhi, in plain Hinglish, one reply with defaults ready: O1 piroi in rupees; O3 who cancels, re-issues, "
     "voids, refunds (owner only) and the date rules; O4 who sets rates; O5 staff do not enter the hidden weight; O6 the "
     "walk-in on credit; O7 reserved pieces billed after a confirmation; O9 piroi once per line; O10 e-mail logins; O11 photos "
     "public with unguessable addresses; O12 whole rupee always; O13 a By Weight piece one at a time; O21 the size caps; O23 an "
     "advance applied by itself; O24 how a cancel keeps the money; O25 the biller reads all customers and the cash book for "
     "today and yesterday; O26 report only, nothing blocked; O27 purities with no rate; O33 the mobile rule; O37 the weight "
     "rules; O42 session times (12 hours idle, 14 days). Latest day: the money screens (WEB08) are built on the defaults; a "
     "different answer after that is a change request that costs days.",
  done="The ledger shows 'defaults stand' or the changed answer for each, with the date.", rollback=RBN)

T("PS05", "PS", "WITH-CA: the tax and law points only her CA can settle",
  who="WITH-CA", lead=(5, 20), deps=["PH01"], reqs=["O2", "O14", "O15", "O16", "O20", "O31", "O34"], tests=[], soft_before=["QA04"],
  do="Needed from Siddhi's CA (not blocking; the defaults ship): O2 how silver fine is worked out and whether silver settled in "
     "cash is a sale or a receipt; O14 the cash limit and the PAN rule (thresholds, at or above, parts of one transaction, block "
     "or warn); O15 estimates only or tax invoices by GST status; O16 BIS and hallmark particulars; O20 the 'NW' label; O31 calendar "
     "or financial-year bill numbers; O34 how long books and audit are kept and what erasure means for a customer. The spec "
     "states no section number as law. A different answer on O2, O14 or O31 is a pricing version 2 or a constant, not a rewrite.",
  done="Written answers, or 'defaults accepted', in the ledger.", rollback=RBN)

T("PS06", "PS", "WITH-SIDDHI: told in plain words what the backups do and do not protect, and her monthly duty",
  who="WITH-SIDDHI", lead=(0, 3), deps=["PH06a"], reqs=["O28", "O45", "O53"], tests=[],
  do="Harsh tells Siddhi (the words are in spec B2/O45): the database, every export and the photo copy are in ONE Hostinger "
     "account at one company; a bad deploy or a damaged database is repaired from the nightly export, but if the account is lost "
     "what survives is what was copied off it: her monthly Download everything (up to 35 days of entries, no photos, no audit "
     "log) and Harsh's weekly pull (about a week of entries); up to 24 hours of entries can be lost in a disaster and the bill "
     "numbers of that time are given again to new bills; the plan ends on 22 March 2027. She takes her copy of the backup key "
     "(O40). She starts the monthly download (the card turns amber at 28 days). Latest day: before go-live; written into the go "
     "or no-go checklist.",
  done="Siddhi has said she understood (in writing, WhatsApp is enough); the first Download everything date is on the card.", rollback=RBN)

T("PS07", "PS", "WITH-SIDDHI: her two testers (two days) and her signature on the opening balances",
  who="WITH-SIDDHI", lead=(1, 5), deps=["PH01"], reqs=[], tests=[],
  do="Needed from Siddhi: the two named testers for two working days of acceptance (QA02), the 45-minute training slot with the "
     "shop closed (QA03), and her signature on the opening balances at cut-over (IM6, QA05). Not in Dhanteras week.",
  done="Dates agreed and written in the ledger.", rollback=RBN)

# =============================================================================================== OPS: Hostinger
T("OPS01", "OPS", "API-00c part 1 (WITH-HARSH): Safari and Firefox on the real names, and the real pair with the website on Vercel",
  agent="C", repo="api", lo=0.5, hi=1.5, grp="ops", who="WITH-HARSH", deps=["PH04", "API07", "API05", "API09"],
  reqs=["O48"], tests=[], gate="G-H", tripwire="TW3: if the `__Host-` SameSite=Strict cookie fails in Safari or Firefox on the real names, or Safari caps it at 7 days, or the website name pointing at Vercel breaks the same-site rule, STOP and re-plan the name pair or put the API behind the website's own origin by a Vercel rewrite (A12). That costs about 1 to 2 plan-days of WEB01/WEB02/API07 and is Harsh's decision.",
  note="Done on 17 Oct 2026 (API-00C-RESULTS.md section 5): `jaishrigoldpalace.com` (Siddhi's domain, registered by Harsh in his own Hostinger account); `billing-staging.` and `billing-api-staging.` connected through the Add-domain wizard (no DNS work by hand), Let's Encrypt certificates (17 Oct to 15 Jan 2027), the cookie, CORS and image flow passed in Chrome 155. NOT repeated here. Still open: Safari and Firefox on the real names, Safari's 7-day cap, and the real pair (website on Vercel, API on Hostinger).",
  do="Through Harsh's logged-in hPanel (Claude drives, Harsh watches and types any password himself): with the website name pointed at a Vercel project (PH04) that serves a static test page (one HTML file that the orchestrator makes from the Chrome page of 17 Oct, committed on `api-web` and shown by a Vercel preview; the real screens need WEB02) and the "
     "API on its Hostinger name, deploy the API skeleton with login (API01 to API07 and API09, by zip upload to the runtime proof app that still carries `billing-api-staging.`; the GitHub deploy is OPS03a) and check, in Safari and Firefox "
     "(Chrome again for the pair): login from the website's origin sets `__Host-jv_session`, it survives a reload, a `PATCH` and a `POST` with `X-JV-Client` and "
     "`Idempotency-Key` pass their preflight, a request from another origin gets no cookie and no allow-origin header, photos load in `<img>`; read whether Safari caps the "
     "cookie at 7 days. Result: an addendum to `HOSTINGER-SPIKE.md` that turns 'GO, provisional' into GO or NO-GO.",
  files=[], done="The addendum states each of the lines for Chrome, Safari and Firefox with the exact names used, and the verdict G-H: GO or NO-GO. A NO-GO goes to Harsh "
                 "(O44: a priced VPS comparison before any money is spent).",
  rollback="Nothing durable: the proof pages are removed afterwards by Harsh (PH05b).")

T("OPS02a", "OPS", "API-00c part 2a (WITH-HARSH): Hostinger-only proofs that need no code",
  agent="C", repo="api", lo=0.5, hi=1.0, grp="ops", who="WITH-HARSH", deps=["PH05"],
  reqs=[], tests=[], gate="G-H",
  note="Answered on 17 Oct 2026 (API-00C-RESULTS.md section 6, view only): Hostinger keeps 19 restore points (14 daily from 2 Oct to 15 Oct, weekly back to 30 Aug); the newest listed on 17 Oct was 15 Oct 13:56 (a 16 Oct backup was missing: a backup can be skipped without a message); database export files are excluded; 'Restore database' restores in place only (no other target), so the plan's 'restore into a NEW empty database' uses the downloaded dump; a database created after a restore point cannot be restored from it. A file of 10,442 bytes was downloaded from the File Manager in the browser, byte for byte.",
  do="On the scratch database of PH05 (ten-box user) and with the kit `jewelvault-proof`: (1) is OPS02w (the wait for a restore point is calendar time and must not hold this task); (2) Remote MySQL from Harsh's Mac as the ten-box user, paced at 10 connections in 1.2 s (the migration and import window, S1); (3) the SFTP read of the backup folder with Harsh's login (port 65002) OR the browser download of a larger file and its sha256 (the weekly pull, O54); (4) the database size in hPanel against the figure the health query computes; (5) `START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT` and the audit triggers' session variables (kit step S07b) as the ten-box user; (6) `mariadb-dump` over SSH only if someone with SSH is at hand (parked, optional).",
  files=[], done="A third addendum to `HOSTINGER-SPIKE.md` lists each of these with PASS, FAIL or UNKNOWN and the date. Any FAIL is a finding for Harsh, and **an UNKNOWN keeps gate G-H shut** until it is run.",
  rollback="The scratch databases are removed by Harsh; nothing production exists yet.")

T("OPS02w", "OPS", "API-00c part 2a-wait (WITH-HARSH): Hostinger's own restore point after the scratch database exists, and a restore into a second database",
  repo="api", lo=1.0, hi=2.0, grp="ops", who="WITH-HARSH", deps=["PH05"],
  reqs=["B1"], tests=[], gate="G-H",
  note="Calendar time, not work: Hostinger makes one restore point a day, a 16 Oct backup was missed without a message, and a database created after the newest point cannot be restored from it. The newest listed on 17 Oct was 15 Oct 13:56. The restore page offers 'Restore database' in place only (no other target).",
  do="Count the restore points on the day PH05 created the scratch database and on each later day until one is newer than the database (1 to 2 working days; longer if a backup is skipped). Then: restore the SCRATCH database from that point in place (it holds only test rows), "
     "download that database's dump and load it into a SECOND empty database (B1, a go-live condition). Harsh looks at the page once a day; no agent time is used.",
  files=[], done="The restore-point count with dates, the in-place restore of the scratch database and the load of the dump into a second empty database are written in the third addendum to `HOSTINGER-SPIKE.md` with PASS, FAIL or UNKNOWN (an UNKNOWN keeps G-H shut); if Hostinger's own backups prove unreliable the weekly pull and the monthly download are the real second copies and PH06b/PS06 say so.",
  rollback="The scratch databases are removed by Harsh; nothing production exists yet.")

T("OPS03a", "OPS", "Walking-skeleton deploy through the GitHub app: build, entry file, cron path, double start, rollback (WITH-HARSH)",
  agent="C", repo="api", lo=0.5, hi=1.5, grp="ops", who="WITH-HARSH", deps=["PH02", "PH05b", "API07"],
  reqs=[], tests=[],
  do="The biggest unknown is the first GitHub deploy: only zip uploads have ever been tried. As soon as the GitHub repository (PH02) and the staging app (PH05b) exist and "
     "API01 to API07 are merged, Harsh pushes the `staging` branch with the walking skeleton (health route, the CORS, CSRF and header layers, the start-up check against the "
     "staging database); Hostinger builds it with `tsc` on its side. Learn and write down in `DEPLOY.md`: the build and start settings, the entry file `dist/server.js`, the real "
     "path of `scripts/job.js` in a Git-built app (the 161-character base of the cron command came from a zip-uploaded app), the double start 10 seconds apart, the time "
     "from push to live, a revert-and-redeploy tried once, an environment-variable change, and the cron command length with the real names (227 characters for "
     "`billing-api.jaishrigoldpalace.com`, 243 for `billing-api-staging.`: fits 255, and `> /dev/null 2>&1` fits only the production name; the rule of the additive-only "
     "migration in the release week, so that a revert never runs old code on a newer schema).",
  files=[], done="`DEPLOY.md` exists with the measured times and the real paths; the staging site answers `/healthz` from a GitHub deploy; one deliberate bad commit was reverted and "
                 "redeployed; the elapsed time of this task is written in `docs/unit-samples.csv` (tripwire TW-ops).",
  rollback="Revert the staging branch and push; or remove the staging app (Harsh). Staging holds test data only.")

T("OPS02", "OPS", "API-00c part 2b (WITH-HARSH): the proofs that need the code, with exactly the ten boxes",
  agent="C", repo="api", lo=0.5, hi=1.0, grp="ops", who="WITH-HARSH", deps=["OPS01", "OPS02a", "OPS02w", "OPS03a", "API02"],
  reqs=[], tests=[], gate="G-H",
  note="Answered on 16 Oct 2026 (API-00C-RESULTS.md, a miniature kit on the DB proof app, about 55 minutes of two Custom cron jobs, both deleted afterwards): a unix-socket connection IS counted against the new-connection limit (45 tried, 20 passed), the window is about 1 second, the sustained limit is about 20 a second, and the budget is SHARED by every process of the same database user (the app, a cron-run script, other apps, probably WordPress); `GET_LOCK` works and a lock left on a pooled connection stays held until `RELEASE_LOCK` or `destroy()`; a Custom cron job runs the hPanel Node command and a miniature dump (GET_LOCK, one REPEATABLE READ snapshot, 26 tables, 518 rows, gzip, AES-GCM, `.partial`, `fsync`, `link()`) ended in 275 ms with 72 MB resident, and a second run the same day ended at once; `link()` works and a second `link` answers EEXIST; the Custom command field takes at most 255 characters; `statfs` shows the whole server's volume. These are NOT repeated here.",
  do="On staging with the ten-box user and the real code: the whole database suite again as the API user (the 15 Oct proof and the 16 Oct kit ran with all boxes ticked); the budget of "
     "new connections with the app (pool of 8), a running dump script (pool of one) and the plan's other apps all at once (the proof apps are gone by then, PH05b): a refused "
     "connection is retried once then `JV_BUSY`; a Custom cron job whose command has the length of the real dump command for the real site name (it runs the proof kit's stub script; the real dump script is API34 and its cron job is OPS03), listed in hPanel and deletable; a scheduled GitHub Actions run that "
     "calls a stub endpoint (the real tick and workflow are OPS03); `SIGTERM` and the memory ceiling; the proof kit's dump scaled to a size near year 5 (about 400 MB) against a CPU or process kill.",
  files=[], done="A fourth addendum to `HOSTINGER-SPIKE.md` lists each of these with PASS, FAIL or UNKNOWN; any FAIL is a finding for Harsh and an UNKNOWN keeps gate G-H shut.",
  rollback="Any test cron job is removed by Harsh; nothing production exists yet.")

T("OPS03", "OPS", "First staging deploy: migrations, cron jobs, GitHub Actions, deploy and rollback tried",
  agent="C", repo="api", lo=1.0, hi=2.0, grp="ops", who="WITH-HARSH", deps=["OPS02", "OPS03a", "API33", "API33b", "API34", "PH02", "PH05b", "PH06a"],
  reqs=["H5", "O49"], tests=[], extends=["T-R04"],
  do="Harsh pushes the API repository's `staging` branch; Hostinger builds it (`tsc` on its side, entry `dist/server.js`); "
     "the domain name is connected FIRST (connecting renames the site folder under `~/domains/`), and only then are the environment variables typed by Harsh in hPanel (database host `127.0.0.1`, the allowed origins, the admin token HASH, "
     "the job token hash, the backup public key, `JV_BACKUP_DIR` as one absolute path); the migration files are applied from "
     "Harsh's Mac through Remote MySQL as the ten-box user, paced, with Remote MySQL switched off again afterwards (or pasted in "
     "phpMyAdmin if Remote MySQL fails); the first owner is made with the admin command; the start-up check passes on the real "
     "server; two hPanel Custom cron jobs (hourly `curl` to the tick; hourly Node dump script) show in the list; the "
     "scheduled workflow calls the tick and `jobs/health`; deploy and ROLLBACK are tried once on purpose: a bad commit is pushed, "
     "then reverted and pushed again (the app starts twice about 10 seconds apart; nothing is tested for 30 seconds; "
     "deploys and environment changes only when the shop is closed in production). O49 is decided from what worked.",
  files=[], done="`T-R04`'s hPanel half passes: both cron jobs fire (the tick's `sys_job_runs` row appears), the workflow run is green, "
                 "`jobs/health` answers 200; `DEPLOY.md` records the exact steps and the revert-and-redeploy rollback with the times it "
                 "took; the staging site answers `/healthz`.",
  rollback="Revert the staging branch and push; or remove the staging app (Harsh). Staging holds test data only.")

T("OPS08", "OPS", "Three nights of the nightly check on staging (time passes; Harsh reads the result each morning)",
  repo="api", lo=3.0, hi=5.0, grp="ops", who="WITH-HARSH", deps=["OPS03"],
  reqs=[], tests=[],
  do="No work: the hourly tick and the dump script run on staging for three nights in a row, and Harsh reads `GET /v1/health/checks` "
     "and the dashboard line each morning (the same routine he keeps for the first two weeks after go-live). A red line or a missing "
     "`check_runs`/`backup_runs` row on any night restarts the count.",
  files=[], done="Three consecutive mornings with 'Books: OK at 02:00', a good export and a good photo copy under 26 hours old.",
  rollback="Nothing to roll back.")

T("OPS04", "OPS", "Staging real-network checks: 10-second hydrate, cold start, three browsers, headers",
  agent="C", repo="api", lo=1.0, hi=2.0, grp="ops", who="WITH-HARSH", deps=["OPS03", "WEB06", "WEB12b", "WEB13", "WEB14", "WEB15", "WEB16", "PH04"],
  reqs=[], tests=["T-E10"], extends=["T-F03", "T-D12"], gate="G-E",
  do="The static site on a Vercel preview with `NEXT_PUBLIC_API_URL` set to the staging API; on the staging pair of names "
     "(`billing-staging.` and `billing-api-staging.` of Siddhi's domain (registered in Harsh's account), once PH04 is in): the first hydrate of the C2 volumes "
     "(2,500 pieces, 2,000 customers, 3,000 bills, seeded by `scripts/seed-volume.mjs` of API12) in under 10 seconds on a 4G profile, "
     "repeated with the browser throttled; the first call after a long idle (cold start) timed; T-E10 in Chromium, WebKit and "
     "Firefox (login, reload, PATCH edit, POST with the custom headers, another origin refused, photos in `<img>`); T-D12 "
     "with `curl -I` on the staging host; the whole Playwright suite against staging with fake data; a two-browser poll test across "
     "the real network.",
  files=[], done="A log with the measured hydrate time, the cold-start time and the three-browser result; T-E10 passes; a miss on the "
                 "10 seconds is a finding (O48), not a silent change of the budget.",
  rollback="Staging only; nothing to roll back.")

T("OPS05", "OPS", "Backup drills on the real plan: folder checks, restore drill 1, balances from the zip, the pull",
  agent="C", repo="api", lo=1.0, hi=2.0, grp="ops", who="WITH-HARSH", deps=["OPS04", "API36", "API35", "WEB12b", "API09", "PH06a"],
  reqs=[], tests=["T-R01"], extends=["T-R02", "T-R05", "T-R06", "T-E09"], gate="G-B",
  note="The pulled-forward tools (API36: restore-cli, backup-remote, zip-balances) were tested with a dump made by MB03's writer; here they meet API34's real dump (the pull requires `backup_runs.detail.export = {name, sha256, size}` for every dump), SFTP on port 65002 and the browser-download path with real files, drill 1 with a deliberately missing photo, the key holders' proof, and the zip-balances drill.",
  do="On staging, with data: T-R01 the nightly export in `daily/` and the photo copy in `photos/` exist in `jv-backup/`, are still there "
     "after a redeploy and are not reachable over HTTP, the export decrypts with Harsh's private key (the owner's copy is proved by Siddhi herself at the "
     "training, QA03), a failed run is visible; restore DRILL 1 with the restore "
     "CLI from the folder over SFTP (or the browser download) into a throw-away MariaDB 11.8 in Docker on Harsh's Mac in under "
     "2 hours, with one photo deliberately missing, equal row counts, equal photo hashes, 20 photos open, the nightly check "
     "passing, the folder unreachable over HTTP; the T-R05 drill rebuilds each customer's balance (`outstanding`, "
     "`advance`, `fine_outstanding`) from the zip alone and compares it with `customer_balances`; the T-R06 drill pulls the "
     "newest export and the new photos with Harsh's login (the download-by-hand path of the File Manager, which worked on 17 Oct, FIRST; SFTP second, it is untried), checks their hashes and reports the pull through the admin "
     "door; Harsh runs each of the three admin commands once from the runbook draft (T-E09 DRILL), and **performs the pull and the first three restore steps himself** with "
     "a script (he could not run an SSH command on his own on 15 Oct): the person who restores one day is not Claude.",
  files=[], done="The drill log (times, counts, hashes, who held which key) is saved in `docs/drills/`; every check of T-R01 (except the owner's own copy of the key, which Siddhi proves at the training, QA03), T-R05 "
                 "and T-R06's DRILL halves and T-E09's DRILL half is ticked; drill 1 took under 2 hours.",
  rollback="The target is a throw-away Docker database; staging is untouched.")

T("OPS06", "OPS", "The two-page runbook, deploy and rollback sheet, break-glass sheet, morning check routine",
  agent="C", repo="api", lo=0.5, hi=1.5, grp="ops", who="WITH-HARSH", deps=["OPS05", "OPS03"],
  reqs=["B5"], tests=["T-R02"],
  do="Two pages (`RUNBOOK.md`): restore (the production restore steps of B5: a NEW database, Remote MySQL for his address only, "
     "the restore tool paced, change the app's database variables when the shop is closed and redeploy, keep the old database, "
     "switch Remote MySQL off, tell the owner which bill numbers were given again; **a warning in capitals: hPanel's own 'Restore database' button overwrites the live database in place and offers no other target, so it is never the production restore**), the two commands that make the tokens and the key pair (`npm run make-token`, `npm run keygen`, with a Hinglish line each), add or deactivate a user and reset a "
     "password with the admin command, change a rate, deploy and roll back by a revert commit, rotate a secret (an environment "
     "change, so a redeploy at closing time; rotating the job token also means updating the cron command and the Actions "
     "secret), 'the host is down', who to call, how to fix a row by hand (only an UPDATE that leaves `updated_at` out, or ending "
     "with `UPDATE ... SET updated_at = NOW(6)` and a new `data_epoch`), the one planned purge (tick Delete for minutes), the "
     "owner's monthly Download everything and Harsh's weekly pull, and reading the nightly check each morning for the first two "
     "weeks; plus a one-page paper break-glass sheet for the shop (what to do when the internet or the system is down: "
     "write the paper bill, enter it later; and a line that the domain sits in Harsh's Hostinger account until hand-over, with whom to call). The runbook is accepted when someone who did NOT write it follows it to "
     "restore the throw-away copy.",
  files=[], done="A fresh agent (standing in for the person) follows `RUNBOOK.md` alone and restores the staging export into a Docker "
                 "database in under 2 hours (T-R02), writing down every step that was unclear; the unclear steps are fixed and the "
                 "run is repeated once.",
  rollback=RBN)

T("OPS07", "OPS", "Production: app, database, domain, cron jobs, first owner, the real pair, restore drill 2",
  agent="C", repo="api", lo=1.0, hi=2.0, grp="ops", who="WITH-HARSH", deps=["OPS06", "RV1", "RV2", "RV3", "PH06b", "PH04", "OPS04", "IMP02"],
  reqs=[], tests=[], extends=["T-D12", "T-E10"],
  do="With Harsh at hPanel, in a closing-time window: the production Node app (branch `main`) and database with exactly the ten "
     "boxes; the domain connected first, then the environment variables typed by Harsh (never in chat; `JV_BACKUP_DIR` and the cron commands only after the domain is connected); migrations through Remote MySQL, then Remote MySQL OFF; the "
     "seeds of D20 only; the first owner by the admin command; both Custom cron jobs and the workflow; the real domain "
     "connected; the Vercel production project pointed at the production API; **the real pair is tested once: T-D12 (headers "
     "by `curl -I`) and T-E10 (three browsers) on the website on Vercel and the API on Hostinger under the real domain "
     "(H5, a go-live condition)**. **Restore DRILL 2 is done with real data**: after the staging rehearsal (IMP02) the staging export with her real data and photos is restored into a "
     "SECOND Hostinger database through Remote MySQL (the path production would use) and timed; it is repeated on the cut-over eve after IMP03 if time allows; the second database is left for Harsh "
     "to remove. Production holds no customer data until the import (IMP03), so a drill on an empty production export would prove nothing.",
  files=[], done="The production site answers `/healthz`; the start-up check is green; T-D12 and T-E10 pass on the real pair; "
                 "drill 2 is logged under 2 hours; the cron jobs are listed.",
  rollback="Before the import nothing real exists: remove the production app and database (Harsh) and start again. After the import: restore into a new empty database (RUNBOOK).")

# =============================================================================================== IMPORT
T("IMP01", "IMP", "Converter from Siddhi's sheet (and the old browser export) to an import pack",
  agent="C", repo="api", grp="pure", pd=1.2, deps=["PS01", "PS02", "MB04"],
  reqs=["IM7"], tests=[], ptests=["PT-I1 the converter turns the sample sheet into a pack that the import accepts with RESULT: OK, lists blank or invalid mobile numbers, and keeps her piece codes"],
  do="`scripts/convert-sheet.mjs`: reads her sheet (Excel or CSV exported from it) in the shape PS02 showed and writes the pack "
     "of `IMPORT-GUIDE.md` (customers with dues, fine and advances; designs with pieces and her own `design_no`, `sku_no` "
     "and `barcode`; the semi-wholesale average of R1 (3); mobile numbers normalised), and, ONLY IF PS01 says the shop really entered data in the old browser build, reads that build's "
     "export once (`jaishri.*` keys saved by hand) for stock and customers' dues only (not old estimates unless Siddhi asks; "
     "old `Credit` payments never, O17; 0.2 to 0.3 plan-days, skipped otherwise); nothing is guessed: a row it cannot read is listed.",
  files=["scripts/import-cli.mjs", "IMPORT-GUIDE.md"],
  done="`node scripts/convert-sheet.mjs --sheet sample.xlsx --out pack.json && node scripts/import-cli.mjs --pack pack.json --dry-run` "
       "on a lane database prints RESULT: OK; a piece code typed in either case finds the piece on the billing screen "
       "(checked in IMP02).",
  rollback="Local: `git revert`; nothing is applied anywhere real.")

T("IMP02", "IMP", "Staging rehearsal of the import with her real data and the reconciliation",
  agent="C", repo="api", lo=1.0, hi=3.0, grp="ops", who="WITH-SIDDHI", deps=["IMP01", "PS03", "OPS03", "OPS04"],
  reqs=["IM8"], tests=[],
  do="On the STAGING database (IM8: staging first, always): a dry run, then the real run of the first complete version of her data; "
     "the reconciliation report (counts by table, total opening dues and fine against her sheet, each customer's outstanding against "
     "the source) goes through Harsh to Siddhi in plain Hinglish; blank or invalid mobile numbers are listed for her; "
     "a code typed on the staging billing screen finds its piece; the nightly check passes on the imported data; the "
     "screens reload after the import (`data_epoch`); a bill on an imported customer keeps I5 and I10 green. **A correction loop is inside the estimate (1 to 3 working days):** every bad row "
     "(a duplicate piece code, a blank or invalid mobile number, a disputed balance) costs a round trip to Siddhi, and PS03 is one arrival of data that is usually wrong the first time.",
  files=[], done="`RESULT: OK` on the real data, every difference explained in writing, and Siddhi has seen the report.",
  rollback="Staging only: the batch is refused a second time by name; wipe by a new staging database.")

T("IMP03", "IMP", "Production import on the cut-over eve and Siddhi's signature",
  agent="C", repo="api", lo=0.5, hi=1.0, grp="ops", who="WITH-SIDDHI", deps=["IMP02", "OPS07", "QA04", "PS03"],
  reqs=[], tests=[],
  do="The shop is closed. Harsh allows Remote MySQL for his current address, runs the dry run and then the real run of the "
     "final data (at most 10 new connections in 1.2 s, one transaction per batch, each under 20 seconds, each ending with the "
     "re-stamp and `data_epoch`; the password is typed at a hidden prompt, never in a file or in chat), reads the reconciliation with Siddhi, she signs the opening balances, and Remote MySQL is "
     "switched OFF again (checked in the go or no-go list).",
  files=[], done="The report says RESULT: OK; the signed sheet is photographed into the ledger; hPanel shows Remote MySQL off.",
  note="Plan for the eve, because the stock list changes every day: who produces the final list and balances (Siddhi or her staff), at what hour, and in what shape (the shape IMP01 reads); the fallback, if the final file is bad, is opening balances as of the last day with a clean reconciliation (the rehearsal of IMP02) and the bills of the days since entered afterwards. A first live day right after Bhai Dooj would put the final list straight after the busiest paper week, which is a reason to prefer a first live day after 16 Nov.",
  rollback="Imported designs, pieces and customers cannot be removed one by one (S7), and their codes are unique ignoring case, so a corrected re-run would collide with the first. Right before IMP03 a fresh, drill-tested export of the empty production database is taken. Until the first live bill the rollback is a NEW empty production database, the migrations and a corrected run (nothing real exists before QA05, as OPS07 says); after the first live bill it is the B5 restore. Opening rows alone can be cancelled by X5 and X4.")

# =============================================================================================== QUALITY AND GO-LIVE
T("QA01", "QA", "Full regression on both repositories and the QA critical themes re-run",
  agent="A", repo="api", grp="pure", pd=0.8, deps=["RV2", "RV3", "WEB12b", "WEB13", "WEB14", "WEB15", "WEB16", "API36", "OPS05"],
  reqs=[], tests=[],
  do="Every suite of `jewelvault-api` (`npm run verify` three times) and of `jewelvault-app` (`E2E=1 npm run verify`) green; the "
     "13 QA critical themes of `QA-Report-2026-10-02/findings.json` re-run on staging; every QA Critical and High finding listed "
     "as closed, M1-elsewhere, M2, open-with-reason or [CA] against spec section 14, with the test that proves each closed one.",
  files=[], done="`docs/qa-closure.md` lists all 22 Critical rows (13 themes) and the 46 High rows with a status and the test or reason; no "
                 "Critical is open without a written reason.", rollback=RBR)

T("QA02", "QA", "Acceptance by Siddhi's two testers and the fix loop - gate G-UAT",
  agent="C", repo="api", lo=1.5, hi=3.5, grp="ops", who="WITH-SIDDHI", deps=["QA01", "IMP02", "OPS04", "PS07", "PS01", "WEB15", "WEB16"],
  reqs=[], tests=[], gate="G-UAT",
  do="On staging with her imported data copy and the printed estimate (Harsh makes two tester logins, role biller, with the admin command): both testers complete the day-to-day script WITHOUT help: sign in; "
     "find a customer by name and mobile; add a customer; bill two pieces by code and by scanner; take a part payment and "
     "the rest; settle silver fine in silver and in cash; cancel and re-issue a wrong bill; void a wrong payment; add stock "
     "with photos; change today's rates; print a 1-item, a 6-item and a 40-item estimate; read the evening figures. Anything "
     "they stumble on is logged; Claude fixes with a test first and a fresh reviewer. Two testers, two days, not in "
     "Dhanteras week.",
  files=[], done="Both testers pass the script; every logged problem is fixed, ruled or deferred in writing; the evening figures equal the "
                 "paper book on the test day's data.", rollback=RBN)

T("QA03", "QA", "Training: one 45-minute session, one-page guides, the paper break-glass sheet",
  agent="C", repo="api", lo=0.5, hi=1.5, grp="ops", who="WITH-SIDDHI", deps=["QA02", "OPS06", "PS06"],
  reqs=["O35"], tests=[], extends=["T-R01"],
  do="One session of about 45 minutes with the shop closed; a one-page guide for each task (bill, take a payment, cancel and "
     "re-issue, void a payment, add stock, find a customer, the evening figures, the monthly Download everything); the visible "
     "changes Siddhi will notice are shown, not hidden (O35): bills are read-only (cancel and re-issue), a design's selling "
     "method is locked while it has pieces, 'Number assigned when saved', a mobile number is required, a deactivated "
     "user is logged out at the next poll, the screens reload after an import, a cancelled bill leaves the sales of the "
     "day it was billed on while a void shows on the day it is done; the break-glass sheet is on the counter. **The owner proves her copy of the backup key** (T-R01, B4): she decrypts "
     "a small test file with her own copy, on her own computer, with Harsh beside her.",
  files=[], done="Siddhi can bill, take a payment, cancel and re-issue, add stock and find a customer alone, watched once.", rollback=RBN)

T("QA04", "QA", "Go or no-go checklist - gate G-GO",
  agent="A", repo="api", lo=0.3, hi=0.8, grp="ops", who="WITH-HARSH", deps=["QA03", "OPS07", "OPS08", "PH06b", "PS06", "PS01", "RV4", "WEB15"],
  reqs=[], tests=[], gate="G-GO",
  do="One page, every line ticked with a date and an owner: G-H GO (OPS01, OPS02a, OPS02w, OPS02: no UNKNOWN left); restore points counted and one database-only "
     "restore proved (B1); drill 1 and drill 2 logged under 2 hours; a pulled copy exists on Harsh's Mac and the weekly pull "
     "works; the owner's first Download everything is done; both key holders proved they can decrypt; the Hostinger plan renewed "
     "with auto-renew on and the reminder set (O46); the domain: two-step login on the Hostinger account that holds it, who pays the yearly renewal (default Siddhi, price stated), a reminder 30 days before its renewal date, and the break-glass sheet says it sits in Harsh's account until hand-over; Siddhi told about the backups (O45); two-step login on every account (B6); "
     "devices checked (H6); the nightly check green for the last 3 nights on staging; both cron jobs listed; no `DELETE`/`DROP` "
     "right on (the dashboard line is not amber); `NEXT_PUBLIC_PREVIEW_MODE` removed (WEB15, PH08); Remote MySQL off; the "
     "paper book will be kept in parallel; the date is not between 29 Oct and 11 Nov; **the legal and tax line: data-request item 1 (how she bills today, GST registration, who issues "
     "her GST invoices) is answered and recorded, and either estimate-only billing is confirmed safe or her CA has seen a printed estimate (O15): this can move the date and is outside "
     "the agents' control.**",
  files=[], done="Harsh signs the checklist in the ledger; any unticked line is a no-go.", rollback=RBN)

T("QA05", "QA", "Cut-over day and the first live day",
  agent="A", repo="api", lo=0.5, hi=1.0, grp="ops", who="WITH-HARSH", deps=["QA04", "IMP03", "PH08", "WEB15"],
  reqs=[], tests=[],
  do="Stock changes stop on the eve; IMP03 ran; the Vercel variable steps of PH08 are done; Siddhi signs in as the owner with the "
     "temporary password and changes it (Harsh made the real logins the day before from the staff list of PS01 with `npm run admin -- add-user`: owner, "
     "billers, staff, temporary passwords shown once); the owner enters the day's gold and silver rates by purity; the first real bill is made with Harsh beside her; the paper bill book is "
     "filled alongside for the first ten days (every evening the owner checks three totals: cash, UPI and outstanding, against "
     "the paper book, and Harsh reads the nightly check the next morning); the stock reads exactly as her sheet; a critical "
     "fix needs a test first and a fresh reviewer.",
  files=[], done="The first day's three evening totals equal the paper book or each difference is explained that night.", rollback="The paper bill book is the fallback; a go-back is Harsh's and Siddhi's decision, not a task.")

T("QA06", "QA", "Hypercare: two weeks of morning checks, drill 3, day-30 review (after go-live)",
  agent="C", repo="api", lo=0.5, hi=1.0, grp="ops", who="WITH-HARSH", deps=["QA05"],
  reqs=[], tests=[],
  do="After go-live, not on the way to it: Harsh reads the nightly check each morning for the first two weeks; the freeze (critical "
     "fixes only, each test first and reviewed) runs a week; restore DRILL 3 seven days after go-live; once a month for the "
     "first three months a DRILL reads the workflow run list and the cron log to see that both callers really fired; the first "
     "monthly Download everything and the first weekly pulls happen; a day-30 review: support log, accounts moved to Siddhi's "
     "name if agreed, a priced yearly support plan, the plan's renewal date (22 March 2027) and the 30 April 2027 end of the "
     "hosting period promised to her; **the staging certificate renews before 15 Jan 2027** (Hostinger issues 90-day Let's Encrypt certificates; renewal is unproven), the "
     "reminders for the certificates and the yearly domain renewal are set, and a named human who can restore after day 30 (PLAN.md decision 8) is agreed.",
  files=[], done="Drill 3 logged; the day-30 review written; the renewal reminder confirmed.", rollback=RBN)
