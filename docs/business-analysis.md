# Business analysis — 8ish

> **Amended the same day (twice).** The owner promotes 8ish on an owned YouTube channel (so the 500 RON/month marketing line drops out), made security the top priority, briefly chose one-time purchase, and then **decided to keep the subscription at a lower price**. The latest conclusions are in `docs/business-analysis-addendum-one-time.md` §9 (lower subscription price, traffic needed) and §5–§6 (children's marketing rules, security). Where they conflict, the addendum wins. The fact sheet (§2), cost drivers (§4), risks (§8) and sources (§10) here remain valid. Break-even figures in this report include the 500 RON marketing budget; the addendum's do not.

Date: 2026-09-20 · Currency: RON (EUR 1 = 5.2644 RON, USD 1 = 4.5839 RON, BNR 18 Sep 2026) · Prepared for: the 8ish owner

## 1. Recommendation

**Keep freemium, add a lifetime "founding family" plan, and spend the next 90 days on measurement and one acquisition channel — not on more features or price changes.**

- **Model:** freemium (free sampler + 8ish+). Keep 19.99 RON/month and 149 RON/year; add a limited **lifetime 249 RON** offer (first ~200 buyers). Do not cut prices: the RevenueCat 2026 benchmark shows high-priced apps convert *better* than low-priced ones, so price is not the lever — reach and conversion are.
- **Economics per paying customer:** the business keeps **89% of the monthly price (17.79 of 19.99 RON)** and **93% of the yearly price (139.06 of 149 RON)** after refunds and Stripe fees. Serving a paying user costs **about 0.10 RON/month**; the AI feature costs **about 0.0055 RON per image**. Serving cost is not the problem.
- **Break-even:** about **53 paying subscribers** cover fixed costs plus the 500 RON marketing budget (79 with the lifetime mix, see §7 — an amortisation effect, cash payback is faster).
- **Base case:** ~68 subscribers and ~+190 RON/month operating profit at month 12; ~118 subscribers and ~**+810 RON/month (≈ €155)** at month 24. Pessimistic never breaks even; optimistic reaches ~+12,000 RON/month.

**Verdict:** viable as a **small side income**, not a salary replacement — and only if reach materialises. It turns a profit before valuing your own time; once 24 hours/month is valued at 40 RON/hour, the base case is roughly break-even at month 24. The market is not the constraint (the base case is ~0.004% of Romania's 3.0 million children aged 0–14); **finding parents and converting them is.**

## 2. Fact sheet (from the repo)

| Topic | Finding | Source |
|---|---|---|
| Product | Offline-first PWA of kids' activities: **205 questions, 60 dares, 260 drawing prompts, 13 traditional games**, each in Romanian and English (translations of the same content), plus "Desenează": the child's sketch is turned into a realistic 3D-style image by AI | `questions.js`, `challenges.js`, `prompts.js`, `games.js` |
| Buyer vs user | Child uses it; a parent buys it, behind a multiplication "Parent Gate" | `monetize.js:200-227` |
| Seller | A Romanian PFA (Persoană Fizică Autorizată) named in the public terms; governed by Romanian law | `terms.html:118-120, 183-185` |
| Plans | 19.99 RON/month, 149 RON/year, RON only, promo codes allowed; no trial, no lifetime, no family plan | `wrangler.jsonc:57-68`, `checkout.js:36-43` |
| Free tier | 10 taps/day, 1 AI image/day, enforced **in the browser** | `wrangler.jsonc:57-58`, `monetize.js:176-193` |
| Payments | Stripe Checkout (subscription mode); **no tax collection configured** (consistent with a non-VAT-registered seller); webhook keeps cancellations in sync | `checkout.js`, `stripe-webhook.js` |
| AI feature | Workers AI `flux-2-klein-4b`; sketch downscaled to ≤512×512; 30 s timeout | `transform.js:11`, `draw.js:206-213` |
| AI protection | One **global** 90-second cooldown in KV + a "secret" token that ships in public JS | `transform.js:19, 279, 341-376` |
| Hosting | Cloudflare Workers + static assets + KV; two deploys sharing **one KV namespace** | `wrangler.jsonc:14-19, 49-54` |
| Distribution | Web/PWA (no app store), domain 8ish.app; no store commission, no store discoverability | `manifest.webmanifest`, `wrangler.jsonc:45-48` |
| Data & legal | No accounts, no cookies, no analytics; Stripe holds email; Cloudflare processes the AI sketch; 14-day EU withdrawal right stated | `privacy.html:78-112`, `terms.html:147-151` |
| Unreleased | `friendMode` / `familyMode` flags exist but are off | `config.js:22-25` |
| Enforced where | Entitlement and limits live in `localStorage`; the server never checks them before an AI call | `monetize.js:96-99, 145-148, 429-446` |

## 3. Unit economics (calculator output, current pricing)

Non-VAT-registered PFA: no VAT is charged, so the sticker price is the net sale.

| Per payment | Monthly 19.99 | Yearly 149 |
|---|---|---|
| Customer pays | 19.99 | 149.00 |
| − VAT (not registered) | 0.00 | 0.00 |
| − Refunds (3% assumed) | −0.60 | −4.47 |
| − Stripe fees (blended ~3.0% + 1 RON) | −1.60 | −5.47 |
| **= Net proceeds** | **17.79** | **139.06** |
| − Serving cost (period) | −0.10 | −1.23 |
| **= Contribution** | **17.69** | **137.83** |

| Per customer | Monthly plan | Yearly plan |
|---|---|---|
| Contribution per month | 17.69 | 11.49 |
| Fee as % of price | 8.0% | 3.7% |
| Assumed renewal | 85%/month | 35%/year |
| Expected life | 6.7 months | 18.5 months |
| **LTV (contribution)** | **118 RON** | **212 RON** |

- Blended contribution: **12.69 RON per subscriber per month**; blended LTV **174 RON**.
- **The 1 RON fixed Stripe fee is 5% of the monthly price** — one more reason to steer parents to the yearly plan.
- A free active user costs about **0.02 RON/month**; the free tier costs about **2.4 RON per paying customer won** in the base case. It is a cheap marketing expense.
- **AI, precisely:** 5.37 neurons in + 4 × 26.05 out = ~110 neurons ≈ $0.0012 ≈ **0.0055 RON per image**. Cloudflare's free allowance (10,000 neurons/day) covers ~91 images/day at no charge; the model deliberately ignores that and bills every call.

## 4. Cost structure

| Cost | Type | RON/month | Basis |
|---|---|---|---|
| Marketing budget | Variable/choice | 500.0 | Your stated budget (up to ~500 RON) |
| Accounting for the PFA | Fixed | 150.0 | Assumption; sources give 139–300 RON/month for a non-VAT PFA. **Zero if an existing accountant absorbs it** |
| Workers Paid plan | Fixed | 22.9 | $5/month × 4.5839 (needed beyond ~91 images/day or 100k requests/day) |
| Domain 8ish.app | Fixed | 5.5 | ~$14.4/year — a registrar-range figure, not the exact Cloudflare price |
| Payment fees | Per payment | see §3 | Stripe RO pricing page |
| AI images | Per use | ~0.0055/image | Cloudflare Workers AI pricing |
| Legal review (optional) | One-time | 1,000 total | Assumption |
| **Fixed monthly total** | | **178.4** (+500 marketing = **678.4**) | |

**Where the money goes:** marketing 74%, accounting 22%, hosting and domain 4%, AI ~0%. If you lower one cost, lower marketing spend only after you know it doesn't work.

**Worst-case AI spend:** the 90 s cooldown allows at most 960 images/day → 5.3 RON/day ≈ **160 RON/month (~$35)**. This is the most an abuser could cost you. The cooldown protects a small sum while creating a large availability problem (§8, risks 3 and 4).

**Founder time (not in the profit rows):** 24 hours/month (midpoint of 3–8 h/week) at an assumed 40 RON/hour = 960 RON/month.

## 5. Business model options

Scores are 1–5 (5 best), weighted for a **side-income goal with 3–8 h/week and ~500 RON/month**. Reasoning follows the table.

| Criterion (weight) | A. Freemium sub (current) | B. Freemium + lifetime (recommended) | C. Ads | D. Institutional licence | E. Content packs |
|---|---|---|---|---|---|
| Revenue potential (25%) | 3 | 3 | 1 | 2 | 2 |
| Margin (15%) | 5 | 5 | 2 | 4 | 4 |
| Time to first revenue / cash (15%) | 3 | 4 | 2 | 1 | 3 |
| Fit with the product today (15%) | 5 | 4 | 1 | 2 | 3 |
| Legal / reputational risk (10%) | 4 | 4 | 1 | 3 | 4 |
| Founder load (10%) | 4 | 4 | 3 | 1 | 2 |
| Optionality (10%) | 3 | 4 | 1 | 3 | 3 |
| **Weighted** | **3.8** | **3.9** | **1.5** | **2.3** | **2.9** |

- **A vs B are close by design.** B keeps A and adds an option; the modelled gain is mainly **cash timing** (cumulative cash at month 24: ~18.7k vs ~8.9k RON; payback month 4 vs 12) while accrual profit at month 24 is about the same (~780 vs ~810 RON/month). It rests on an assumed 40% lifetime mix that no data supports yet. That is why it is a **test**, not a proven improvement. It is safe because of the AI economics: a lifetime user generating an image every day for five years costs about 10 RON in AI.
- **Ads — reject.** Advertising to children is restricted, and the app's own promise is "no ads, no tracking" (`privacy.html:78`).
- **Institutional licence — pilot only.** Romania had ~10,485 preschool units in 2023 and **94% are public** (public procurement, expectation of free tools); only ~507 private creches/kindergartens existed in 2022. Hypothesis to test with 5 private kindergartens/after-school centres: a 300 RON/year site licence. If 25 sites bought, that is ~7,500 RON/year (~625 RON/month) — meaningful next to the base case, but each sale costs hours.
- **Content packs — later.** Requires steady content production; wait until retention data exists.

## 6. Pricing

| Comparable | Price | Source |
|---|---|---|
| Duolingo Premium | from 16.25 RON/month | search summary, Sep 2026 — not verified on vendor page |
| Kodable (kids coding) | 47.99 lei/year after 7-day trial | search summary, Sep 2026 — not verified on vendor page |
| Physical conversation-card deck (~120 cards) | ~$25 one-time (≈ 115 RON) | conversationcards.biz, Sep 2026 |
| **8ish+** | **19.99 RON/month · 149 RON/year** | `wrangler.jsonc` |

- **Position:** the monthly price is *above* Duolingo Premium, and the yearly price is ~3× Kodable's, for a smaller library. The yearly plan (12.4 RON/month, a 38% discount) is the rational choice and should be the default. Counterpoint from RevenueCat 2026: median high-priced apps convert downloads ~2× better than low-priced apps (2.8% vs 1.4%), so **do not cut price on instinct**.
- **Value gap matters more than price.** The free tier (10 taps/day) exposes the whole 205-question library within weeks, so paid mostly buys "more of the same" plus the AI image. Retention risk follows (§7).
- **Lifetime 249 RON:** about the expected revenue of a yearly customer (149 × ~1.5 renewals ≈ 229 RON) but paid up front, with no churn risk to the seller. Cap it to the first ~200 buyers as "founding family".
- **Test plan (90 days):** show yearly first; add the lifetime card; measure paywall views → checkout starts → paid. Judge on conversion and refunds, not on opinion.
- **Diaspora:** pricing is RON-only. Stripe adds ~2% currency conversion if you price in EUR/GBP and settle in RON; foreign cards cost 2.5–3.15% + 1 RON. Test EUR pricing only after a diaspora channel exists.

## 7. Scenarios and break-even

Assumptions per scenario (labelled — none are measured): visitors/month, visitor → active share, active → paid share, and free-user retention.

| | Pessimistic | Base | Optimistic |
|---|---|---|---|
| Monthly visitors | 300 | 1,000 (+3%/mo) | 3,000 (+5%/mo) |
| Visit → active | 25% | 30% | 35% |
| Active → paid | 0.8% | 2.0% | 3.5% |
| Visit → paid | 0.2% | 0.6% | 1.2% |
| Paying subs, month 12 | 6 | 68 | 473 |
| Net MRR, month 12 | 74 RON | 897 RON | 6,229 RON |
| Monthly profit (accrual), month 12 | −608 | **+190** | +5,392 |
| Monthly profit (accrual), month 24 | −587 | **+808** | +11,938 |
| … after 24 h/month of your time at 40 RON/h | −1,547 | −152 | +10,978 |
| Cumulative cash, month 24 | −15,431 | +8,874 | +186,135 |
| Operating break-even month | not within 24 | 10 | 2 |

**Comparison — hybrid (add lifetime 249, mix 15% monthly / 45% yearly / 40% lifetime):** base month-24 profit +778 RON/month, cumulative cash +18,727 RON, cash payback month 4. If **VAT-registered** (21%), current pricing falls to +528 RON/month at month 24 (−35%), so avoid voluntary registration below the 395,000 lei mandatory threshold.

**Sensitivity (base case, change in month-24 cumulative profit):**

| Change | Δ RON |
|---|---|
| Traffic ×2 | +26,155 |
| Free → paid conversion ×1.5 / ×0.5 | +13,332 / −13,332 |
| Traffic ×0.5 | −13,078 |
| Prices ±20% (no demand reaction assumed) | ±5,471 |
| Churn / non-renewal ×0.5 / ×1.5 | +5,363 / −4,021 |
| AI cost per call ×2 | −513 |
| Free-user AI usage ×2 | −383 |

**Measure first: traffic and free → paid conversion.** Doubling the AI cost changes the outcome by ~500 RON over two years; halving traffic changes it by ~13,000.

**Anchors for the assumptions:** RevenueCat 2026 freemium median download → paid **2.1%** (day 35); 12-month payer retention **~27–28%**; ~72% of annual subscribers cancel auto-renew within the first year; AI apps retain ~36% worse over 12 months. The renewal inputs (85%/month, 35%/year) are therefore *plausible*, not measured, and a kids' novelty product may do worse.

## 8. Risks and structural gaps

| # | Risk | Likelihood | Impact | Mitigation | Evidence |
|---|---|---|---|---|---|
| 1 | **No acquisition channel and no measurement.** Reach drives the outcome, and the app has no analytics, so conversion can't be observed | High | High | One channel for 90 days; count paywall views and checkout starts via Worker logs; use Stripe for paid | `privacy.html:78`; sensitivity table |
| 2 | **Novelty churn / thin content.** ~525 items per language; free tier reveals most within weeks; annual renewal benchmark ~28–35% | High | Medium | Weekly/seasonal content drops; "new this week"; measure renewals before adding features | `questions.js`, `monetize.js:176` |
| 3 | **The AI cost control is a global 90 s cooldown** shared by free users, subscribers **and the kid's own deploy** (same KV id). It caps the whole app at 40 images/hour (~160 in a 4-hour evening peak), so a few hundred daily AI users saturate it, and paying customers see "wait" errors | Medium | High | Replace with per-device/IP and per-subscriber limits + a **daily spend cap** (e.g. 200 images/day ≈ 1.1 RON/day); separate KV namespaces per deploy | `transform.js:279, 341-376`; `wrangler.jsonc:14-19, 49-54` |
| 4 | **One script can disable the AI feature for everyone**: the endpoint token is public in client JS, and every attempt (even a failed one) resets the global clock. One request every 90 s locks out all users at almost no cost to the attacker | Medium | Medium | Same fix as risk 3; bind AI calls to a server-verified entitlement or a signed per-device token | `transform.js:19, 341-343, 412-413`; `draw.js:15-16` |
| 5 | **Entitlement and limits are client-side.** Setting `{"active":true}` in `localStorage` (no `subscriptionId`) is never re-checked, so premium is free forever; clearing storage resets the daily limit; the server does not check entitlement before an AI call | Low now, rises with visibility | Medium | Issue a signed entitlement token from `checkout-confirm`/`entitlement`, verify it in `transform`; keep client checks as UX only | `monetize.js:145-148, 429-432`; `transform.js:341-343` |
| 6 | **The "kid's link" is a fully unlimited free copy** of the whole product on its own URL | Low | Medium | Keep it unlisted; consider access restrictions before wider promotion | `wrangler.jsonc:2, 24-25` |
| 7 | **Free-plan ceilings.** Workers Free: 100k requests/day, 10 ms CPU; KV Free: 100k reads/day, 1,000 writes/day; Workers AI: 10,000 neurons/day. The cooldown check **fails closed** if KV errors, so hitting a KV limit switches AI off | Low now | Medium | Move to Workers Paid ($5/month) before any promotion push; watch `observability` logs | `transform.js:351-356`; Cloudflare pricing pages |
| 8 | **Legal/compliance.** Children under 16 cannot consent alone in Romania — fine while no child data is collected; keep it that way. Cross-border EU B2C digital sales above **€10,000/year** trigger destination-country VAT/OSS (source: Dodo Payments/Amavat summaries — one blog reports rule changes from Jan 2027, **unverified**). PFA taxes and CASS/CAS thresholds depend on net income | Low–Medium | Medium | Accountant review before diaspora scale-up; Stripe Tax later | `privacy.html:97-102`; sources in §10 |
| 9 | **Vendor dependency.** Hosting, AI model, KV and payments are each one vendor; `flux-2-klein-4b` could be superseded or repriced | Medium | Medium | Keep the AI call behind one function (already true); track Cloudflare changelog | `transform.js:11` |
| 10 | **Content is copyable.** Question and prompt banks ship as plain JS to every visitor | High | Low–Medium | The moat is brand, freshness and the AI feature, not the content itself | `sw.js` precache list |
| 11 | **Single-founder capacity.** 3–8 h/week covers support and light marketing, not sales, content and engineering together | Medium | Medium | Pick one growth channel; automate anything repeatable | — |

## 9. Next actions

1. **Add measurement (1 evening).** Count paywall views and `/api/checkout` requests (Worker logs are already on) and review Stripe weekly. *Done when:* you can state visitor → paid % for the last 30 days.
2. **Fix the AI protection (a weekend).** Per-device/IP and per-subscriber limits, a daily spend cap, server-side entitlement check, separate KV namespaces for the two deploys. *Done when:* a paying customer is never blocked by someone else's request and a script cannot lock the feature.
3. **Run the 90-day pricing test.** Keep 19.99/149; add the limited lifetime 249 offer; show yearly first. *Success:* visitor → paid ≥ 0.6% (base case), refunds ≤ 3%. *Stop signal:* < 0.3% after ~3,000 cumulative visitors → stop paid marketing and fix the product before spending more.
4. **Pick one channel for the 500 RON/month.** Hypotheses to test, not facts: Romanian parenting groups, parent/teacher creators, and Romanian weekend schools abroad (diaspora, where Romanian-language activities for kids are the pitch). *Success:* ≥ 1,000 visits/month at ≤ 1 RON per visit.
5. **Book an hour with an accountant.** Confirm sistem real vs norma de venit, whether CASS/CAS apply at ~10,000 RON/year net, and the €10,000 cross-border digital-sales rule before promoting to the diaspora.

## 10. Sources and assumptions

**Sources (retrieved 2026-09-20):**
- Cloudflare Workers AI pricing — https://developers.cloudflare.com/workers-ai/platform/pricing/ (flux-2-klein-4b: 5.37 neurons/input tile, 26.05/output tile; 10,000 free neurons/day; $0.011 per 1,000 neurons)
- Cloudflare Workers pricing — https://developers.cloudflare.com/workers/platform/pricing/ (Free: 100k requests/day, 10 ms CPU; Paid: $5/month; static assets free)
- Cloudflare KV pricing — https://developers.cloudflare.com/kv/platform/pricing/ (Free: 100k reads, 1,000 writes/day)
- Cloudflare model docs — https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/ (input images < 512×512; default output 1024)
- Stripe Romania pricing — https://stripe.com/en-ro/pricing (1.5% + 1 lei EEA standard; 2.8% premium; 2.5% UK; 3.15% international; +2% conversion; Billing 0.7%; disputes 100 lei)
- BNR exchange rates via search summary — cursbnr.ro / curs.online (EUR 5.2644, USD 4.5839, 18 Sep 2026)
- Romania VAT 21% and 395,000 lei threshold — https://www.vatupdate.com/2025/08/29/romania-increases-vat-exemption-threshold-for-small-businesses-to-395000-lei/ · https://www.vatupdate.com/2026/02/12/romania-comprehensive-vat-country-guide-2026/
- PFA taxes 2026 (10% income tax, CASS/CAS thresholds) — https://storno.ro/ghid/taxe-pfa-2026 · https://contapp.ro/blog/taxe-pfa-2026/
- EU OSS €10,000 threshold — https://dodopayments.com/blogs/eu-vat-saas-guide-2026 · https://amavat.eu/vat-oss-threshold-explained-what-happens-after-e10000/
- Accountant costs for a PFA — https://www.regnet.ro/cat-costa-un-contabil-pentru-pfa-in-2026-preturi-reale/ · https://www.solo.ro/pricing
- RevenueCat State of Subscription Apps 2026 — https://www.revenuecat.com/state-of-subscription-apps · https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026
- Romania population 0–14 (2,994,500 at 1 Jul 2025; INS via news) — https://www.bursa.ro/ins-la-1-iulie-2025-populatia-romaniei-dupa-domiciliu-era-de-aproape-21-7-milioane-de-persoane-28614751
- Romanians abroad (~5.7 million per Romanian Foreign Ministry, over 3 million in other EU states) — figure taken from a web-search summary; related coverage: https://stirileprotv.ro/stiri/actualitate/ciolacu-romania-are-cea-mai-mare-diaspora-din-europa-numarul-romanilor-care-s-au-intors-acasa-in-2023.html (not opened to verify)
- Preschool units (10,485 in 2023; 94% public) and private creches (507 in 2022) — https://romania.fes.de/e/scaderea-numarului-de-gradinite-publice-din-romania-in-ultimele-trei-decenii.html · https://business24.ro/educatie-timpurie/crese-gradinite-private-romania-crestere-unitati-1661534
- Romania digital age of consent 16 (Law 190/2018) — https://www.linklaters.com/en/insights/data-protected/data-protected---romania
- Comparable prices: Kodable (47.99 lei/year) and Duolingo Premium (from 16.25 RON/month) come from a Romanian-language web-search summary and were **not verified on the vendors' own pages**; the physical deck price (~$25 for 120 cards) is from https://www.conversationcards.biz/best-conversation-cards-for-kids
- Kids-app subscription sentiment (a vendor blog that sells one-time-purchase apps, so treat as biased) — https://watchiebesti.com/blog/subscription-vs-one-time-purchase-apps-family-cost/

**Assumptions (each should be replaced with measured data):**
| Assumption | Low / Base / High | Why it is a guess |
|---|---|---|
| Monthly visitors | 300 / 1,000 / 3,000 | No traffic data; 500 RON of ads at ~1 RON/visit is itself unverified |
| Visit → active | 25% / 30% / 35% | No analytics |
| Active → paid | 0.8% / 2.0% / 3.5% | Anchored on RevenueCat's 2.1% freemium median, which is for app downloads, not web PWA visits |
| Monthly churn | 20% / 15% / 10% | Generic benchmarks, not kids' apps |
| Yearly renewal | 25% / 35% / 50% | RevenueCat 12-month payer retention ~27–28% |
| Plan mix | — / 40% monthly, 60% yearly | Assumed |
| Refund rate | 6% / 3% / 1% | Assumed; EU 14-day withdrawal applies |
| Blended payment fee | — / 3.0% + 1 RON | 75% Romanian / 25% diaspora cards, from the Stripe RO price list |
| Accounting cost | 0 / 150 / 300 RON/month | Zero if an existing PFA accountant absorbs it |
| Founder time value | — / 40 RON/hour | Illustrative |
| Lifetime mix (hybrid) | — / 40% | Pure assumption |

**Model notes:** cohort simulation per plan (annual plans pay up front; operating break-even is measured on the accrual/MRR view); AI is billed on every call and ignores Cloudflare's free 10,000 neurons/day (conservative); price rows in the sensitivity table assume demand does not react to price; the lifetime plan is modelled as a 36-month life with no renewal.

**To confirm with a professional:** PFA tax regime and CASS/CAS at your income level, VAT/OSS rules for diaspora sales, children's-data compliance, and refund handling under EU consumer law. This report is analysis, not tax or legal advice.
