# Share links → offers: UX design

Status: draft for discussion. Internal only (one seller, Drew). Builds on the existing
buyer gallery (`gallery/index.html`), the Share tab in `index.html`, and the
`share-gallery` Supabase edge function.

## Goals

1. Buyers can browse, search and filter a shared inventory.
2. Buyers can select individual cards or select all (of the current filter).
3. Buyers can claim at the shown price, or make an offer: on the whole selection
   (one number, $ or % off) or card by card.
4. Drew can send a link with a discount baked in. Buyers see the listed price
   struck through and the discounted price under it.
5. Drew gets notified of new offers and works them from one inbox.

## Core decision: one link = one audience (usually one person)

Links stay what they are (scope + pricing), plus optional deal settings:

| Field | Purpose |
|---|---|
| `recipient` | "For Mike" — shown in the header ("Picked for Mike"), labels offers in the inbox |
| `discount_pct` | e.g. 15. Applied to each card's shown price |
| `discount_ends_at` | optional; after this the gallery shows normal prices |
| `allow_offers` | on/off. Off = claim only |
| `offer_floor_pct` | optional private floor (e.g. 70% of listed). Below it the buyer gets a soft warning, Drew sees a "below floor" flag. Never auto-declines |

"Duplicate for someone" on an existing link creates a new slug with the same scope and
a name + discount. The discount lives on the server row for that slug, never in the
URL, so a buyer can't edit `?d=15` into `?d=50`.

## Buyer side (gallery)

### Price display
- No discount: unchanged (`$450`).
- Discount: `$450` small, struck through, grey; `$383` bold below; a banner under the
  title: "15% off everything here, for Mike · through Oct 7".
- Card viewer price box: Listed $450 / Your price $383 / (recent sales if enabled).

### Search and filters
Keep the search box. Replace the single segment chip row with:
- Quick chips (one tap): the top segments (NBA, NFL, Star Wars…), "Graded", "PSA 10".
- A **Filters** button opening a bottom sheet:
  - Category / league (segment)
  - Team (from `card.team`, listed with counts, e.g. Knicks 23)
  - Condition: Any / Graded / Raw
  - Grader: PSA / BGS / SGC / CGC
  - Grade: Any / 10 only / 9.5+ / 9+
  - Numbered only, Rookies only (from tags)
  - Price range
- Active filters appear as removable chips; the count line reads "18 of 412 cards".
- Filters persist in the URL (`?team=Knicks&grade=10`) so Drew can send
  "only my Knicks PSA 10s" as a link without making a new link.

Needs from the edge function payload per card: `team`, `league`, `grader`,
`grade_num`, `rookie` (tag), `serial`.

### Selecting
- Each tile has a select circle top-right. Tapping the photo opens the viewer;
  tapping the circle toggles selection. Selected tiles get a dark ring + check.
- Toolbar: **Select all 18** (always the current filtered set) / Clear.
- In the viewer, the CTA becomes **Add to offer** / **Added ✓**.
- Selection is saved in localStorage per link so a buyer can come back.
- Sold / not-for-sale / on-hold cards can't be selected.

### Tray (sticky bottom bar, appears once anything is selected)
`3 cards · $1,240 listed · $1,054 your price   [Review]`

### Review sheet
Top: selected cards (thumb, name, grade, listed, your price, remove ×).

Segmented control: **Whole lot** | **Per card**

- Whole lot: one input with a $ / % toggle. Typing `900` shows "27% off listed";
  typing `25%` shows "$930". Quick chips: shown price, -5%, -10%, -15%.
- Per card: each row has an input prefilled with its shown price; tap to edit,
  accepts $ or %. Total updates live.

Below: message (optional), name, and one contact (phone / email / IG). Remembered on
the device.

Submit button is honest about what it is:
- Every price equals the shown price → **Claim 3 cards · $1,054** (it's a purchase
  at Drew's price; terms say "claim takes it").
- Anything lower → **Send offer · $900**.
- Below floor → soft note above the button: "This is well under asking and may not
  be accepted." Still submittable.

### After submitting
Confirmation screen with the summary and a private status link (`/o/<token>`) where
the buyer sees Pending → Accepted / Countered / Declined, and can accept a counter
with one tap. Cards in a pending claim show "On hold" to other link viewers.

## Drew's side (main app)

### Offers inbox
New "Offers" view (inside Share, with a badge on the Share nav item for new ones).
Each offer row:
- Buyer name + which link, time ago, kind (Claim / Lot offer / Per-card offer)
- 3 cards · listed $1,240 · offered **$900** (-27%)
- Private context only Drew sees: market value of the selection, cost basis and
  profit at the offered price, "below floor" flag, other open offers on the same cards.

Detail view: per-card table (listed, shown/discounted, offered, last comp, cost) —
for lot offers the lot price is shown allocated pro-rata by listed price.

Actions:
- **Accept** → cards go On hold on every link; buyer status page shows accepted +
  payment terms. Partial accept: untick cards, accept the rest at their offered
  (or allocated) prices.
- **Counter** → one total, or per card; buyer sees it on their status page.
- **Decline** (optional reason).
- **Message** → opens SMS / email prefilled with the offer summary.
- Then **Mark paid** → **Mark shipped**, which hands the cards to the existing Sold
  flow with the final price per card.

Statuses: new → countered → accepted → paid → shipped/sold, or declined / expired /
withdrawn. Holds release automatically if an accepted offer isn't paid in N days.

### Link list additions
Each link row in the Share tab gains: recipient, discount, views (last opened),
open offers count.

## Notifications

Recommended, in order of effort:
1. In-app badge + list (free, needed anyway).
2. Email to Drew from the edge function (e.g. Resend) with the summary and a deep link
   into the offer. Reliable and cheap to build.
3. Instant phone push: Slack incoming webhook or ntfy.sh topic. A few lines in the
   edge function, no app-store or SMS registration needed.
4. SMS via Twilio: most immediate but needs A2P 10DLC registration; skip for now.

Optional: "Mike opened your link" pings (first open per day) for follow-ups.

## Data model sketch

```
share_links  + recipient text, discount_pct numeric, discount_ends_at timestamptz,
               allow_offers bool default true, offer_floor_pct numeric
offers       id, link_id, status_token (unguessable), kind ('claim'|'lot'|'per_card'),
             buyer_name, buyer_contact, message, total_listed, total_shown, total_offer,
             counter_total, status, created_at, responded_at, expires_at
offer_items  offer_id, card_id, listed_price, shown_price, offer_price,
             counter_price, accepted bool
cards        + hold_offer_id (nullable)
```

Prices are snapshotted into `offer_items` at submit time, since asking prices move
with daily comp refreshes.

Edge function ops: public `submit_offer`, `offer_status`, `respond_counter`
(rate-limited, honeypot field); secret `list_offers`, `respond_offer`,
`update_offer_status`.

## Phasing

1. **Browse**: filter sheet, URL filters, select + select all, tray. Submit sends a
   structured SMS/email (reuses today's contact flow). Discount links.
2. **Offers**: offers tables, submit_offer, inbox with accept/decline, email + push
   notification, holds.
3. **Negotiation**: counters, buyer status page, partial accept, paid/shipped → Sold,
   link view tracking.

## Open questions

- Notification channel: email, Slack, ntfy, or text?
- Should other viewers see "On hold" on claimed cards, or should those cards just
  disappear?
- Counters in-app (status page) or just reply by text?
- Does a link discount also apply to cards with a hand-set asking price? (Draft: yes.)
- Expire discounts by date, or leave them open until Drew edits the link?
