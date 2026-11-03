-- Teach value_family() the comp runner's current source names.
--
-- The runner was renamed on 2026-10-09: it now writes comps-recent / comps-thin
-- where it used to write ebay-median / ebay-thin. value_family() was never
-- updated, so both resolved to 'estimate', and portfolio_kind() can only return
-- 'market' when the family starts with 'market-'. Consequences, all from this
-- one regex: market_index frozen at 98.9952 from 2026-10-05, market_change and
-- market_n zero every day, portfolio_movers returning no gainers or losers, and
-- every real price move filed as a revaluation.
--
-- Only comps-recent (2202 cards) and comps-thin (421) exist, so the fix names
-- them explicitly rather than matching ^comps- -- a future comps-broad would be
-- an estimate, not a market read, and should not be swept in by accident.
-- Applied 2026-11-03. Only portfolio_kind() and portfolio_build() consume
-- value_family(), and both are covered by the rebuild below.

create or replace function public.value_family(s text)
 returns text
 language sql
 immutable
as $function$
  select case
    when s is null then null
    when s ~ '^(ebay-sold|ebay-median|ebay-thin|ebay\+cl|ebay-1st-ed|ebay-comparable|comps-recent|comps-thin)' then 'market-ebay'
    when s ~ '^cardladder' then 'market-cl'
    when s ~ '^sketch-(model|confirmed)' then 'market-sketch'
    else 'estimate' end
$function$;

-- Rebuild every point, oldest first, so each day's market_index chains off the
-- day before it.
--
-- Deliberately NOT portfolio_rebuild(): that deletes from its start date and
-- recreates only dates present in card_value_history, which would have dropped
-- 10 days the comp run wrote nothing on (2026-10-06, -07, -11, -17, -18, -20,
-- -24, -25, -31 and 2026-11-01). portfolio_build() upserts on as_of, so driving
-- it per date deletes nothing.
--
-- Rebuild ALL of it, not just from the rename. portfolio_values_asof()
-- reconstructs from the current card set, so points built on different days sat
-- on different bases. That inconsistency -- not a bug in portfolio_build -- is
-- what made 10 of 49 steps fail to reconcile by 16,390.97 in total. A partial
-- rebuild leaves the untouched days on the old basis and fabricates a step at
-- the seam (rebuilding from 2026-10-05 alone invented a -14,911.71 cliff).
-- After a full rebuild all 50 steps reconcile, worst residual 0.01.
do $$
declare d date;
begin
  for d in select as_of from public.portfolio_points order by as_of loop
    perform public.portfolio_build(d);
  end loop;
end $$;

-- Rolled back by restoring public.portfolio_points_bak_20261103, which holds
-- all 50 pre-rebuild rows. Note that the rebuild moves historical totals onto a
-- survivorship basis: cards deleted since are excluded from every date rather
-- than only from later ones, so 2026-10-05 reads 181,263.43 where it read
-- 196,175.14 before. The new series is internally consistent; the old one was
-- not.
