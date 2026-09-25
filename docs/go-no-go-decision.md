# Go / no-go decision record

Story 9.5 (`epics.md`), traces to PRD §6.1 (sequencing gate), A-5, depends
on Stories 9.1–9.4. One explicit decision that the launch gate is met,
recorded here every time it's assessed (append a new dated entry each
time — never edit a past entry's own verdict).

**This document does not decide GO.** Every condition below needs
verification against a real, live, deployed account — nothing this build
session did includes an actual deployment (`wrangler` was never run). What
this record DOES do: state, honestly and with evidence, the CURRENT status
of every gate condition the AC requires, as of the date below, so the
owner can see exactly what's left before making the call.

---

## Assessment — 2026-09-25

**Verdict: NO-GO.** Several conditions are not yet met, all for the same
underlying reason: nothing has been deployed to production in this
session (a hard, deliberate constraint — no `wrangler` command was ever
run). This is expected at this stage, not a defect.

### Gate conditions

| Condition | Status | Evidence |
|---|---|---|
| Epics 3–8 done | **Built + reviewed, not "done" in the tracker's own sense** | Every story in Epics 3, 4, 6, 7, 8 is at `sprint-status.yaml` status `review` (code built, self-reviewed or light-reviewed per this session's own tiered process) — none are deployed or live-verified. See each epic's own retrospective (still `optional`, not run). |
| Epic 5 (Turnstile/Stripe/cost spikes) | **NOT STARTED** | `sprint-status.yaml`: `epic-5: backlog`, all three stories `backlog`. These need a real iPad, a real Turnstile dashboard, real billed Workers AI calls, and live Stripe test-mode access — none exist in this session. Stories 6.3/6.4/7.6 were built to AD-16's Turnstile design as a working ASSUMPTION pending 5.1's real result (`sprint-status.yaml`'s own Epic 5 action items). |
| Abuse checks pass at the latest commit | **Pass, but only in local mode** | `scripts/abuse-check.mjs` (Story 7.9) passes locally (`AI_STUB`, no deployment) as of this session's latest changes. Its own `--post-deploy` mode has never run against a real deployment. |
| `check-public.mjs` passes on production | **NOT VERIFIED** | Passes in `--self-test` mode (`node scripts/run-checks.mjs`); has never run against a real deployed domain. |
| Story 9.3 has no blockers | **BLOCKED — every item open** | `docs/runbook.md` §14's checklist: every single item unticked (no live dashboard access this session). |
| Turnstile decision from 5.1 implemented | **NOT APPLICABLE YET** | 5.1 hasn't run (see Epic 5 row above); Stories 6.3/6.4/7.6 remain built on the AD-16 assumption pending that result. |
| Kill-switch drill recorded within the last 30 days | **NEVER RUN** | `docs/runbook.md` §9's drill needs a real deployment; no record exists. |
| `/yt` Source Link appears in the readout after a test visit | **NOT VERIFIED** | `SOURCE_LINKS` is committed as `""` (Story 8.3) — no real link name exists yet, deliberately (the owner adds real channel names later); nothing to test-visit yet. |
| `8ishqa` is gone | **NOT DONE** | Still live; Story 9.2 is explicitly blocked pending Story 9.1's real redemption (see `spec-9-2-retire-8ishqa.md`). |
| Baseline (views, visits) captured | **NOT CAPTURED** | No promotion has happened yet; nothing to baseline. |
| Pending legal review flag (Story 6.7) | **STILL OPEN** | `docs/runbook.md` §1.11: the Waiver/refund/promotion-checklist wording are developer drafts, not lawyer-reviewed. Neither cleared by review nor explicitly risk-accepted in writing yet. |

### What's actually ready

To be clear about what this session DID accomplish, since the table above
is all "not yet": every story's own CODE is built, self-consistent, and
covered by an extensive automated test suite (`node scripts/run-checks.mjs`
and `node --test` both pass in full as of this assessment's own commit).
The remaining gate conditions are overwhelmingly owner-executed —
dashboard configuration, real-device spikes, and a real deployment — not
further coding work, with the sole exception of Story 9.2's code cleanup
(itself blocked on Story 9.1's live redemption, by design).

### Next steps, in order

1. Run Epic 5's spikes (5.1 Turnstile on the owner's iPad first — its
   result can change Stories 6.3/6.4/7.6).
2. Deploy to production (owner's own Workers Builds reconnection, per the
   cutover checklist §3's still-open action item).
3. Complete Story 9.1 (create + redeem the family's Stripe coupon).
4. Delete `8ishqa`, then complete Story 9.2's code cleanup.
5. Work through `docs/runbook.md` §14 top to bottom against the live
   account.
6. Get the legal review (Story 6.7's flag) cleared or explicitly
   risk-accepted in writing here.
7. Re-run this assessment. If every row above reads "met," the verdict
   changes to **GO**, and:
   - the first promoted video is published with its Source Link
     (`docs/promotion-checklist.md`);
   - a 7-day monitoring routine starts: run `scripts/readout.mjs` daily,
     act on `docs/runbook.md` §6's triggers (ceiling at 80% for 3 days →
     leave the free plan; a failure spike → the Kill Switch drill; a
     dispute rate above 0.5% → review the refund policy);
   - a 90-day review date is set here, with the PRD's own thresholds
     (visit-to-paid 0.6% target, 0.3% stop signal, ≥1,000 visits to be
     conclusive).

---

<!-- Append the next assessment below this line, oldest first, never
     editing a past entry's own verdict. -->
