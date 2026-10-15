import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SECRET = 'cv_ingest_7Kq2mZ';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ingest-secret, x-agent-pass',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// ---- access gate (Oct 15 2026): Drew's passcode (from the app) or the private automation key (runner, Claude sessions).
// The old shared secret is accepted only until Drew sets his passcode. Fails closed if the settings can't be read.
async function vaultAuthorized(req: Request): Promise<boolean> {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await db.from('agent_settings').select('key,value').in('key', ['passcode_hash', 'automation_key']);
  if (error) return false;
  const m: Record<string, any> = {}; (data || []).forEach((r: any) => { m[r.key] = r.value; });
  const pass = req.headers.get('x-agent-pass') || '';
  if (pass && m.passcode_hash) {
    const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cv-agent-v1:' + pass)))).map((x) => x.toString(16).padStart(2, '0')).join('');
    if (h === m.passcode_hash) return true;
  }
  const sec = req.headers.get('x-ingest-secret') || '';
  if (m.automation_key && sec === m.automation_key) return true;
  if (!m.passcode_hash && sec === SECRET) return true;
  return false;
}
function j(o: unknown, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } }); }
function num(v: unknown) { if (v === undefined || v === null || v === '') return null; const n = Number(v); return isNaN(n) ? null : n; }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!(await vaultAuthorized(req))) return j({ error: 'locked' }, 401);
    const b = await req.json();
    const op = b.op;
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const today = new Date().toISOString().slice(0, 10);
    // eBay watchlist: merge a scrape (or a seed from Dwiki history) into watchlist_items + daily price snapshots
    if (op === 'watchlist_ingest') {
      const day = b.captured_on || today; const items = b.items || [];
      const ids = items.map((i: any) => String(i.item_id));
      const have: Record<string, any> = {};
      for (let k = 0; k < ids.length; k += 200) {
        const { data } = await supa.from('watchlist_items').select('item_id,first_seen,first_price,latest_price,status').in('item_id', ids.slice(k, k + 200));
        (data || []).forEach((r: any) => have[r.item_id] = r);
      }
      const ins: any[] = [], snaps: any[] = []; let upd = 0; const errs: string[] = [];
      for (const i of items) {
        const id = String(i.item_id); const price = num(i.price); const st = i.ended ? 'ended' : 'watching';
        const h = have[id];
        (i.history || [{ date: day, price, bids: i.bids }]).forEach((p: any) => snaps.push({ item_id: id, captured_on: p.date, price: num(p.price), bids: num(p.bids), status: p.status || st }));
        if (!h) {
          ins.push({ item_id: id, title: i.title, image_url: i.image_url || null, condition: i.condition || null, seller: i.seller || null, listing_type: i.listing_type || null, category: i.category || null,
            first_seen: i.first_seen || day, first_price: num(i.first_price) ?? price, first_source: i.first_source || 'watchlist-scrape',
            latest_price: price, latest_seen: i.last_seen || new Date().toISOString(), bids: num(i.bids), ends_in: i.ends_in || null, status: i.status || st, ended_price: i.ended ? price : null });
        } else {
          const patch: any = { title: i.title, latest_price: price, latest_seen: new Date().toISOString(), bids: num(i.bids), ends_in: i.ends_in || null, status: st, updated_at: new Date().toISOString() };
          if (i.image_url) patch.image_url = i.image_url; if (i.condition) patch.condition = i.condition; if (i.seller) patch.seller = i.seller; if (i.listing_type) patch.listing_type = i.listing_type;
          if (i.category) patch.category = i.category;
          if (h.latest_price !== null && price !== null && Number(h.latest_price) !== price) patch.prev_price = h.latest_price;
          if (i.ended) patch.ended_price = price;
          // an older first_seen from a seed wins; a scrape never moves first_seen later
          if (i.first_seen && i.first_seen < h.first_seen) { patch.first_seen = i.first_seen; patch.first_price = num(i.first_price); patch.first_source = i.first_source; }
          const { error } = await supa.from('watchlist_items').update(patch).eq('item_id', id); if (error) errs.push(id + ': ' + error.message); else upd++;
        }
      }
      for (let k = 0; k < ins.length; k += 200) { const { error } = await supa.from('watchlist_items').insert(ins.slice(k, k + 200)); if (error) errs.push('insert: ' + error.message); }
      for (let k = 0; k < snaps.length; k += 500) { const { error } = await supa.from('watchlist_prices').upsert(snaps.slice(k, k + 500), { onConflict: 'item_id,captured_on' }); if (error) errs.push('snap: ' + error.message); }
      let removed = 0;
      if (b.mark_missing && ids.length) {
        const { data: open } = await supa.from('watchlist_items').select('item_id').eq('status', 'watching');
        const seen = new Set(ids); const gone = (open || []).map((r: any) => r.item_id).filter((x: string) => !seen.has(x));
        for (let k = 0; k < gone.length; k += 200) await supa.from('watchlist_items').update({ status: 'removed', updated_at: new Date().toISOString() }).in('item_id', gone.slice(k, k + 200));
        removed = gone.length;
      }
      return j({ ok: errs.length === 0, inserted: ins.length, updated: upd, snapshots: snaps.length, removed, errs: errs.slice(0, 10) });
    }
    if (op === 'watchlist_retire') {
      // ids = every item on the watchlist right now (full scrape). Anything still 'watching' that is not in it was un-watched.
      const seen = new Set((b.ids || []).map(String)); if (seen.size < 10) return j({ error: 'too few ids, refusing' }, 400);
      let open: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await supa.from('watchlist_items').select('item_id').eq('status', 'watching').range(f, f + 999); if (!data || !data.length) break; open = open.concat(data); if (data.length < 1000) break; }
      const gone = open.map((r: any) => r.item_id).filter((x: string) => !seen.has(x));
      for (let k = 0; k < gone.length; k += 200) await supa.from('watchlist_items').update({ status: 'removed', updated_at: new Date().toISOString() }).in('item_id', gone.slice(k, k + 200));
      return j({ ok: true, removed: gone.length });
    }
    if (op === 'pops_ingest') {
      // results: [{card_id, asset_id, asset_name, asset_image, match, match_note, pop_total, pops:[{grader, grade, pop}]}]
      let n = 0; const errs: string[] = [];
      for (const r of (b.results || [])) {
        const { error: e1 } = await supa.from('card_alt_assets').upsert({ card_id: r.card_id, asset_id: r.asset_id || null, asset_name: r.asset_name || null, asset_image: r.asset_image || null,
          match: r.match || 'none', match_note: r.match_note || null, pop_total: num(r.pop_total), checked_at: new Date().toISOString() }, { onConflict: 'card_id' });
        if (e1) { errs.push(r.card_id + ': ' + e1.message); continue; }
        await supa.from('card_pops').delete().eq('card_id', r.card_id).eq('source', 'alt');
        const rows = (r.pops || []).filter((p: any) => num(p.pop) !== null).map((p: any) => ({ card_id: r.card_id, grader: p.grader, grade: String(p.grade), pop: num(p.pop), source: 'alt', captured_at: new Date().toISOString() }));
        if (rows.length) { const { error: e2 } = await supa.from('card_pops').upsert(rows, { onConflict: 'card_id,grader,grade' }); if (e2) errs.push(r.card_id + ': ' + e2.message); }
        n++;
      }
      return j({ ok: errs.length === 0, n, errs: errs.slice(0, 10) });
    }
    // generic upserts for the interest-tracking tables + recompute
    if (op === 'upsert') {
      const OK = new Set(['viewed_snapshots', 'interest_entity_defs', 'discover_items', 'interest_digests']);
      if (!OK.has(b.table)) return j({ error: 'table not allowed' }, 400);
      const rows = b.rows || []; const errs: string[] = [];
      for (let k = 0; k < rows.length; k += 500) { const { error } = await supa.from(b.table).upsert(rows.slice(k, k + 500), b.onConflict ? { onConflict: b.onConflict } : undefined); if (error) errs.push(error.message); }
      return j({ ok: errs.length === 0, n: rows.length, errs: errs.slice(0, 5) });
    }
    if (op === 'refresh_interests') {
      const { data, error } = await supa.rpc('refresh_interests');
      return error ? j({ error: error.message }, 500) : j({ ok: true, result: data });
    }
    return j({ error: 'unknown op' }, 400);
  } catch (e) { return j({ error: String(e) }, 500); }
});
