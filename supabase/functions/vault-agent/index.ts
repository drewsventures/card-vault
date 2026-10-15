// vault-agent: Drew's in-app Vault assistant (Oct 15 2026). Runs on Venice (OpenAI-compatible tool calling).
// Work that needs Drew's browser or a deeper pass is handed to Claude on Drew's plan via agent_jobs + a scheduled pickup.
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
const API = 'https://api.venice.ai/api/v1';
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
function apiKey() { return Deno.env.get('VENICE_API_KEY') || Deno.env.get('VENICE_INFERENCE_KEY') || ''; }
function hdrs() { return { Authorization: 'Bearer ' + apiKey(), 'content-type': 'application/json' }; }

// ---------- models ----------
async function listModels(): Promise<{ id: string; name: string; in: number | null; out: number | null; traits: string[]; privacy: string }[]> {
  const r = await fetch(API + '/models?type=text', { headers: hdrs() });
  if (!r.ok) throw new Error('models ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const d = await r.json();
  return (d.data || []).filter((m: any) => m.model_spec?.capabilities?.supportsFunctionCalling && !m.model_spec?.offline && !/^e2ee-/.test(m.id))
    .map((m: any) => ({ id: m.id, name: m.model_spec?.name || m.id, in: m.model_spec?.pricing?.input?.usd ?? null, out: m.model_spec?.pricing?.output?.usd ?? null, traits: m.model_spec?.traits || [], privacy: m.model_spec?.privacy || '' }));
}
async function pickModel(pref?: string) {
  if (pref) return pref;
  const s = await getSetting('model');
  if (s && typeof s === 'string') return s;
  const env = Deno.env.get('VAULT_AGENT_MODEL');
  if (env) return env;
  const ms = await listModels();
  const def = ms.find((m) => m.traits.includes('function_calling_default')) || ms.find((m) => m.traits.includes('default')) || ms[0];
  return def.id;
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
    name: 'hand_to_claude',
    description: 'Hand this request to Claude, which runs on Drew\'s Claude plan with his logged-in browser and replies in this same chat at its next pickup (top of each hour, 8am to 11pm ET). Use it for: Card Ladder or live eBay sold comps, any new valuation, building or revising eBay drafts, Facebook posts, photo work, research you cannot verify from the database, or anything you are not confident you can do correctly. Write complete instructions (refs, what Drew wants, what you already found). After calling it, tell Drew in one line that Claude will pick it up.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['comps', 'ebay_draft', 'ebay_revise', 'facebook', 'photos', 'research', 'other'] }, refs: { type: 'array', items: { type: 'string' } }, instructions: { type: 'string' } }, required: ['kind', 'instructions'] },
  },
];
const OA_TOOLS = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

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
        await supa.from('card_change_log').insert({ card_id: card.id, ref: card.ref, source: 'vault-agent', prior, note: ('In-app assistant: ' + (ch.why || '') + ' | set ' + keys.join(', ')).slice(0, 1000) });
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
        await supa.from('card_change_log').insert({ card_id: d.id, ref: d.ref, source: 'vault-agent', prior: {}, note: ('In-app assistant created card: ' + (input.why || '')).slice(0, 1000) });
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
    if (name === 'hand_to_claude' || name === 'queue_desktop_job') {
      const refs = input.refs || [];
      let ids: string[] = [];
      if (refs.length) { const { data: cs } = await supa.from('cards').select('id').in('ref', refs); ids = (cs || []).map((c: any) => c.id); }
      const { data, error } = await supa.from('agent_jobs').insert({ chat_id: ctx.chatId, kind: input.kind, refs, card_ids: ids, instructions: String(input.instructions).slice(0, 4000) }).select().single();
      if (error) return { text: 'error: ' + error.message, isError: true };
      ctx.jobs.push({ id: data.id, kind: data.kind, refs, instructions: data.instructions });
      await supa.from('agent_chats').update({ with_claude: true }).eq('id', ctx.chatId);
      return { text: cap({ handed_to_claude: true, job: data.id, pickup: 'top of the next hour, 8am to 11pm ET' }) };
    }
    return { text: 'unknown tool ' + name, isError: true };
  } catch (e) {
    return { text: 'tool failed: ' + String(e), isError: true };
  }
}

const TOOL_LABEL: Record<string, string> = {
  query_vault: 'Looking it up', update_cards: 'Updating cards', create_cards: 'Adding cards', insert_records: 'Saving records',
  update_records: 'Updating records', request_comp_refresh: 'Queueing comp refresh', hand_to_claude: 'Handing to Claude',
};

async function systemPrompt() {
  const { data: rules } = await supa.from('vault_rules').select('scope,rule').eq('active', true).order('id');
  const ruleTxt = (rules || []).map((r: any) => '- [' + r.scope + '] ' + r.rule).join('\n');
  return `You are the Vault assistant inside Card Vault, Drew Austin's private trading card investing app. You run on a Venice model; for browser work or anything you cannot do confidently you hand off to Claude with hand_to_claude. Drew runs this as a business: about $100k deployed, run like a VC portfolio, aiming to compound. You are talking only to Drew. Today is ${today()}.

You can read the whole database with query_vault and change things with the write tools. Do the work, then answer. Drew wants speed and automation: act on clear requests without asking permission, but ask one short question when a request is ambiguous in a way that would change data (for example, which of two matching cards he means). Never invent facts.

STANDING RULES (Drew's, always follow)
- No em dashes anywhere in what you write. Use commas, colons, parentheses or separate sentences.
- Never guess. If something is not in the data and cannot be verified, say so plainly. Label any estimate as an estimate.
- Values come from Card Ladder plus eBay sold comps matched to the exact parallel AND the exact card number. You cannot pull Card Ladder or live eBay sold data: for any new comp or valuation, use hand_to_claude(kind "comps"). Web search results are never comps.
- Never delete data. Retire bad or duplicate rows with status='duplicate'.
- Every changed card gets needs_review=true (the tool does this).
- Shipping and tax stay off cost basis.
- When a buyer offer is 20% or more over comp, flag it and ask Drew.
- Facebook sales: the buyer adds 3% for PayPal G&S.
- Drew reviews and publishes all eBay listings himself. Drafts are built by Claude (hand_to_claude kind "ebay_draft").
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
- agent_jobs: work handed to Claude.
If unsure of a column, query information_schema.columns first.

HOW TO ANSWER
- Be brief and concrete. Lead with the answer. Use a small markdown table when comparing several cards. Refer to cards by ref and name, e.g. "BKB-0978 Michael Jordan By the Letter /23".
- Money as $1,234. Show paid, value today and gain/loss when relevant.
- After making changes, say exactly what changed in one or two lines.
- If Drew is viewing a card, the message starts with a [Viewing ...] context line: "this card" means that card.
- Data questions: always query, never answer from memory. If a query errors, fix it and retry.
- Messages labeled as from Claude in the history are Claude's earlier replies in this chat.`;
}

// ---------- the agent loop (OpenAI-format messages, stored one per row) ----------
async function loadHistory(chatId: number) {
  const { data } = await supa.from('agent_messages').select('role,content,source').eq('chat_id', chatId).order('id', { ascending: true });
  let msgs: any[] = (data || []).map((m: any) => {
    const c = m.content && typeof m.content === 'object' && !Array.isArray(m.content) ? { ...m.content } : { role: m.role, content: String(m.content ?? '') };
    if (m.role === 'assistant' && m.source === 'claude' && typeof c.content === 'string') c.content = '[Claude, on Drew\'s plan] ' + c.content;
    return c;
  });
  if (msgs.length > 80) {
    let start = msgs.length - 80;
    while (start < msgs.length && msgs[start].role !== 'user') start++;
    msgs = msgs.slice(start);
  }
  // repair: every assistant tool_call needs a tool reply before the next non-tool message
  const out: any[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'tool') { out.push(m); continue; }
    const prev = [...out].reverse().find((x) => x.role !== 'tool');
    if (prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls) && prev.tool_calls.length) {
      const have = new Set(out.slice(out.lastIndexOf(prev) + 1).filter((x) => x.role === 'tool').map((x) => x.tool_call_id));
      for (const tc of prev.tool_calls) if (!have.has(tc.id)) out.push({ role: 'tool', tool_call_id: tc.id, content: 'interrupted' });
    }
    out.push(m);
  }
  const lastNT = [...out].reverse().find((x) => x.role !== 'tool');
  if (lastNT && lastNT.role === 'assistant' && Array.isArray(lastNT.tool_calls)) {
    const have = new Set(out.slice(out.lastIndexOf(lastNT) + 1).filter((x) => x.role === 'tool').map((x) => x.tool_call_id));
    for (const tc of lastNT.tool_calls) if (!have.has(tc.id)) out.push({ role: 'tool', tool_call_id: tc.id, content: 'interrupted' });
  }
  return out;
}
async function addMsg(chatId: number, role: string, content: any, display: string | null, extra: any = {}) {
  const { data } = await supa.from('agent_messages').insert({ chat_id: chatId, role, content, display, ...extra }).select('id').single();
  return data ? data.id : null;
}
async function progress(chatId: number, p: string) {
  await supa.from('agent_chats').update({ progress: p, updated_at: now() }).eq('id', chatId);
}
function stripThink(t: string) { return String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(); }

async function runAgent(chatId: number, model: string) {
  const ctx = { chatId, touched: new Map<string, any>(), jobs: [] as any[], log: [] as string[] };
  const t0 = Date.now();
  const sys = await systemPrompt();
  const usage = { input: 0, output: 0 };
  let finished = false;
  let retries = 0;
  let useEffort = true;
  try {
    for (let step = 0; step < 18; step++) {
      if (Date.now() - t0 > 330000) break;
      const messages = [{ role: 'system', content: sys }, ...(await loadHistory(chatId))];
      const body: any = { model, messages, tools: OA_TOOLS, max_completion_tokens: 4096, temperature: 0.2,
        venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true, enable_web_search: 'off' } };
      if (useEffort) body.reasoning_effort = 'low';
      const r = await fetch(API + '/chat/completions', { method: 'POST', headers: hdrs(), body: JSON.stringify(body) });
      if (!r.ok) {
        const t = await r.text();
        if ((r.status === 429 || r.status === 503 || r.status === 504 || r.status >= 500) && retries < 4) { retries++; step--; await progress(chatId, 'Venice is busy, retrying'); await new Promise((res) => setTimeout(res, 3000 * retries)); continue; }
        if (r.status === 400 && useEffort && /reasoning/i.test(t)) { useEffort = false; step--; continue; }
        throw new Error('Venice ' + r.status + ': ' + t.slice(0, 400));
      }
      const d = await r.json();
      if (d.usage) { usage.input += d.usage.prompt_tokens || 0; usage.output += d.usage.completion_tokens || 0; }
      const msg = (d.choices && d.choices[0] && d.choices[0].message) || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const text = stripThink(msg.content || '');
      const stored: any = { role: 'assistant', content: text || null };
      if (calls.length) stored.tool_calls = calls.map((c: any) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments || '{}' } }));
      const isFinal = !calls.length;
      const extra: any = { model, usage: d.usage || null, source: 'venice' };
      if (isFinal) extra.actions = { cards: [...ctx.touched.values()], jobs: ctx.jobs, log: ctx.log, usage };
      if (isFinal && !text) stored.content = '(no reply)';
      await addMsg(chatId, 'assistant', stored, isFinal ? (text || '(no reply)') : null, extra);
      if (isFinal) { finished = true; break; }
      for (const c of stored.tool_calls) {
        let input: any = {};
        try { input = JSON.parse(c.function.arguments || '{}'); } catch (_) { input = null; }
        await progress(chatId, (input && input.purpose) || TOOL_LABEL[c.function.name] || c.function.name);
        const res = input === null ? { text: 'arguments were not valid JSON, resend them', isError: true } : await runTool(c.function.name, input, ctx);
        await addMsg(chatId, 'tool', { role: 'tool', tool_call_id: c.id, content: (res.isError ? 'ERROR: ' : '') + res.text }, null, { source: 'tool' });
      }
      await progress(chatId, 'Thinking');
    }
    if (!finished) {
      const msg = 'I ran out of time or steps on this one. ' + (ctx.touched.size ? 'I changed ' + ctx.touched.size + ' card(s) so far (see below). ' : '') + 'Say "continue" and I will keep going, or tap To Claude.';
      await addMsg(chatId, 'assistant', { role: 'assistant', content: msg }, msg, { source: 'venice', model, actions: { cards: [...ctx.touched.values()], jobs: ctx.jobs, log: ctx.log, usage } });
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
      return j({ ok: true, provider: 'venice', has_key: !!apiKey(), pass_set: !!passHash, model: await getSetting('model') });
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
      const { data } = await supa.from('agent_chats').select('id,title,card_id,updated_at,status,with_claude').eq('archived', false).order('updated_at', { ascending: false }).limit(40);
      return j({ ok: true, chats: data || [] });
    }
    if (op === 'archive') { await supa.from('agent_chats').update({ archived: true }).eq('id', b.chat_id); return j({ ok: true }); }
    if (op === 'poll') {
      const { data: chat } = await supa.from('agent_chats').select('id,title,status,progress,error,updated_at,with_claude').eq('id', b.chat_id).single();
      let q = supa.from('agent_messages').select('id,role,display,actions,created_at,source,model').eq('chat_id', b.chat_id).not('display', 'is', null).order('id', { ascending: true });
      if (b.after) q = q.gt('id', b.after);
      const { data: msgs } = await q;
      return j({ ok: true, chat, messages: msgs || [] });
    }
    if (op === 'jobs') {
      const { data } = await supa.from('agent_jobs').select('*').order('id', { ascending: false }).limit(50);
      return j({ ok: true, jobs: data || [] });
    }
    if (op === 'send') {
      if (!apiKey() && !b.to_claude) return j({ error: 'no_api_key' }, 400);
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
      const model = b.to_claude ? '' : await pickModel(b.model);
      await addMsg(chatId, 'user', { role: 'user', content: ctxLine + text }, text, { source: 'drew' });
      if (b.to_claude) {
        const { data: job } = await supa.from('agent_jobs').insert({ chat_id: chatId, kind: 'chat', instructions: text.slice(0, 4000), card_ids: b.card_id ? [b.card_id] : [] }).select('id').single();
        await supa.from('agent_chats').update({ with_claude: true, status: 'idle', progress: null, updated_at: now() }).eq('id', chatId);
        return j({ ok: true, chat_id: chatId, to_claude: true, job: job ? job.id : null });
      }
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
