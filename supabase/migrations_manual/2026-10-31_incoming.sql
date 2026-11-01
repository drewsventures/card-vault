-- Incoming: things you paid for that are not in the vault yet.
-- Additive only: one new table for check-offs, one read-only view.
-- Nothing here changes an existing table or row.

create table if not exists public.incoming_marks (
  source     text not null,               -- whatnot_single | whatnot_break | whatnot_other | ebay | break_hit
  source_id  text not null,               -- whatnot_api_orders.id | ebay_purchases.id | break_hits.id
  mark       text not null check (mark in ('received','not_card','missing','pending')),
  card_id    uuid references public.cards(id),  -- optional link once photographed into the vault
  note       text,
  marked_at  timestamptz not null default now(),
  primary key (source, source_id)
);
alter table public.incoming_marks enable row level security;

-- One row per purchase or logged hit, with its shipping stage and your mark.
-- Delivered = Whatnot "Completed" or "Pending Review". On the way = preparing,
-- label created, shipped, in transit, delayed. eBay has no shipping status.
create or replace view public.v_incoming as
with wn as (
  select case a.kind when 'break' then 'whatnot_break' when 'single' then 'whatnot_single' else 'whatnot_other' end as source,
         a.id as source_id, a.display_id as ref, a.order_date, a.seller, a.item_titles as title,
         a.subtotal as price, a.pretty_status as ship_status,
         case when a.pretty_status in ('Completed','Pending Review') then 'delivered'
              when a.pretty_status in ('Preparing Package','Label Created','Shipped','In Transit','Delayed in Transit') then 'on_the_way'
              else 'other' end as stage,
         exists (select 1 from public.whatnot_orders o join public.whatnot_order_cards c on c.order_id = o.id where o.order_number = a.display_id) as in_vault,
         null::uuid as vault_card_id
  from public.whatnot_api_orders a
  where coalesce(a.kind, '') <> 'cancelled'
), eb as (
  select 'ebay', e.id::text, e.item_id, e.order_date, null::text, e.title, e.price, e.status, 'unknown',
         e.card_id is not null, e.card_id
  from public.ebay_purchases e
), bh as (
  select 'break_hit', h.id::text, s.whatnot_break_id, h.created_at::date, s.breaker,
         h.card_label || coalesce(' (' || s.break_title || ')', ''), h.comp_value, 'hit logged', 'unknown',
         h.card_id is not null, h.card_id
  from public.break_hits h join public.break_sessions s on s.id = h.session_id
  where h.status <> 'rejected'
)
select u.*, m.mark, m.card_id as mark_card_id, m.note as mark_note, m.marked_at,
       (current_date - u.order_date) as days
from (select * from wn union all select * from eb union all select * from bh) u
left join public.incoming_marks m on m.source = u.source and m.source_id = u.source_id;

revoke all on public.v_incoming from anon, authenticated;
grant select on public.v_incoming to anon, authenticated;
