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
const NUMF = ['cost_basis', 'current_value', 'value_median', 'value_recent', 'value_comp_n'];
const TXTF = ['player', 'set_name', 'year', 'card_number', 'variation', 'serial', 'grade', 'grader', 'notes', 'value_source', 'value_basis', 'value_recent_date'];
function cleanPatch(p) {
  const patch = {};
  for (const f of NUMF) if (p[f] !== undefined) patch[f] = num(p[f]);
  for (const f of TXTF) if (p[f] !== undefined) patch[f] = (p[f] === '' ? null : p[f]);
  return patch;
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!(await vaultAuthorized(req))) return j({ error: 'locked' }, 401);
    const b = await req.json();
    const op = b.op;
    const supa = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    const now = () => new Date().toISOString();
    // ---- review page ops (Oct 10 2026) ----
    if (op === 'review_resolve') {
      const cardId = b.card_id;
      if (!cardId) return j({ error: 'card_id required' }, 400);
      const status = ['confirmed', 'edited', 'dismissed', 'duplicate'].includes(b.status) ? b.status : 'confirmed';
      const { data: card, error: cErr } = await supa.from('cards').select('*').eq('id', cardId).single();
      if (cErr || !card) return j({ error: cErr ? cErr.message : 'card not found' }, 404);
      const p = b.patch || {};
      const patch = cleanPatch(p);
      if (patch.current_value !== undefined && p.value_source === undefined) patch.value_source = 'owner-estimate';
      if (patch.current_value !== undefined) patch.value_date = now().slice(0, 10);
      if (status === 'duplicate') patch.status = 'duplicate';
      const prior = {};
      for (const k of Object.keys(patch)) prior[k] = card[k] === undefined ? null : card[k];
      if (Object.keys(patch).length) {
        const { error } = await supa.from('cards').update(patch).eq('id', cardId);
        if (error) return j({ error: error.message }, 500);
      }
      let q = supa.from('review_items').update({ status, resolution: (b.note || null), resolved_at: now() }).eq('card_id', cardId).eq('status', 'open');
      if (status !== 'duplicate' && Array.isArray(b.item_ids) && b.item_ids.length) q = q.in('id', b.item_ids);
      const { error: rErr } = await q;
      if (rErr) return j({ error: rErr.message }, 500);
      await supa.from('card_change_log').insert({ card_id: cardId, ref: card.ref, source: 'review-page', prior, note: ('Review: ' + status + (Object.keys(patch).length ? ' | set ' + Object.keys(patch).join(', ') : '') + (b.note ? ' | ' + String(b.note).slice(0, 300) : '')) });
      const { count } = await supa.from('review_items').select('id', { count: 'exact', head: true }).eq('card_id', cardId).eq('status', 'open');
      if (!count) await supa.from('cards').update({ needs_review: false }).eq('id', cardId);
      return j({ ok: true, open_left: count || 0 });
    }
    // ---- card threads (Oct 12 2026): Drew <-> Claude back-and-forth per card ----
    if (op === 'thread_post') {
      const cardId = b.card_id; const body = String(b.body || '').trim();
      if (!cardId || !body) return j({ error: 'card_id and body required' }, 400);
      const { data: card } = await supa.from('cards').select('id,ref').eq('id', cardId).single();
      if (!card) return j({ error: 'card not found' }, 404);
      let { data: th } = await supa.from('card_threads').select('*').eq('card_id', cardId).neq('status', 'closed').order('id', { ascending: false }).limit(1);
      let thread = th && th[0];
      if (!thread) {
        const { data: nt, error } = await supa.from('card_threads').insert({ card_id: cardId, ref: card.ref, status: 'with_claude', topic: body.slice(0, 120) }).select().single();
        if (error) return j({ error: error.message }, 500);
        thread = nt;
      } else {
        await supa.from('card_threads').update({ status: 'with_claude', updated_at: now() }).eq('id', thread.id);
      }
      const { error: mErr } = await supa.from('card_messages').insert({ thread_id: thread.id, card_id: cardId, author: 'drew', body: body.slice(0, 4000) });
      if (mErr) return j({ error: mErr.message }, 500);
      return j({ ok: true, thread_id: thread.id });
    }
    if (op === 'thread_apply') {
      const { data: msg } = await supa.from('card_messages').select('*').eq('id', b.message_id).single();
      if (!msg || msg.author !== 'claude' || !msg.proposal) return j({ error: 'no proposal on that message' }, 400);
      if (msg.applied_at) return j({ error: 'already applied' }, 400);
      const { data: card } = await supa.from('cards').select('*').eq('id', msg.card_id).single();
      if (!card) return j({ error: 'card not found' }, 404);
      const pr = msg.proposal || {};
      const patch = cleanPatch(pr.patch || {});
      if (patch.current_value !== undefined) { patch.value_date = now().slice(0, 10); if (!patch.value_source) patch.value_source = 'comps-recent'; }
      if (pr.retire) patch.status = 'duplicate';
      const prior = {};
      for (const k of Object.keys(patch)) prior[k] = card[k] === undefined ? null : card[k];
      if (Object.keys(patch).length) {
        const { error } = await supa.from('cards').update(patch).eq('id', card.id);
        if (error) return j({ error: error.message }, 500);
      }
      await supa.from('card_messages').update({ applied_at: now() }).eq('id', msg.id);
      await supa.from('card_messages').insert({ thread_id: msg.thread_id, card_id: card.id, author: 'drew', body: 'Approved' + (b.note ? ': ' + String(b.note).slice(0, 500) : '') });
      await supa.from('card_threads').update({ status: 'closed', closed_at: now(), updated_at: now() }).eq('id', msg.thread_id);
      await supa.from('review_items').update({ status: pr.retire ? 'duplicate' : 'edited', resolution: 'Approved Claude proposal (thread ' + msg.thread_id + ')', resolved_at: now() }).eq('card_id', card.id).eq('status', 'open');
      await supa.from('cards').update({ needs_review: false }).eq('id', card.id);
      await supa.from('card_change_log').insert({ card_id: card.id, ref: card.ref, source: 'card-thread', prior, note: 'Approved Claude proposal, thread ' + msg.thread_id + (Object.keys(patch).length ? ' | set ' + Object.keys(patch).join(', ') : '') });
      return j({ ok: true });
    }
    if (op === 'thread_close') {
      const { data: th } = await supa.from('card_threads').select('*').eq('id', b.thread_id).single();
      if (!th) return j({ error: 'thread not found' }, 404);
      if (b.body) await supa.from('card_messages').insert({ thread_id: th.id, card_id: th.card_id, author: 'drew', body: String(b.body).slice(0, 4000) });
      await supa.from('card_threads').update({ status: 'closed', closed_at: now(), updated_at: now() }).eq('id', th.id);
      return j({ ok: true });
    }
    return j({ error: 'unknown op' }, 400);
  } catch (e) { return j({ error: String(e) }, 500); }
});
