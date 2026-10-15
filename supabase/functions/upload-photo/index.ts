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
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!(await vaultAuthorized(req))) return j({ error: 'locked' }, 401);
    const b = await req.json();
    if (!b.card_id || !b.data_base64) return j({ error: 'missing card_id or data' }, 400);
    const url = Deno.env.get('SUPABASE_URL');
    const supa = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    const bin = Uint8Array.from(atob(b.data_base64), (c) => c.charCodeAt(0));
    const ext = (b.ext || 'jpg').replace(/[^a-z0-9]/gi, '');
    const side = (b.side || 'front').replace(/[^a-z0-9]/gi, '');
    const path = `${b.card_id}/${side}-${Date.now()}.${ext}`;
    const up = await supa.storage.from('card-photos').upload(path, bin, { contentType: b.content_type || 'image/jpeg', upsert: true });
    if (up.error) return j({ error: 'upload: ' + up.error.message }, 500);
    const pub = `${url}/storage/v1/object/public/card-photos/${path}`;
    if (b.is_primary) await supa.from('photos').update({ is_primary: false }).eq('card_id', b.card_id);
    const ins = await supa.from('photos').insert({ card_id: b.card_id, url: pub, side: side, is_primary: !!b.is_primary }).select('id').single();
    if (ins.error) return j({ error: 'insert: ' + ins.error.message, url: pub }, 500);
    return j({ ok: true, url: pub, photo_id: ins.data.id });
  } catch (e) { return j({ error: String(e) }, 500); }
});
