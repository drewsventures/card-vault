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
function j(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } }); }
function num(v){ if(v===undefined||v===null||v==='') return null; const n=Number(v); return isNaN(n)?null:n; }
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!(await vaultAuthorized(req))) return j({ error: 'locked' }, 401);
    const b = await req.json();
    const op = b.op;
    const supa = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    if (op === 'create_lot') {
      const { data, error } = await supa.from('lots').insert({ name: (b.name || 'New lot').slice(0, 120), status: 'building' }).select('id').single();
      if (error) return j({ error: error.message }, 500);
      return j({ ok: true, id: data.id });
    }
    if (op === 'rename_lot') {
      const { error } = await supa.from('lots').update({ name: (b.name || '').slice(0, 120) }).eq('id', b.lot_id);
      return error ? j({ error: error.message }, 500) : j({ ok: true });
    }
    if (op === 'set_lot') {
      const patch = {};
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.status !== undefined) patch.status = b.status;
      if (b.suggested_price !== undefined) patch.suggested_price = b.suggested_price;
      const { error } = await supa.from('lots').update(patch).eq('id', b.lot_id);
      return error ? j({ error: error.message }, 500) : j({ ok: true });
    }
    if (op === 'delete_lot') {
      await supa.from('lot_items').delete().eq('lot_id', b.lot_id);
      const { error } = await supa.from('lots').delete().eq('id', b.lot_id);
      return error ? j({ error: error.message }, 500) : j({ ok: true });
    }
    if (op === 'add_item') {
      const { error } = await supa.from('lot_items').upsert({ lot_id: b.lot_id, card_id: b.card_id }, { onConflict: 'lot_id,card_id', ignoreDuplicates: true });
      return error ? j({ error: error.message }, 500) : j({ ok: true });
    }
    if (op === 'add_items') {
      const rows = (b.card_ids || []).map((c) => ({ lot_id: b.lot_id, card_id: c }));
      if (rows.length) { const { error } = await supa.from('lot_items').upsert(rows, { onConflict: 'lot_id,card_id', ignoreDuplicates: true }); if (error) return j({ error: error.message }, 500); }
      return j({ ok: true, added: rows.length });
    }
    if (op === 'remove_item') {
      const { error } = await supa.from('lot_items').delete().eq('lot_id', b.lot_id).eq('card_id', b.card_id);
      return error ? j({ error: error.message }, 500) : j({ ok: true });
    }
    // ---- card ops ----
    if (op === 'sell_card') {
      const patch = { status: 'sold', disposition: 'sold', is_listed: false };
      patch.sale_price = num(b.sale_price);
      patch.sold_fees = num(b.sold_fees);
      if (b.sold_venue !== undefined) patch.sold_venue = b.sold_venue || null;
      if (b.sold_to !== undefined) patch.sold_to = b.sold_to || null;
      patch.sold_date = b.sold_date || new Date().toISOString().slice(0,10);
      const { error } = await supa.from('cards').update(patch).eq('id', b.card_id);
      return error ? j({ error: error.message }, 500) : j({ ok: true });
    }
    if (op === 'unsell_card') {
      const { error } = await supa.from('cards').update({ status: 'own', disposition: null, sale_price: null, sold_fees: null, sold_venue: null, sold_to: null, sold_date: null }).eq('id', b.card_id);
      return error ? j({ error: error.message }, 500) : j({ ok: true });
    }
    if (op === 'set_card') {
      const patch = {};
      const numFields = ['cost_basis','current_value','sale_price','sold_fees'];
      const txtFields = ['player','set_name','year','card_number','variation','serial','category','sport','grade','grader','cert_number','notes','value_source','sold_venue','sold_to','acquired_via','status','disposition','listing_url','draft_url','artist','team','tax_domain','tax_league','tax_category','tax_franchise','tax_era','tax_set_line','tax_type','tax_status','tax_source','tax_note'];
      for (const f of numFields) if (b[f] !== undefined) patch[f] = num(b[f]);
      for (const f of txtFields) if (b[f] !== undefined) patch[f] = (b[f]===''?null:b[f]);
      for (const f of ['sold_date','acquired_date','value_date']) if (b[f] !== undefined) patch[f] = b[f] || null;
      for (const f of ['is_rookie','is_auto','is_relic','is_listed']) if (b[f] !== undefined) patch[f] = !!b[f];
      // convenience: setting a listing_url implies listed; clearing it implies not listed (unless explicitly set)
      if (b.listing_url !== undefined && b.is_listed === undefined) patch.is_listed = !!(b.listing_url && b.listing_url !== '');
      if (!Object.keys(patch).length) return j({ error: 'no fields' }, 400);
      const { error } = await supa.from('cards').update(patch).eq('id', b.card_id);
      return error ? j({ error: error.message }, 500) : j({ ok: true });
    }
    if (op === 'add_purchase') {
      // If the card comes in classified (tax fields present), leave ref null so the
      // DB trigger assigns the correct scheme ref (e.g. BSB-0123). Only fall back to
      // an EB- placeholder when the card is genuinely unclassified at intake.
      let ref = (b.ref || '').trim();
      const classified = !!(b.tax_domain || b.tax_league || b.tax_category || b.tax_franchise);
      if (!ref && !classified) {
        const { data: rows } = await supa.from('cards').select('ref').ilike('ref', 'EB-%').limit(5000);
        let mx = 0; (rows||[]).forEach((r) => { const m = /^EB-(\d+)$/.exec(r.ref||''); if (m) mx = Math.max(mx, parseInt(m[1],10)); });
        ref = 'EB-' + (mx + 1);
      }
      const row = {
        ref: ref || null,
        player: b.player || null,
        set_name: b.set_name || null,
        year: b.year || null,
        card_number: b.card_number || null,
        variation: b.variation || null,
        serial: b.serial || null,
        category: b.category || null,
        sport: b.sport || null,
        artist: b.artist || null,
        team: b.team || null,
        is_rookie: !!b.is_rookie,
        is_auto: !!b.is_auto,
        is_relic: !!b.is_relic,
        grade: b.grade || null,
        cost_basis: num(b.cost_basis),
        current_value: num(b.current_value),
        value_source: b.value_source || null,
        status: 'own',
        acquired_via: b.acquired_via || null,
        acquired_date: b.acquired_date || new Date().toISOString().slice(0,10),
        notes: b.notes || null,
        listing_url: b.listing_url || null,
        draft_url: b.draft_url || null,
        is_listed: !!(b.listing_url && b.listing_url !== ''),
        needs_review: b.needs_review === undefined ? true : !!b.needs_review,
        tax_domain: b.tax_domain || null,
        tax_league: b.tax_league || null,
        tax_category: b.tax_category || null,
        tax_franchise: b.tax_franchise || null,
        tax_era: b.tax_era || null,
        tax_set_line: b.tax_set_line || null,
        tax_type: b.tax_type || null,
        tax_status: b.tax_status || null,
        tax_source: b.tax_source || null,
        tax_note: b.tax_note || null,
      };
      const { data, error } = await supa.from('cards').insert(row).select('id,ref').single();
      return error ? j({ error: error.message }, 500) : j({ ok: true, id: data.id, ref: data.ref });
    }
    return j({ error: 'unknown op' }, 400);
  } catch (e) { return j({ error: String(e) }, 500); }
});
