// Incoming: check off purchases and break hits as they arrive.
// Writes only to incoming_marks (one row per purchase, upserted). Never
// touches cards, orders or purchases.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SECRET = 'cv_ingest_7Kq2mZ';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ingest-secret, x-agent-pass',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// Same access gate as lot-ops: Drew's passcode, the automation key, or the old
// shared secret until a passcode is set. Fails closed.
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
const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });
const SOURCES = ['whatnot_single', 'whatnot_break', 'whatnot_other', 'ebay', 'break_hit'];
const MARKS = ['received', 'not_card', 'missing', 'pending'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!(await vaultAuthorized(req))) return j({ error: 'locked' }, 401);
    const b = await req.json();
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    if (b.op === 'mark') {
      if (!MARKS.includes(b.mark)) return j({ error: 'bad mark' }, 400);
      const rows = (b.items || []).slice(0, 3000)
        .filter((x: any) => x && SOURCES.includes(x.source) && x.source_id)
        .map((x: any) => ({ source: x.source, source_id: String(x.source_id), mark: b.mark, card_id: b.card_id || null, note: b.note ? String(b.note).slice(0, 300) : null, marked_at: new Date().toISOString() }));
      if (!rows.length) return j({ error: 'no items' }, 400);
      const { error } = await supa.from('incoming_marks').upsert(rows, { onConflict: 'source,source_id' });
      return error ? j({ error: error.message }, 500) : j({ ok: true, marked: rows.length });
    }
    return j({ error: 'unknown op' }, 400);
  } catch (e) {
    return j({ error: String(e) }, 500);
  }
});
