# Addendum — one-time purchase model, ops cost at scale, security and refunds
Date: 2026-09-20 · Amends `docs/business-analysis.md` (which recommended freemium subscription + lifetime) · Currency: RON (USD 1 = 4.5839 RON, BNR 18 Sep 2026)

> **Later the same day:** after seeing the one-time analysis, the owner chose to **keep the subscription at a lower price** (channel: 1,000 subscribers, one month old). §9 holds the current pricing analysis. §1 (ops cost), §5 (children's marketing) and §6 (security) apply to either model; §2 and §7 describe the one-time option that was considered and not chosen.

## 0. What the owner decided (and how it changes the earlier report)

- **Acquisition:** promote on the owner's own kids' YouTube channel (@8siceva). Kids try the free 10 activities/day, ask a parent, the parent buys. This makes acquisition cost **~0 RON** (owned channel), so the 500 RON/month marketing line drops out of the model.
- **Model:** **one-time purchase, no subscription** ("people are sick of subscriptions"). This replaces the 19.99/month and 149/year plans and the "lifetime 249" test from the earlier report.
- **Refunds:** "no refunds". The price should be low enough that a parent is fine if the app crashes or the child stops using it after a week.
- **Security first:** no exploitable path may produce an ops bill.
- **Data / text:** no data collected; Stripe alone identifies the buyer. Terms and privacy text will be adapted.

**Verdict on one-time:** viable and, with an owned channel and no marketing spend, roughly as profitable as the subscription base case in the first 24 months (§2). It is **capped**: income equals *new sales per month × price*, it does not accumulate. Two parts of the plan carry real risk and need changing (§4 refunds, §5 marketing wording).

## 1. Ops cost at 100 / 1,000 / 10,000 / 100,000 / 1,000,000 users

"Users" = monthly active users (MAU). All prices from Cloudflare's pricing pages, retrieved 2026-09-20. Usage inputs are **assumptions** (not measured): 25% of MAU open the app on a given day, 1.5 sessions/day, 2 Worker requests per session, 20% of daily users generate one AI image, 5 ms CPU per request and 40 ms per image call.

| MAU | Requests/day | AI images/day | Fits Workers Free plan? | Workers | AI images | KV | Domain | **Total / month** |
|---|---|---|---|---|---|---|---|---|
| 100 | 80 | 5 | Yes | $0 | $0 | $0 | $1.20 | **~5.5 RON** |
| 1,000 | 800 | 50 | Yes | $0 | $0 | $0 | $1.20 | **~5.5 RON** |
| 10,000 | 8,000 | 500 | **No** (AI > 91 images/day) | $5 | $14.8 | $0 | $1.20 | **~96 RON** |
| 100,000 | 80,000 | 5,000 | No | $5 | $177 | $0 | $1.20 | **~840 RON** |
| 1,000,000 | 800,000 | 50,000 | No | $5 + $7 | $1,805 | $2.5 | $1.20 | **~8,300 RON** |

- **Does it change with scale? Yes, but almost only through AI images.** Up to ~1,000 users the cost is the domain name (5.5 RON/month). Static files (the whole app) are free and unlimited on Cloudflare; Workers requests, CPU and KV stay negligible even at 1M users. From ~10,000 users the AI feature becomes >95% of the bill. Cost per user settles at **~0.008 RON per user per month**.
- **AI image cost:** 5.37 neurons in + 4 × 26.05 out ≈ 110 neurons = $0.0012 ≈ **0.0055 RON per image**. The Workers Free plan includes 10,000 neurons/day (~91 images/day) free.
- **Not in the table (separate costs):** Stripe fees per sale (1.5% + 1 RON for EEA cards; 2.8–3.15% + 1 RON and +2% conversion for foreign cards — no 0.7% Billing fee for one-time payments), accounting for the PFA (139–300 RON/month, zero if an existing accountant absorbs it), and your time.
- **What one buyer costs over 3 years** (the real liability of "pay once, use forever"): 0.5 images/day → 3 RON; 1/day → 6 RON; 3/day → 18 RON; **5/day → 30 RON; 10/day → 60 RON.** "Unlimited AI" would let a heavy user eat most of a 69 RON price, so buyers need a **fair-use cap** (recommended 5 images/day → worst case ~30 RON per buyer over 3 years; typical ~3–6 RON).

## 2. One-time price options

Economics per sale (fees blended 75% Romanian / 25% diaspora cards, 2% discretionary refunds, 3.7 RON lifetime serving cost). Base funnel: 1,000 visits/month growing 3%/month, 30% become active, 2% of those buy — all **assumptions**; conversion is held constant across prices, which flatters higher prices. No marketing spend, accounting 150 RON/month, hosting on the Free plan.

| Price | Stripe fee | Contribution per sale | Sales/month to cover fixed costs | Sales/month for +800 RON/month | Base: cumulative cash at month 24 | Cash payback |
|---|---|---|---|---|---|---|
| 39 RON | 5.0% | 32.6 | 4.8 | 29 | +2,029 | month 13 |
| 49 RON | 4.4% | 42.2 | 3.7 | 23 | +4,003 | month 8 |
| **69 RON** | 3.8% | 61.3 | 2.5 | 16 | **+7,953** | month 5 |
| 99 RON | 3.4% | 90.0 | 1.7 | 11 | +13,877 | month 3 |

Pessimistic (300 visits/month) never recovers the one-time setup cost at any price (−3.5k to −4.3k RON at month 24); optimistic (3,000 visits/month) reaches +50k to +144k RON.

**Anchors:** a physical conversation-card deck ≈ $25 (~115 RON) one-time; Kodable 47.99 lei/year and Duolingo Premium from 16.25 RON/month (search summaries, not verified on vendor pages). Large kids-app publishers have moved from one-time app prices to subscriptions (Sago Mini/Toca Boca now sell through the Piknik subscription), so "no subscription" is a real differentiator against them — but it also means there is no verified one-time price benchmark for this category.

**Recommendation: list price 69 RON, launch offer 49 RON via a Stripe promotion code (already enabled in `checkout.js:42`), for the first ~100 sales or 60 days.** Then raise to the list price. Rationale: the launch price satisfies the "comfortable, low regret" goal; the list price is where the economics work; the promo code needs no new development. Any price ≥ 39 RON covers the serving cost, so the choice is about parent psychology and income, not cost. Validate by watching conversion at 49 RON vs (later) 69 RON.

## 3. Sizing: how big must the channel be?

Income = sales per month × contribution. To reach +800 RON/month at 69 RON you need ~16 sales/month. With the base funnel (visit → buyer ≈ 0.6%) that is ~2,600 visits per month. **The number that decides everything is how many parents reach 8ish.app from the videos**, and I could not read the channel's statistics (YouTube did not serve them). Needed from the owner: subscribers, average monthly views, uploads per month, and whether the videos are marked "made for kids".

## 4. Refunds: "no refunds" needs two corrections

| Fact | Source |
|---|---|
| A 14-day withdrawal right applies to online purchases. For digital content it can be removed **only if** the buyer gives prior express consent to start immediately **and** acknowledges that this loses the withdrawal right (Directive 2011/83/EU, Art. 16(m)), interpreted strictly by the EU Court | EUR-Lex; Inside Privacy summary of CJEU Case C-234/25 |
| Remedies for digital content that does not work (repair, price reduction, termination) cannot be waived by contract terms, and the seller is liable for defects present at delivery that appear within **2 years** (Directive 2019/770) | EUR-Lex; Cooley summary |
| A dispute ("chargeback") costs **100 RON** in Stripe Romania whether you win or lose, on top of losing the sale. Above ~0.75% disputes the account can be monitored or terminated | Stripe RO pricing; chargeflow.io guide |

**What this means for the policy:**
1. **"No refunds for change of mind" is achievable** — with an explicit checkout checkbox ("I want immediate access and understand I lose my 14-day withdrawal right"), and the confirmation kept. Without that checkbox the parent legally keeps 14 days.
2. **"No refunds if the app crashes" is not enforceable.** If the app materially does not work as described, the parent has statutory remedies.
3. **A rigid no-refund stance is more expensive than refunding.** On a 49 RON sale, one chargeback costs 149 RON (3× the sale) and, at fewer than ~133 sales, a single dispute already exceeds the 0.75% threshold. A discretionary refund costs the sale and the ~2 RON fee.

**Recommended policy:** no refunds for change of mind (after the checkout waiver); fix or refund if the app does not work; the owner may refund on request to prevent a chargeback. Nothing here is legal advice — confirm the wording with a lawyer or ANPC guidance.

## 5. Marketing to children: two things to change

- **The rule:** EU law treats "including in an advertisement a direct exhortation to children to buy advertised products or persuade their parents or other adults to buy advertised products for them" as unfair in all circumstances (UCPD 2005/29/EC, Annex I, point 28). Videos and in-app text addressed to children must invite them to **try**, never to ask a parent to **buy**.
- **In the app today:** child-facing screens say "roagă un părinte să deblocheze 8ish+" / "ask a parent to unlock 8ish+" (`i18n.js:83, 157, 191`). That is the wording the rule targets. Change the child screen to a neutral "See you tomorrow!" and keep the purchase path behind the existing "For parents" button and Parent Gate.
- **YouTube:** videos marked "made for kids" have comments, end screens and other widgets disabled, so the funnel is on-screen "8ish.app" plus a parent-facing description. Speak to the parent (in the description), not the child, when mentioning the app is paid.
- **Confirm with a lawyer** how the rule applies to a creator promoting the creator's own product.

## 6. Security: what an attacker can actually cost you

**The strongest protection is structural.** On the Workers **Free** plan, exceeding the daily allowance makes calls **fail; it does not bill** (100,000 requests/day; Workers AI 10,000 neurons/day ≈ 91 images/day). While you are on the Free plan, the worst case is *degraded service*, not a bill. From ~10,000 users you will need the $5 Paid plan; I found no documented hard spend cap for Workers on the limits page, so on Paid the protection must be in the application (a daily cap) plus billing alerts.

| Vector (today) | Cost exposure now | After the fix |
|---|---|---|
| Script calls `/api/transform` using the public token in the client (`transform.js:19`, `draw.js:15-16`) | ≤ 960 images/day = 5.3 RON/day (~160 RON/month) on Paid, but it also locks the feature for everyone | Daily cap of e.g. 100 images/day → ≤ 0.55 RON/day (~17 RON/month), and no single caller can lock others |
| **Client-chosen prompt text goes straight into the model prompt** (`transform.js:383`); any image is accepted, not just a child's sketch | Anyone can make your endpoint render arbitrary content under your budget and brand | Client sends a **prompt ID**; the server maps it to the text; enforce PNG, ≤512 px, small size |
| Request flood (unprotected Paid plan) | 100M requests ≈ 190 RON; 300M ≈ 560 RON | Stay on Free until needed; 1 free WAF rate-limit rule (per IP, 10 s window); billing alerts |
| Forged premium flag in `localStorage` (`monetize.js:145-148, 429-432`) | Revenue leak, not a cost | Signed purchase token, verified on the server |
| Spam of `/api/checkout` and `/api/restore` (restore calls Stripe per email) | No direct cost; can exhaust Stripe API rate limits | Turnstile (free, unlimited) + per-IP limits |
| Chargebacks / card testing | 100 RON per dispute | Stripe Radar defaults; refund on request; hosted Checkout only |

**Cloudflare tools confirmed available for free:** Turnstile (unlimited challenges, works without proxying), Durable Objects with SQLite (100,000 requests/day — enough for a strongly consistent daily counter), one WAF rate-limit rule.

**Requirements this produces for the PRD** (capabilities, not implementation): a hard daily AI ceiling that fails closed with a friendly message; server-verified entitlement; a per-buyer fair-use cap; prompt IDs instead of client text; bot friction on the free AI image; a kill switch that turns AI off instantly; a failed AI call must not use up the child's quota; usage alerts at 80% of the daily ceiling.

## 7. Revised recommendation

1. **Model:** freemium (10 activities/day free) + **one-time unlock, 69 RON list / 49 RON launch offer.** Drop the subscription plans.
2. **Fair use, not unlimited:** buyers get 5 AI images/day.
3. **Refunds:** waiver checkbox at checkout; statutory fix-or-refund for defects; refund on request instead of risking a 100 RON dispute.
4. **Child-facing text:** remove "ask a parent to unlock"; put the paid offer only behind the parent path.
5. **Security work comes before any promotion** (§6), because promotion is what creates the traffic an attacker can ride.
6. **Measure:** visits, checkout starts and purchases, using anonymous aggregate counters; no per-user tracking.

## 8. Sources and assumptions

**Sources (retrieved 2026-09-20):** Cloudflare Workers AI pricing, Workers pricing and limits, KV pricing, Durable Objects pricing, Turnstile plans, WAF rate limiting (developers.cloudflare.com); Stripe Romania pricing (stripe.com/en-ro/pricing); BNR exchange rates; EUR-Lex Directive 2011/83/EU and 2019/770, UCPD 2005/29/EC Annex I; Inside Privacy on CJEU C-234/25; Cooley DCSD summary; chargeflow.io Stripe dispute guides; YouTube Help/HowToGeek on made-for-kids restrictions; the earlier report's source list.

**Assumptions to replace with measured data:** MAU/DAU ratio, sessions per day, AI usage share, 5/40 ms CPU per request, visits per month, visit → active 30%, active → buyer 2% (from a subscription benchmark, not one-time), 2% discretionary refund rate, 3-year buyer life, 150 RON accounting cost.

**Not verified:** channel size; whether videos are marked "made for kids"; Romanian implementation details of the withdrawal rules (OUG 34/2014 — no source retrieved); Kodable/Duolingo prices on vendor pages; whether Cloudflare offers any hard cap on Workers spend beyond billing notifications.

**To confirm with professionals:** the checkout waiver wording, the advertising-to-children rule as applied to a creator's own product, PFA tax treatment of one-time sales, and cross-border EU VAT once diaspora sales exceed €10,000 per year.

## 9. Update — subscription kept at a lower price

**Inputs:** owner keeps the subscription (monthly and yearly) and wants lower prices; the YouTube channel has ~1,000 subscribers after one month. Monthly views, click-through to the app and app visits are **not known** yet. Funnel assumptions are the earlier ones (visit → active 30%, active → paid 2%, 40% monthly / 60% yearly mix, 15% monthly churn, 35% yearly renewal, 3% refunds, fees ~3% + 1 RON). Marketing spend is 0 because the channel is owned; fixed costs are accounting 150 + domain 5.5 RON/month on the Workers Free plan. **Because the 500 RON marketing line is gone, break-even is far lower than the 53 subscribers in the main report.**

| Prices (monthly / yearly) | Stripe fee on monthly | on yearly | Contribution per subscriber-month | Break-even subscribers | Base cash at month 24 | Conversion must rise by… to match today's prices |
|---|---|---|---|---|---|---|
| 19.99 / 149 (today) | 8.0% | 3.7% | 12.69 | 12 | +21,423 | — |
| 14.99 / 99 | 9.7% | 4.0% | 8.62 | 18 | +12,884 | **1.5×** |
| **12.99 / 79** | 10.7% | 4.3% | 6.99 | 22 | +9,468 | **1.8×** |
| 9.99 / 59 | 13.0% | 4.7% | 5.18 | 30 | +5,677 | 2.4× |
| 7.99 / 49 | 15.5% | 5.0% | 4.19 | 37 | +3,594 | 3.0× |

**How to read it:** cutting the yearly price from 149 to 79 (−47%) means conversion must rise **1.8×** just to earn the same money. The only benchmark found (RevenueCat 2026) shows median *low-priced* apps converting at 1.4% versus 2.8% for high-priced ones, i.e. cheaper did not convert better. So a big cut is more likely to lower income than raise it, unless this audience is unusually price-sensitive — which nobody knows yet. Two mechanics also work against very low prices: the fixed 1 RON Stripe fee takes 10–15% of a monthly payment below 13 RON, and a 100 RON chargeback is 2.3–3.0× a 79–49 RON yearly payment.

**Recommendation: 12.99 RON/month and 79 RON/year, yearly shown first, floor 9.99 / 59.** Rationale: a real reduction (−35% / −47%); the yearly plan is 49% cheaper than twelve monthly payments, which steers buyers to the plan with the better fee economics; break-even stays low (22 subscribers); the floor avoids the fee and chargeback penalty of going lower. A 14.99 / 99 alternative needs only 1.5× conversion uplift if you prefer less risk. Treat the price as a test: keep it for 60 days, watch checkout-start → paid, and only then change it.

**Traffic needed** (constant monthly app visits, visit → paid 0.6%, no marketing spend):

| Prices | Cover fixed costs by month 12 | +800 RON/month by month 12 | +800 RON/month by month 24 | +2,000 RON/month by month 24 |
|---|---|---|---|---|
| 19.99 / 149 | 215 | 1,321 | 1,026 | 2,314 |
| 14.99 / 99 | 318 | 1,952 | 1,519 | 3,426 |
| **12.99 / 79** | **393** | **2,413** | **1,879** | **4,240** |
| 9.99 / 59 | 537 | 3,299 | 2,563 | 5,782 |

At 12.99 / 79, reaching +800 RON/month by month 24 takes ~1,900 app visits a month, i.e. about 190,000 YouTube views a month at a 1% view-to-visit rate, or 630,000 at 0.3%. The view-to-visit rate for a kids' channel is unknown (children usually cannot click or type a URL; a parent has to), so measure it before trusting any of these.

**Measure the real funnel now, with no code changes:**
1. **App visits:** Cloudflare dashboard → Workers → `8ish-plus` → Metrics. Each app open calls `/api/config` once (`monetize.js:376`), so requests to that path approximate opens (observability is already enabled, `wrangler.jsonc:6`).
2. **Views:** YouTube Studio → Analytics → views in the last 28 days.
3. **Buyers:** Stripe dashboard → Payments and Subscriptions.

**Refunds under a subscription:** the same rules apply (first-purchase withdrawal right unless waived with a checkout checkbox; non-waivable remedies if the app does not work). The extra risk is the **annual renewal**: a parent who forgot the renewal is the classic chargeback. Mitigate with Stripe's renewal-reminder emails and a refund-on-request window after renewal instead of a dispute. The earlier fair-use idea still applies: a cap of 5 AI images/day per subscriber limits worst-case AI cost to ~0.8 RON/month.
