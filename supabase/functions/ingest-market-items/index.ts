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
const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });

// Oct 9 2026: replace only rows of the same source(s) as the incoming items, per card.
// So an eBay refresh no longer wipes Card Ladder rows and vice versa.
// Pass replace_all:true to get the old behaviour (wipe every row for those cards).
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!(await vaultAuthorized(req))) return j({ error: 'locked' }, 401);
    const body = await req.json();
    const items = (Array.isArray(body.items) ? body.items : []).map((i: any) => ({ ...i, source: i.source || 'ebay' }));
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const cardIds = [...new Set(items.map((i: any) => i.card_id).filter(Boolean))] as string[];
    const extraCards = (Array.isArray(body.clear_cards) ? body.clear_cards : []) as string[];
    let sources = [...new Set(items.map((i: any) => i.source))] as string[];
    if (Array.isArray(body.sources) && body.sources.length) sources = [...new Set([...sources, ...body.sources])];
    const allCards = [...new Set([...cardIds, ...extraCards])];
    let deleted = 0;
    if (allCards.length) {
      let q = supa.from('card_market_items').delete({ count: 'exact' }).in('card_id', allCards);
      if (!body.replace_all) {
        if (!sources.length) sources = ['ebay'];
        q = q.in('source', sources);
      }
      const { error: delErr, count } = await q;
      if (delErr) return j({ error: 'delete: ' + delErr.message }, 500);
      deleted = count || 0;
    }
    let inserted = 0;
    for (let i = 0; i < items.length; i += 500) {
      const chunk = items.slice(i, i + 500);
      const { error } = await supa.from('card_market_items').insert(chunk);
      if (error) return j({ error: 'insert: ' + error.message, inserted }, 500);
      inserted += chunk.length;
    }
    return j({ ok: true, cards: allCards.length, sources: body.replace_all ? 'all' : sources, deleted, inserted });
  } catch (e) {
    return j({ error: String(e) }, 500);
  }
});
