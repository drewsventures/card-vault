// vault-agent: Drew's in-app Claude for Card Vault (Oct 15 2026).
// Private use. Gated by the app secret AND a personal passcode (hash stored in agent_settings).
// Reads through agent_sql() (read-only transaction). Writes only through whitelisted tools. Never deletes.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SECRET = 'cv_ingest_7Kq2mZ';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ingest-secret, x-agent-pass',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });
const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const API = 'https://api.anthropic.com/v1';
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

async function sha(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function getSetting(k: string) {
  const { data } = await supa.from('agent_settings').select('value').eq('key', k).maybeSingle();
  return data ? data.value : null;
}
async function setSetting(k: string, v: unknown) {
  await supa.from('agent_settings').upsert({ key: k, value: v, updated_at: now() });
}
function apiKey() { return Deno.env.get('ANTHROPIC_API_KEY') || ''; }
function hdrs() { return { 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }; }

// ---------- models ----------
async function listModels(): Promise<{ id: string; name: string }[]> {
  const r = await fetch(API + '/models?limit=50', { headers: hdrs() });
  if (!r.ok) throw new Error('models ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const d = await r.json();
  return (d.data || []).map((m: any) => ({ id: m.id, name: m.display_name || m.id }));
}
async function pickModel(pref?: string) {
  if (pref) return pref;
  const s = await getSetting('model');
  if (s && typeof s === 'string') return s;
  const env = Deno.env.get('VAULT_AGENT_MODEL');
  if (env) return env;
  const ms = await listModels(); // newest first
  const son = ms.find((m) => /sonnet/i.test(m.id));
  return (son || ms[0]).id;
}

// ---------- tools ----------
const CARD_NUM = ['cost_basis', 'current_value', 'value_median', 'value_recent', 'value_comp_n', 'value_high', 'sale_price', 'sold_fees', 'ask_price', 'serial_num', 'serial_den', 'card_count', 'alloc_weight_override'];
const CARD_TXT = ['ref', 'player', 'set_name', 'year', 'card_number', 'variation', 'serial', 'category', 'sport', 'grade', 'grader', 'cert_number', 'value_source', 'value_basis', 'sold_venue', 'sold_to', 'acquired_via', 'acq_event', 'sale_event', 'status', 'disposition', 'listing_url', 'draft_url', 'ebay_draft_id', 'artist', 'team', 'item_type', 'cost_tier', 'dupe_key', 'jersey_number', 'tax_domain', 'tax_league', 'tax_category', 'tax_franchise', 'tax_era', 'tax_set_line', 'tax_type', 'tax_status', 'tax_source', 'tax_note', 'cost_pool_id', 'lot_id', 'purchase_lot_id'];
const CARD_DATE = ['sold_date', 'acquired_date', 'value_date', 'value_recent_date'];
const CARD_BOOL = ['is_rookie', 'is_auto', 'is_relic', 'is_listed', 'not_for_sale', 'share_hidden', 'needs_review'];
const STATUSES = ['own', 'sold', 'duplicate', 'mini_lot'];
const REC_TABLES: Record<string, string[]> = {
  sell_posts: ['id'], sell_post_items: ['id'], sell_post_events: ['id'], cost_pools: ['id'], lots: ['id'],
  lot_items: ['lot_id', 'card_id'], review_notes: ['id'], vault_rules: ['id'], card_groups: ['id'],
  card_group_members: ['group_id', 'card_id'], grading_queue: ['id'], review_items: ['id'], card_threads: ['id'], card_messages: ['id'],
  watchlist_items: ['item_id'], ebay_purchases: ['id'], whatnot_order_cards: ['id'], agent_jobs: ['id'],
};

function cleanCardPatch(set: Record<string, unknown>) {
  const patch: Record<string, unknown> = {}; const rejected: string[] = [];
  for (const [k, v] of Object.entries(set || {})) {
    if (CARD_NUM.includes(k)) { patch[k] = v === null || v === '' ? null : Number(v); if (patch[k] !== null && isNaN(patch[k] as number)) rejected.push(k); }
    else if (CARD_TXT.includes(k)) patch[k] = v === '' ? null : v;
    else if (CARD_DATE.includes(k)) patch[k] = v || null;
    else if (CARD_BOOL.includes(k)) patch[k] = !!v;
    else if (k !== 'append_note') rejected.push(k);
  }
  if (patch.status !== undefined && !STATUSES.includes(String(patch.status))) { rejected.push('status=' + patch.status); delete patch.status; }
  return { patch, rejected };
}

const TOOLS: any[] = [
  {
    name: 'query_vault',
    description: 'Run ONE read-only SQL SELECT (or WITH ... SELECT) against the Card Vault Postgres database and get JSON rows back (max 500, default 200). Use it to look up cards, costs, values, sales, posts, spend, comps, anything. Writes are impossible through this tool. Prefer explicit columns and LIMIT. Use ilike for fuzzy name matches.',
    input_schema: { type: 'object', properties: { sql: { type: 'string' }, max_rows: { type: 'integer' }, purpose: { type: 'string', description: 'Short label shown to Drew while it runs, e.g. "Finding your Jordan cards"' } }, required: ['sql', 'purpose'] },
  },
  {
    name: 'update_cards',
    description: 'Change fields on existing cards (up to 100 per call). Identify each card by ref (e.g. BKB-0978) or card_id. Every change is logged to card_change_log with the prior values and the card is flagged needs_review=true. To retire a card set status="duplicate" (never delete). To mark a card sold set status="sold", sale_price, sold_fees, sold_venue, sold_date (a trigger writes the sales row). Use set.append_note to append text to notes. Only change what Drew asked for or clearly confirmed.',
    input_schema: { type: 'object', properties: { changes: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, card_id: { type: 'string' }, set: { type: 'object', description: 'Fields to set. Allowed: ' + [...CARD_NUM, ...CARD_TXT, ...CARD_DATE, ...CARD_BOOL, 'append_note'].join(', ') }, why: { type: 'string' } }, required: ['set', 'why'] } } }, required: ['changes'] },
  },
  {
    name: 'create_cards',
    description: 'Insert new card rows (up to 50), e.g. when splitting a lot row into individual cards or logging a new purchase. New rows get needs_review=true. Leave ref empty to let the DB assign the right ref when tax_* fields are set, or pass a ref you verified is unused. Same fields as update_cards.',
    input_schema: { type: 'object', properties: { cards: { type: 'array', items: { type: 'object' } }, why: { type: 'string' } }, required: ['cards', 'why'] },
  },
  {
    name: 'insert_records',
    description: 'Insert rows into one of these tables: ' + Object.keys(REC_TABLES).join(', ') + '. Use for logging sell posts (sell_posts + sell_post_items + sell_post_events), lots, cost pools, review notes, standing rules (vault_rules), grading queue entries, watchlist items. Returns inserted rows.',
    input_schema: { type: 'object', properties: { table: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } }, why: { type: 'string' } }, required: ['table', 'rows', 'why'] },
  },
  {
    name: 'update_records',
    description: 'Update rows in one of the insert_records tables, matched by exact key columns (e.g. {"id": 12}). Refuses if the match hits more than 50 rows. No deletes exist.',
    input_schema: { type: 'object', properties: { table: { type: 'string' }, match: { type: 'object' }, set: { type: 'object' }, why: { type: 'string' } }, required: ['table', 'match', 'set', 'why'] },
  },
  {
    name: 'request_comp_refresh',
    description: 'Queue the existing live comp runner for cards (inserts comp_requests). The runner only works while Drew has the runner tab open in his browser, and it pulls eBay comps, so treat its result as a refresh, not a verified exact-parallel comp.',
    input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } } }, required: ['refs'] },
  },
  {
    name: 'queue_desktop_job',
    description: 'Queue work that needs Drew\'s logged-in browser or the desktop Claude session: Card Ladder comps, eBay sold pulls, building or revising eBay drafts, Facebook posts, photo work. Creates an agent_jobs row the desktop Claude picks up. Be specific in instructions.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['comps', 'ebay_draft', 'ebay_revise', 'facebook', 'photos', 'research', 'other'] }, refs: { type: 'array', items: { type: 'string' } }, instructions: { type: 'string' } }, required: ['kind', 'instructions'] },
  },
];

async function resolveCard(ch: any) {
  let q = supa.from('cards').select('*');
  if (ch.card_id) q = q.eq('id', ch.card_id); else if (ch.ref) q = q.eq('ref', ch.ref); else return { err: 'ref or card_id required' };
  const { data, error } = await q.limit(2);
  if (error) return { err: error.message };
  if (!data || !data.length) return { err: 'card not found: ' + (ch.ref || ch.card_id) };
  if (data.length > 1) return { err: 'ref matches more than one card: ' + ch.ref + ' (use card_id)' };
  return { card: data[0] };
}

async function runTool(name: string, input: any, ctx: { chatId: number; touched: Map<string, any>; jobs: any[]; log: string[] }) {
  const cap = (o: unknown) => { const s = JSON.stringify(o); return s.length > 24000 ? s.slice(0, 24000) + '... [truncated, narrow the query]' : s; };
  try {
    if (name === 'query_vault') {
      const { data, error } = await supa.rpc('agent_sql', { q: String(input.sql || ''), max_rows: input.max_rows || 200 });
      if (error) return { text: 'SQL error: ' + error.message, isError: true };
      const rows = Array.isArray(data) ? data : [];
      return { text: cap({ row_count: rows.length, rows }) };
    }
    if (name === 'update_cards') {
      const out: any[] = [];
      for (const ch of (input.changes || []).slice(0, 100)) {
        const r = await resolveCard(ch);
        if (r.err) { out.push({ ref: ch.ref, error: r.err }); continue; }
        const card = r.card;
        const { patch, rejected } = cleanCardPatch(ch.set || {});
        if (patch.current_value !== undefined && patch.value_date === undefined) patch.value_date = today();
        if (patch.needs_review === undefined) patch.needs_review = true;
        const prior: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) prior[k] = card[k] === undefined ? null : card[k];
        const keys = Object.keys(patch).filter((k) => k !== 'needs_review');
        if (keys.length) {
          const { error } = await supa.from('cards').update(patch).eq('id', card.id);
          if (error) { out.push({ ref: card.ref, error: error.message }); continue; }
        }
        let noteOk: boolean | null = null;
        if (ch.set && ch.set.append_note) {
          const nn = (card.notes ? card.notes + ' | ' : '') + String(ch.set.append_note).slice(0, 1000);
          const { error } = await supa.from('cards').update({ notes: nn }).eq('id', card.id);
          noteOk = !error;
        }
        await supa.from('card_change_log').insert({ card_id: card.id, ref: card.ref, source: 'vault-agent', prior, note: ('In-app Claude: ' + (ch.why || '') + ' | set ' + keys.join(', ')).slice(0, 1000) });
        ctx.touched.set(card.id, { id: card.id, ref: card.ref, player: card.player, what: keys.join(', ') + (noteOk ? (keys.length ? ', note' : 'note') : '') });
        out.push({ ref: card.ref, ok: true, changed: keys, prior, rejected_fields: rejected.length ? rejected : undefined, note_appended: noteOk === null ? undefined : noteOk });
      }
      return { text: cap(out) };
    }
    if (name === 'create_cards') {
      const rows: any[] = []; const rej: any[] = [];
      for (const c of (input.cards || []).slice(0, 50)) {
        const { patch, rejected } = cleanCardPatch(c);
        if (c.notes) patch.notes = String(c.notes).slice(0, 2000);
        if (!patch.status) patch.status = 'own';
        patch.needs_review = true;
        if (!patch.ref) delete patch.ref;
        rows.push(patch); if (rejected.length) rej.push(rejected);
      }
      const { data, error } = await supa.from('cards').insert(rows).select('id,ref,player');
      if (error) return { text: 'insert error: ' + error.message, isError: true };
      for (const d of data || []) {
        ctx.touched.set(d.id, { id: d.id, ref: d.ref, player: d.player, what: 'new card' });
        await supa.from('card_change_log').insert({ card_id: d.id, ref: d.ref, source: 'vault-agent', prior: {}, note: ('In-app Claude created card: ' + (input.why || '')).slice(0, 1000) });
      }
      return { text: cap({ created: data, rejected_fields: rej.length ? rej : undefined }) };
    }
    if (name === 'insert_records') {
      const t = String(input.table);
      if (!REC_TABLES[t]) return { text: 'table not allowed: ' + t, isError: true };
      const rows = (input.rows || []).slice(0, 200);
      const { data, error } = await supa.from(t).insert(rows).select();
      if (error) return { text: 'insert error: ' + error.message, isError: true };
      ctx.log.push('Added ' + (data || []).length + ' row(s) to ' + t);
      return { text: cap({ inserted: data }) };
    }
    if (name === 'update_records') {
      const t = String(input.table);
      if (!REC_TABLES[t]) return { text: 'table not allowed: ' + t, isError: true };
      const m = input.match || {};
      if (!Object.keys(m).length) return { text: 'match required', isError: true };
      let cq: any = supa.from(t).select('*', { count: 'exact', head: true });
      for (const [k, v] of Object.entries(m)) cq = cq.eq(k, v as any);
      const { count, error: ce } = await cq;
      if (ce) return { text: 'error: ' + ce.message, isError: true };
      if (!count) return { text: 'no rows matched', isError: true };
      if (count > 50) return { text: 'refused: match hits ' + count + ' rows (max 50)', isError: true };
      let uq: any = supa.from(t).update(input.set || {});
      for (const [k, v] of Object.entries(m)) uq = uq.eq(k, v as any);
      const { data, error } = await uq.select();
      if (error) return { text: 'update error: ' + error.message, isError: true };
      ctx.log.push('Updated ' + (data || []).length + ' row(s) in ' + t);
      return { text: cap({ updated: data }) };
    }
    if (name === 'request_comp_refresh') {
      const refs = (input.refs || []).slice(0, 50);
      const { data: cs } = await supa.from('cards').select('id,ref,player').in('ref', refs);
      const rows = (cs || []).map((c: any) => ({ card_id: c.id, ref: c.ref }));
      if (rows.length) { const { error } = await supa.from('comp_requests').insert(rows); if (error) return { text: 'error: ' + error.message, isError: true }; }
      ctx.log.push('Queued comp refresh for ' + rows.length + ' card(s)');
      return { text: cap({ queued: rows.map((r: any) => r.ref), not_found: refs.filter((r: string) => !(cs || []).some((c: any) => c.ref === r)) }) };
    }
    if (name === 'queue_desktop_job') {
      const refs = input.refs || [];
      let ids: string[] = [];
      if (refs.length) { const { data: cs } = await supa.from('cards').select('id').in('ref', refs); ids = (cs || []).map((c: any) => c.id); }
      const { data, error } = await supa.from('agent_jobs').insert({ chat_id: ctx.chatId, kind: input.kind, refs, card_ids: ids, instructions: String(input.instructions).slice(0, 4000) }).select().single();
      if (error) return { text: 'error: ' + error.message, isError: true };
      ctx.jobs.push({ id: data.id, kind: data.kind, refs, instructions: data.instructions });
      return { text: cap({ queued_job: data.id }) };
    }
    return { text: 'unknown tool ' + name, isError: true };
  } catch (e) {
    return { text: 'tool failed: ' + String(e), isError: true };
  }
}

const TOOL_LABEL: Record<string, string> = {
  query_vault: 'Looking it up', update_cards: 'Updating cards', create_cards: 'Adding cards', insert_records: 'Saving records',
  update_records: 'Updating records', request_comp_refresh: 'Queueing comp refresh', queue_desktop_job: 'Queueing a desktop task', web_search: 'Searching the web',
};

async function systemPrompt() {
  const { data: rules } = await supa.from('vault_rules').select('scope,rule').eq('active', true).order('id');
  const ruleTxt = (rules || []).map((r: any) => '- [' + r.scope + '] ' + r.rule).join('\n');
  return `You are Claude, working inside Card Vault, Drew Austin's private trading card investing app. Drew runs this as a business: about $100k deployed, run like a VC portfolio, aiming to compound. You are talking only to Drew. Today is ${today()}.

You can read the whole database with query_vault and change things with the write tools. Do the work, then answer. Drew wants speed and automation: act on clear requests without asking permission, but ask one short question when a request is ambiguous in a way that would change data (for example, which of two matching cards he means). Never invent facts.

STANDING RULES (Drew's, always follow)
- No em dashes anywhere in what you write. Use commas, colons, parentheses or separate sentences.
- Never guess. If something is not in the data and cannot be verified, say so plainly. Label any estimate as an estimate.
- Values come from Card Ladder plus eBay sold comps matched to the exact parallel AND the exact card number. You cannot pull Card Ladder or live eBay sold data from here: for a real comp, queue_desktop_job(kind "comps"). Web search results are not comps.
- Never delete data. Retire bad or duplicate rows with status='duplicate'.
- Every changed card gets needs_review=true (the tool does this).
- Shipping and tax stay off cost basis.
- When a buyer offer is 20% or more over comp, flag it and ask Drew.
- Facebook sales: the buyer adds 3% for PayPal G&S.
- Drew reviews and publishes all eBay listings himself. You only prepare drafts (via a desktop job).
${ruleTxt}

DATA MODEL (Postgres, public schema)
- cards: one row per item. Key columns: id uuid, ref (e.g. BKB-0978, BSB-, FTB-, GPK-, MUS-, SW- prefixes by category), player, year, set_name, card_number, variation (parallel), serial, grader, grade, cert_number, cost_basis (what Drew paid, direct), acquired_via, acquired_date, acq_event, current_value, value_source, value_date, value_median, value_recent, value_recent_date, value_comp_n, value_basis, status (own | sold | duplicate | mini_lot), disposition, sale_price, sold_fees, sold_venue, sold_to, sold_date, ask_price, is_listed, listing_url, ebay_draft_id, draft_url, notes, needs_review, item_type (single | sealed | ...), cost_pool_id, tax_* taxonomy, category, sport, team, is_rookie, is_auto, is_relic. Exclude status='duplicate' from anything about holdings; holdings are status='own'.
- v_card_cost(id, ref, effective_cost, cost_method direct|allocated|none, pool_name): the true cost including pooled break/Whatnot allocation. ALWAYS use effective_cost (join on v_card_cost.id = cards.id) when answering "what did I pay"; raw cost_basis is null for pooled cards.
- cost_pools: pooled spend (breaks, Whatnot) allocated across cards.
- sales: realized sales (sold_price, fees, net, cost, realized_pnl, venue, sold_date, card_id or lot_ids).
- card_value_history(card_id, snapshot_date, value, source); v_card_trend for recent moves.
- card_market_items: pulled comps/listings per card (kind sold|active, title, price, item_date, url, matched).
- sell_posts / sell_post_items / sell_post_events: every FB/eBay post and its cards, asks, offers, sales.
- lots / lot_items: sale lots. grading_queue: grading candidates. watchlist_items / v_watchlist: eBay watchlist. ebay_purchases, whatnot_orders, whatnot_api_orders, v_spend_monthly, v_spend_lines: purchase history and spend.
- card_change_log: audit trail (source, prior jsonb, note). review_items: open review questions. vault_rules: Drew's standing rules (add new ones with insert_records when he states a durable rule).
- photos(card_id, url, side front|back, is_primary).
- agent_jobs: tasks you queue for the desktop Claude.
If unsure of a column, query information_schema.columns first.

HOW TO ANSWER
- Be brief and concrete. Lead with the answer. Use a small markdown table when comparing several cards. Refer to cards by ref and name, e.g. "BKB-0978 Michael Jordan By the Letter /23".
- Money as $1,234. Show paid, value today and gain/loss when relevant.
- After making changes, say exactly what changed in one or two lines.
- If Drew is viewing a card, the message starts with a [Viewing ...] context line: "this card" means that card.`;
}

// ---------- the agent loop ----------
async function loadHistory(chatId: number) {
  const { data } = await supa.from('agent_messages').select('role,content').eq('chat_id', chatId).order('id', { ascending: true });
  let msgs = (data || []).map((m: any) => ({ role: m.role, content: m.content }));
  // keep the last ~60 messages, cut at a plain user turn so tool_use/tool_result pairs stay intact
  if (msgs.length > 60) {
    let start = msgs.length - 60;
    while (start < msgs.length && !(msgs[start].role === 'user' && Array.isArray(msgs[start].content) && msgs[start].content.some((b: any) => b.type === 'text'))) start++;
    msgs = msgs.slice(start);
  }
  // repair: every assistant tool_use must be answered by tool_results in the next user message; merge same-role neighbours
  const fixed: any[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = { role: msgs[i].role, content: Array.isArray(msgs[i].content) ? [...msgs[i].content] : [{ type: 'text', text: String(msgs[i].content) }] };
    if (!m.content.length) continue;
    const prev = fixed[fixed.length - 1];
    if (prev && prev.role === m.role) { prev.content.push(...m.content); continue; }
    if (prev && prev.role === 'assistant') {
      const ids = prev.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id);
      const have = new Set(m.content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id));
      const missing = ids.filter((id: string) => !have.has(id));
      if (missing.length) m.content = [...missing.map((id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'interrupted', is_error: true })), ...m.content];
    }
    fixed.push(m);
  }
  const last = fixed[fixed.length - 1];
  if (last && last.role === 'assistant' && last.content.some((b: any) => b.type === 'tool_use')) {
    fixed.push({ role: 'user', content: last.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ type: 'tool_result', tool_use_id: b.id, content: 'interrupted', is_error: true })) });
  }
  // results must come first in a user message
  for (const m of fixed) if (m.role === 'user') m.content.sort((a: any, b: any) => (a.type === 'tool_result' ? 0 : 1) - (b.type === 'tool_result' ? 0 : 1));
  return fixed;
}
async function addMsg(chatId: number, role: string, content: any, display: string | null, extra: any = {}) {
  await supa.from('agent_messages').insert({ chat_id: chatId, role, content, display, ...extra });
}
async function progress(chatId: number, p: string) {
  await supa.from('agent_chats').update({ progress: p, updated_at: now() }).eq('id', chatId);
}

async function runAgent(chatId: number, model: string) {
  const ctx = { chatId, touched: new Map<string, any>(), jobs: [] as any[], log: [] as string[] };
  const t0 = Date.now();
  let useWeb = true;
  const sys = await systemPrompt();
  const usage = { input: 0, output: 0, cache_read: 0 };
  let finished = false;
  try {
    for (let step = 0; step < 16; step++) {
      if (Date.now() - t0 > 330000) break;
      const messages = await loadHistory(chatId);
      const tools = [...TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))];
      if (useWeb) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 4 });
      const body = { model, max_tokens: 4096, system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }], tools, messages };
      const r = await fetch(API + '/messages', { method: 'POST', headers: hdrs(), body: JSON.stringify(body) });
      if (!r.ok) {
        const t = await r.text();
        if (useWeb && r.status === 400 && /web_search/i.test(t)) { useWeb = false; step--; continue; }
        if ((r.status === 429 || r.status === 529 || r.status >= 500) && step < 15) { await progress(chatId, 'Claude is busy, retrying'); await new Promise((res) => setTimeout(res, 4000)); continue; }
        throw new Error('Claude API ' + r.status + ': ' + t.slice(0, 400));
      }
      const d = await r.json();
      if (d.usage) { usage.input += d.usage.input_tokens || 0; usage.output += d.usage.output_tokens || 0; usage.cache_read += d.usage.cache_read_input_tokens || 0; }
      const content = d.content || [];
      const toolUses = content.filter((b: any) => b.type === 'tool_use');
      const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      if (d.stop_reason === 'pause_turn') { if (content.length) await addMsg(chatId, 'assistant', content, null, { model, usage: d.usage || null }); continue; }
      const isFinal = d.stop_reason !== 'tool_use' || !toolUses.length;
      if (!content.length) { await addMsg(chatId, 'assistant', [{ type: 'text', text: '(no reply)' }], '(no reply)', { model }); break; }
      const extra: any = { model, usage: d.usage || null };
      if (isFinal) extra.actions = { cards: [...ctx.touched.values()], jobs: ctx.jobs, log: ctx.log, usage };
      await addMsg(chatId, 'assistant', content, isFinal ? (text || '(no reply)') : null, extra);
      if (isFinal) { finished = true; break; }
      const results: any[] = [];
      for (const tu of toolUses) {
        await progress(chatId, (tu.input && tu.input.purpose) || TOOL_LABEL[tu.name] || tu.name);
        const res = await runTool(tu.name, tu.input || {}, ctx);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: res.text, ...(res.isError ? { is_error: true } : {}) });
      }
      await addMsg(chatId, 'user', results, null);
      await progress(chatId, 'Thinking');
    }
    if (!finished) {
      const msg = 'I ran out of time or steps on this one. ' + (ctx.touched.size ? 'I changed ' + ctx.touched.size + ' card(s) so far (see below). ' : '') + 'Say "continue" and I will keep going.';
      await addMsg(chatId, 'assistant', [{ type: 'text', text: msg }], msg, { actions: { cards: [...ctx.touched.values()], jobs: ctx.jobs, log: ctx.log, usage } });
    }
    await supa.from('agent_chats').update({ status: 'idle', progress: null, error: null, updated_at: now() }).eq('id', chatId);
  } catch (e) {
    await supa.from('agent_chats').update({ status: 'error', progress: null, error: String(e).slice(0, 800), updated_at: now() }).eq('id', chatId);
  }
}

async function cardContext(cardId: string) {
  const { data: c } = await supa.from('cards').select('id,ref,player,year,set_name,card_number,variation,serial,grader,grade,current_value,status').eq('id', cardId).maybeSingle();
  if (!c) return '';
  const { data: v } = await supa.from('v_card_cost').select('effective_cost,cost_method').eq('id', cardId).maybeSingle();
  return `[Viewing ${c.ref} ${c.player || ''} ${c.year || ''} ${c.set_name || ''}${c.card_number ? ' #' + c.card_number : ''}${c.variation ? ' ' + c.variation : ''}${c.grader ? ' ' + c.grader + ' ' + (c.grade || '') : ''} | card_id ${c.id} | status ${c.status} | value ${c.current_value ?? 'none'} | paid ${v?.effective_cost ?? 'not recorded'} (${v?.cost_method || 'none'})]\n`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (req.headers.get('x-ingest-secret') !== SECRET) return j({ error: 'unauthorized' }, 401);
    const b = await req.json();
    const op = b.op;
    const passHash = await getSetting('passcode_hash');
    const salt = 'cv-agent-v1:';

    if (op === 'status') {
      return j({ ok: true, has_key: !!apiKey(), pass_set: !!passHash, model: await getSetting('model') });
    }
    if (op === 'setup') {
      if (passHash) return j({ error: 'passcode already set' }, 400);
      const p = String(b.passcode || '');
      if (p.length < 6) return j({ error: 'use at least 6 characters' }, 400);
      await setSetting('passcode_hash', await sha(salt + p));
      return j({ ok: true });
    }
    // everything below needs the passcode
    if (!passHash) return j({ error: 'setup_needed' }, 403);
    if ((await sha(salt + String(req.headers.get('x-agent-pass') || ''))) !== passHash) return j({ error: 'bad_passcode' }, 403);

    if (op === 'verify') return j({ ok: true });
    if (op === 'models') {
      if (!apiKey()) return j({ error: 'no_api_key' }, 400);
      return j({ ok: true, models: await listModels(), current: await pickModel() });
    }
    if (op === 'set_model') { await setSetting('model', String(b.model || '')); return j({ ok: true }); }
    if (op === 'chats') {
      const { data } = await supa.from('agent_chats').select('id,title,card_id,updated_at,status').eq('archived', false).order('updated_at', { ascending: false }).limit(40);
      return j({ ok: true, chats: data || [] });
    }
    if (op === 'archive') { await supa.from('agent_chats').update({ archived: true }).eq('id', b.chat_id); return j({ ok: true }); }
    if (op === 'poll') {
      const { data: chat } = await supa.from('agent_chats').select('id,title,status,progress,error,updated_at').eq('id', b.chat_id).single();
      let q = supa.from('agent_messages').select('id,role,display,actions,created_at').eq('chat_id', b.chat_id).not('display', 'is', null).order('id', { ascending: true });
      if (b.after) q = q.gt('id', b.after);
      const { data: msgs } = await q;
      return j({ ok: true, chat, messages: msgs || [] });
    }
    if (op === 'jobs') {
      const { data } = await supa.from('agent_jobs').select('*').order('id', { ascending: false }).limit(50);
      return j({ ok: true, jobs: data || [] });
    }
    if (op === 'send') {
      if (!apiKey()) return j({ error: 'no_api_key' }, 400);
      const text = String(b.text || '').trim();
      if (!text) return j({ error: 'empty' }, 400);
      let chatId = b.chat_id ? Number(b.chat_id) : 0;
      if (chatId) {
        const { data: ch } = await supa.from('agent_chats').select('status,run_started_at').eq('id', chatId).single();
        if (ch && ch.status === 'working' && ch.run_started_at && Date.now() - new Date(ch.run_started_at).getTime() < 400000) return j({ error: 'busy' }, 409);
      } else {
        const { data: nc, error } = await supa.from('agent_chats').insert({ title: text.slice(0, 80), card_id: b.card_id || null }).select('id').single();
        if (error) return j({ error: error.message }, 500);
        chatId = nc.id;
      }
      const ctxLine = b.card_id ? await cardContext(b.card_id) : '';
      const model = await pickModel(b.model);
      await addMsg(chatId, 'user', [{ type: 'text', text: ctxLine + text }], text);
      await supa.from('agent_chats').update({ status: 'working', progress: 'Thinking', error: null, run_started_at: now(), updated_at: now() }).eq('id', chatId);
      // @ts-ignore EdgeRuntime is provided by Supabase
      EdgeRuntime.waitUntil(runAgent(chatId, model));
      return j({ ok: true, chat_id: chatId, model });
    }
    return j({ error: 'unknown op' }, 400);
  } catch (e) {
    return j({ error: String(e) }, 500);
  }
});
