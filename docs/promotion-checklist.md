# Promotion checklist

One page to check before any video or post mentions 8ish. Story 9.4
(`epics.md`), traces to C-FR-19 · PRD §8 (Consumer law) · SM-C3. Read this
BEFORE writing a description or recording an on-screen mention — not after.

⚠ **This is a developer draft, not legal advice** — same caveat already
tracked for `terms.html`/`legal.js` (`docs/runbook.md`'s §1.11 pending
legal review, and `sprint-status.yaml`'s Epic 3 action items). Have a
lawyer familiar with EU consumer/advertising-to-children law (Annex I
point 28, and any Romania-specific advertising rules) read this checklist
and the first video's actual script before the first promoted video goes
live — this document is the developer's best-effort reading of the PRD's
own cited rule, not a substitute for that review.

**The rule behind every item below:** EU law (the unfair commercial
practices rule, Annex I point 28, cited in the PRD §8 "Consumer law"
section) forbids "direct exhortation to children to buy... or to persuade
their parents... to buy" advertised products. `FR-2`'s own child-safe
wording rule inside the app (no child-facing screen urges a purchase — see
`spec-3-3-child-safe-strings.md`, Story 3.3) exists for the same reason.
Promotion must not undo, outside the app, what the app itself was built
never to do inside it.

## 1. What a video may say

**Invite children to TRY the app. Never ask them, or tell them, to get a
parent to BUY anything.**

| Approved (invites trying) | NOT approved (urges buying) |
|---|---|
| "Desenează ceva și 8ish îl transformă într-un tablou!" | "Cere unui părinte să cumpere 8ish+!" |
| "Try 8ish — draw something and watch it come to life." | "Ask your parent to unlock more!" |
| "Link-ul e mai jos / mai sus — 8ish e gratuit de încercat." | "Doar 19,99 RON pe lună — spune-i mamei sau tatălui!" |
| "It's free to try — grown-ups can see the details inside the app." | "Get your parents to subscribe today!" |

The pattern: approved sentences name the ACTIVITY (draw, try, play) and
point at the app or the link; they never name a price, a purchase verb
(buy/subscribe/unlock/cumpără/abonează/deblochează), or ask the child to
involve a parent in a transaction. If in doubt, read the sentence as if a
7-year-old will read or hear it aloud — would it make sense to a child who
has never seen a subscription button?

## 2. Where price/purchase information may go

Any mention of price, subscription, or "8ish+" belongs **only** in
material addressed to parents, never to children:

- The video **description** (parents read descriptions; children mostly
  don't) — may say the app is free to try, and that a subscription for
  unlimited access exists, with the price, addressed as "for parents" /
  "pentru părinți."
- **On-screen text/address** spoken or shown by an adult presenter, or in
  end-screen/pinned-comment text — same rule: price/purchase language must
  be visibly addressed to parents (e.g. "Pentru părinți: detalii în
  descriere" / "Parents: details in the description"), never spoken as an
  instruction to the child watching.
- **Never** in dialogue directed at the child on-screen, never in on-screen
  text a child would naturally read as being said to them.

## 3. Always use a Source Link, never the bare domain

Every video/post description and on-screen mention uses one of the
`SOURCE_LINKS` names (Story 8.3, e.g. `8ish.app/yt`), never the bare
`8ish.app` domain — otherwise that video's own contribution to SM-1 (view-
to-visit rate) is invisible in the funnel counters and `readout.mjs` can't
attribute it. See `docs/runbook.md` §11 for how a Source Link is added; a
new video needs its own name only if the owner wants per-video attribution,
otherwise reuse the channel's existing one (e.g. every YouTube video shares
`/yt`).

## 4. "Made for Kids" — YouTube's own marking, and what it changes

YouTube's own "Made for Kids" (MFK) designation is a truthful description
of the CONTENT, decided per video by what's actually in it — **never
changed to gain or avoid a feature.** Two cases:

- **A video marked "Made for Kids."** Comments, end screens, cards, and
  channel-membership/subscribe watermarks/widgets are **unavailable** on
  that video (YouTube's own platform restriction, not this app's choice).
  Since there's no end screen or comment to carry a link, the **on-screen
  spoken/shown address** and the **description** are the only places the
  Source Link and any parent-addressed price information can live —  put
  both there deliberately.
- **A video NOT marked "Made for Kids"** (because its real content and
  audience aren't primarily children — e.g. a parent-facing explainer).
  End screens, cards, comments and widgets are all available — use them
  normally; description + on-screen address still carry the Source Link as
  in §3.
- **Never mark a video MFK-false to unlock comments/widgets if its real
  content is for children**, and never mark it MFK-true to avoid moderation
  if it isn't — the marking must always reflect the content honestly. This
  is a YouTube Terms of Service / COPPA compliance matter independent of
  8ish's own rules, and a false marking risks the channel, not just this
  checklist.

## 5. Pre-publication tick list

Run through this for every video/post before it goes live:

- [ ] The on-screen dialogue/text a CHILD would read/hear invites trying,
      never buying (§1) — read the actual script/captions against the
      table above.
- [ ] Any price/subscription mention is addressed to parents only, and
      lives in the description and/or a clearly parent-addressed on-screen
      line (§2) — never in child-directed dialogue.
- [ ] The description and on-screen address use a real `SOURCE_LINKS` name
      (§3), not the bare domain.
- [ ] The "Made for Kids" marking is set honestly for this video's real
      content (§4) — checked, not defaulted.
- [ ] Romanian AND English versions (if both exist for this video/post)
      both pass the above — check each language independently, not just
      one and assume the other matches.

## 6. Reading the result — `readout.mjs --views`

After a video is live, use `scripts/readout.mjs --views <n>` (Story 8.6;
`docs/runbook.md` §13) with `<n>` = that video's (or the cumulative
campaign's) view count from YouTube's own analytics, typed in by hand — the
script never calls YouTube's API itself. It prints:

- **SM-1 (view-to-visit rate)** = Source Link visits ÷ views, target ≥1%
  within 60 days of the first promoted video.
- **SM-2 (visit-to-paid rate)** = purchases ÷ app opens, target ≥0.6%.
  **Stop signal: below 0.3%.** **Inconclusive** if fewer than 1,000 Source
  Link visits have accumulated yet — below that, the number isn't reliable
  either way, so treat it as "not enough data," not as a pass or a fail.

**What to do with a stop signal:** if SM-2 is genuinely below 0.3% (not
merely inconclusive — at least 1,000 visits must exist first), stop paid
promotion and re-examine the product/paywall before spending more on
reach; this is the PRD's own explicit stop rule (§7, SM-2), not a
suggestion to push through.

## 7. The first promoted video

Before the very first video goes live, draft its description and on-screen
address against §1–§4 above and have them reviewed once against the
child-safe wording rule (the same review discipline `spec-3-3-child-safe-
strings.md` applied inside the app — read a draft the way a child would
read/hear it, and the way a parent reading only the description would read
it). Record here once done:

- [ ] First promoted video drafted and reviewed. Date: ______ Reviewed
      by: ______ Source Link used: ______
