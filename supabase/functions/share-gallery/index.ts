import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SECRET = 'cv_ingest_7Kq2mZ';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ingest-secret, x-agent-pass',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
function j(o: unknown, s = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json', ...extra } });
}
const supa = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Only buyer-safe columns. Never cost basis, P&L, notes, acquisition data, sale data.
const SAFE = 'id,ref,player,year,set_name,card_number,variation,serial,grade,grader,cert_number,is_auto,is_rookie,is_relic,status,current_value,ask_price,not_for_sale,share_hidden,team,tax_domain,tax_league,tax_category,tax_franchise,tax_set_line,item_type,sport,category,value_recent,value_source,serial_den,photos(side,is_primary,url,display_url,thumb_url),hold_offer_id';

// Asking-price base (Drew, Sep 29 2026): the most recent sold comp. Falls back to market value when
// there is no recent comp, when the card is a 1/1 or model-valued (its "recent" is a comparable, not this card),
// or when the recent sale is under half or over double the market value (likely a different card or an outlier).
function askBase(c: any) {
  const v = +c.current_value || 0; const r = c.value_recent != null ? +c.value_recent : null;
  const oneOff = c.serial_den === 1 || /^(sketch|owner|estimate|ebay-relative|cost\+25)/i.test(c.value_source || '');
  if (r && !oneOff && (!v || (r >= v * 0.5 && r <= v * 2))) return r;
  return v || null;
}
function niceCeil(v: number) {
  const step = v < 20 ? 1 : v < 250 ? 5 : v < 1000 ? 10 : 25;
  return Math.ceil(v / step) * step;
}
// Link discount (Drew, Sep 30 2026): applies to every shown price on the link, hand-set asking prices included.
// Only while the link's discount is live; the gallery shows the listed price struck through above it.
function discountOf(link: any) {
  const d = +link.discount_pct || 0;
  if (d <= 0 || d >= 100 || link.price_mode === 'hide') return 0;
  if (link.discount_ends_at && new Date(link.discount_ends_at).getTime() < Date.now()) return 0;
  return d;
}
function cleanGrade(g: string | null, grader?: string | null) {
  if (!g || /^\s*(raw|sketch|auto|sealed|none|n\/a)\b/i.test(g) || /ungraded/i.test(g)) return null;
  let s = String(g).trim();
  const G = /(PSA|BGS|SGC|CGC|BAS|HGA|DGA|GMA|EMC|CSG|TAG|BVG|CGA|Beckett)/i;
  if (grader && !/raw/i.test(grader) && !G.test(s)) s = `${grader} ${s}`;
  else if (/^\d+(\.\d)?$/.test(s)) s = `Graded ${s}`;
  const dual = s.match(/\b(PSA|BGS|SGC|CGC|BAS|HGA|DGA|GMA|EMC)\b[^/]*?(\d+(?:\.5)?)\s*(?:[A-Z -]*)\/\s*AUTO\s*(\d+)/i);
  if (dual) return `${dual[1].toUpperCase()} ${dual[2]} / Auto ${dual[3]}`;
  if (/PSA\/DNA/i.test(s)) { const n = s.match(/(?:auto\s*)?(10|[1-9](?:\.5)?)\b/i); return n && /10|[1-9]/.test(n[1]) && /auto\s*\d/i.test(s) ? `PSA/DNA Auto ${n[1]}` : 'PSA/DNA Authentic'; }
  const m = s.match(/\b(PSA|BGS|BVG|SGC|CGC|CSG|BAS|HGA|DGA|GMA|EMC|TAG)\s*\.?\s*(10|[1-9](?:\.\d)?)\b/i);
  if (m) return m[1].toUpperCase() + ' ' + m[2];
  if (/authentic/i.test(s)) return s.split(/\s+-\s+/)[0].trim();
  return s.split(/\s+-\s+|\(/)[0].trim() || null;
}
function cleanPlayer(p: string | null) {
  if (!p) return '';
  return String(p)
    .replace(/\s+(PSA|BGS|SGC|CGC|BAS|HGA|DGA)(\/DNA)?\b.*$/i, '')
    .replace(/\s+\((?:\/|\d+\/)\d+\)\s*$/, '')
    .trim();
}
function segKey(c: any) {
  const ref = c.ref || '';
  const cap = (x: string) => x ? x.charAt(0).toUpperCase() + x.slice(1) : x;
  const L: Record<string, string> = { baseball: 'Baseball', basketball: 'Basketball', football: 'Football', wrestling: 'Wrestling', mma: 'MMA', golf: 'Golf', boxing: 'Boxing', hockey: 'Hockey', racing: 'Racing', soccer: 'Soccer', tennis: 'Tennis' };
  const C: Record<string, string> = { film_tv: 'Film & TV', music: 'Music', comics: 'Comics', games: 'Games', history_politics: 'History & Politics', novelty: 'Novelty' };
  if (c.tax_set_line === 'project_70') return 'Project 70';
  if (c.tax_franchise === 'star_wars') return 'Star Wars';
  if (c.tax_domain === 'sports') return L[c.tax_league] || (c.tax_league ? cap(c.tax_league) : 'Sports (other)');
  if (c.tax_domain === 'culture') return C[c.tax_category] || (c.tax_category ? cap(c.tax_category) : 'Culture (other)');
  if (ref.startsWith('P70') || ref.startsWith('TIE')) return 'Project 70';
  if (/^(SWSK|SWA|SWPP|SPSK|SW-)/.test(ref)) return 'Star Wars';
  if (c.item_type === 'sealed') return 'Sealed wax';
  if (c.sport) return cap(String(c.sport));
  const cat = c.category || '';
  if (/Entertainment/i.test(cat)) return 'Film & TV';
  if (/Pokemon/i.test(cat)) return 'Games';
  if (/Sports|Basketball|Graded|Raw Sports/i.test(cat)) return 'Sports (other)';
  return 'Unclassified';
}
function pickPhotos(ps: any[]) {
  ps = ps || [];
  const f = ps.find((p) => p.side === 'front' && p.is_primary) || ps.find((p) => p.side === 'front') || ps.find((p) => p.is_primary) || ps[0];
  const b = ps.find((p) => p.side === 'back' && p !== f);
  const pack = (p: any) => (p ? { img: p.display_url || p.url, thumb: p.thumb_url || p.display_url || p.url, clean: !!p.display_url } : null);
  return { front: pack(f), back: pack(b) };
}

async function resolveCards(db: any, link: any) {
  let rows: any[] = [];
  const page = async (q: any) => {
    let out: any[] = []; let from = 0;
    while (true) {
      const { data, error } = await q().range(from, from + 999);
      if (error) throw error;
      out = out.concat(data || []);
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    return out;
  };
  if (link.scope_type === 'all' || link.scope_type === 'segment') {
    rows = await page(() => db.from('cards').select(SAFE).not('status', 'in', '(sold,duplicate)').or('share_hidden.is.null,share_hidden.eq.false').order('current_value', { ascending: false, nullsFirst: false }));
    if (link.scope_type === 'segment') rows = rows.filter((c) => segKey(c) === link.segment);
  } else {
    let ids: string[] = [];
    if (link.scope_type === 'lot' && link.lot_id) {
      const { data } = await db.from('lot_items').select('card_id').eq('lot_id', link.lot_id);
      ids = (data || []).map((r: any) => r.card_id);
    } else ids = link.card_ids || [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('cards').select(SAFE).in('id', ids.slice(i, i + 200));
      if (error) throw error;
      rows = rows.concat(data || []);
    }
    rows = rows.filter((c) => c.status !== 'duplicate' && c.status !== 'sold');
    rows.sort((a, b) => (+b.current_value || 0) - (+a.current_value || 0));
  }
  return rows;
}

async function compsFor(db: any, ids: string[]) {
  const m: Record<string, any[]> = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from('card_market_items').select('card_id,price,item_date').eq('kind', 'sold').eq('matched', true).in('card_id', ids.slice(i, i + 200)).order('item_date', { ascending: false }).limit(4000);
    for (const r of data || []) { (m[r.card_id] = m[r.card_id] || []).length < 5 && m[r.card_id].push({ d: r.item_date, p: +r.price }); }
  }
  return m;
}

// One price per card for a link, used by the gallery and re-checked when an offer comes in
// (buyers never send prices the server trusts).
function cardPrice(link: any, c: any, disc: number) {
  let price: number | null = null;
  if (c.status !== 'sold' && !c.not_for_sale) {
    if (link.price_mode === 'ask') { const b = askBase(c); price = c.ask_price != null ? +c.ask_price : (b ? niceCeil(b * (1 + (+link.markup_pct || 0) / 100)) : null); }
    else if (link.price_mode === 'value') price = c.ask_price != null ? +c.ask_price : (c.current_value ? (+c.current_value < 250 ? Math.max(1, Math.round(+c.current_value)) : niceCeil(+c.current_value)) : null);
  }
  let list: number | undefined;
  if (disc && price != null) { list = price; price = Math.max(1, Math.round(price * (1 - disc / 100))); }
  const comp = c.current_value ? Math.round(+c.current_value * 100) / 100 : null;
  return { price, list, comp };
}
const cardTitle = (c: any) => [cleanPlayer(c.player), c.year && !String(c.set_name || '').startsWith(String(c.year)) ? c.year : '', c.set_name, c.card_number ? '#' + String(c.card_number).replace(/^#/, '') : '', cleanGrade(c.grade, c.grader) || ''].filter(Boolean).join(' ');

async function publicView(slug: string) {
  const db = supa();
  const { data: link } = await db.from('share_links').select('*').eq('slug', slug).maybeSingle();
  if (!link || !link.active) return j({ error: 'This link is no longer active.' }, 404);
  const rows = await resolveCards(db, link);
  const withPhoto = rows.filter((c) => (c.photos || []).length);
  const comps = link.show_comps ? await compsFor(db, withPhoto.map((c) => c.id)) : {};
  const disc = discountOf(link);
  const cards = withPhoto.map((c) => {
    const sold = c.status === 'sold';
    const nfs = !!c.not_for_sale;
    const { price, list, comp } = cardPrice(link, c, disc);
    const tags: string[] = [];
    if (c.is_rookie) tags.push('RC');
    if (c.is_auto) tags.push('Auto');
    if (c.is_relic) tags.push('Relic');
    return {
      id: c.ref, player: cleanPlayer(c.player), year: c.year || '', set: c.set_name || '',
      num: c.card_number ? String(c.card_number).replace(/^#/, '') : '', variation: c.variation && !/^base$/i.test(c.variation) ? c.variation : '',
      serial: c.serial && c.serial !== '-' ? c.serial : '', grade: cleanGrade(c.grade, c.grader), cert: c.cert_number || null,
      team: c.team || '', tags, seg: segKey(c), price, list, comp, hold: !!c.hold_offer_id, nfs, sold, photos: pickPhotos(c.photos), comps: comps[c.id] || undefined,
    };
  });
  db.from('share_links').update({ views: (link.views || 0) + 1, last_viewed_at: new Date().toISOString() }).eq('id', link.id).then(() => {});
  return j({
    title: link.title, intro: link.intro, terms: link.terms, contact: link.contact,
    price_mode: link.price_mode, show_comps: link.show_comps, count: cards.length, cards,
    recipient: link.recipient || null, discount_pct: disc || null, discount_ends_at: disc ? link.discount_ends_at : null,
    allow_offers: link.allow_offers !== false,
  }, 200, { 'cache-control': 'public, max-age=60' });
}

/* ================= Offers (Drew, Oct 26 2026) =================
 Buyers pick cards on a link and send a claim (at the shown price) or an offer (whole lot or per card).
 Drew accepts, counters or declines in the app; the buyer follows along on a private status page
 (/o/<token>) and can accept, counter back or decline a counter. Accepted offers put the cards on hold
 (still visible, open to backup offers); Drew marks them sold from the app. */
const GALLERY = 'https://drew-austin-cards.vercel.app';
const money = (v: number | null | undefined) => v == null ? '--' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 2 : 0 });
const r2 = (v: number) => Math.round(v * 100) / 100;
function token() { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (const x of crypto.getRandomValues(new Uint8Array(22))) s += a[x % a.length]; return s; }

// Email via Resend when RESEND_API_KEY is set. Drew's alerts go to NOTIFY_EMAIL; buyer emails need a
// verified sender in RESEND_FROM. Failures never block the offer itself.
async function sendEmail(to: string, subject: string, text: string) {
  const key = Deno.env.get('RESEND_API_KEY'); if (!key || !to) return false;
  const from = Deno.env.get('RESEND_FROM') || 'Card Vault <onboarding@resend.dev>';
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text }) });
    return r.ok;
  } catch (_) { return false; }
}
const notifyDrew = (subject: string, text: string) => sendEmail(Deno.env.get('NOTIFY_EMAIL') || '', subject, text);
async function notifyBuyer(o: any, subject: string, text: string) {
  if (o.buyer_via !== 'email' || !Deno.env.get('RESEND_FROM')) return false;
  return sendEmail(o.buyer_contact, subject, text);
}

async function setHolds(db: any, offerId: string, on: boolean) {
  if (on) {
    const { data } = await db.from('offer_items').select('card_id').eq('offer_id', offerId).eq('included', true);
    const ids = (data || []).map((r: any) => r.card_id);
    if (ids.length) await db.from('cards').update({ hold_offer_id: offerId }).in('id', ids).is('hold_offer_id', null);
  } else await db.from('cards').update({ hold_offer_id: null }).eq('hold_offer_id', offerId);
}
async function addEvent(db: any, offerId: string, actor: string, action: string, amount: number | null, note: string | null) {
  await db.from('offer_events').insert({ offer_id: offerId, actor, action, amount, note: note || null });
}

async function submitOffer(b: any) {
  if (b.website) return j({ ok: true, token: null }); // honeypot: bots fill every field
  const db = supa();
  const slug = String(b.slug || '').replace(/[^a-z0-9-]/gi, '');
  const { data: link } = await db.from('share_links').select('*').eq('slug', slug).maybeSingle();
  if (!link || !link.active) return j({ error: 'This link is no longer active.' }, 404);
  const name = String(b.name || '').trim().slice(0, 80), contact = String(b.contact || '').trim().slice(0, 120);
  const via = ['text', 'email', 'ig'].includes(b.via) ? b.via : 'text';
  if (!name || !contact) return j({ error: 'Add your name and how to reach you.' }, 400);
  const since = new Date(Date.now() - 10 * 60e3).toISOString();
  const { count } = await db.from('offers').select('id', { count: 'exact', head: true }).eq('link_id', link.id).gte('created_at', since);
  if ((count || 0) >= 15) return j({ error: 'Too many offers on this link just now. Try again in a few minutes.' }, 429);

  const want = new Map<string, any>(); for (const it of (b.items || []).slice(0, 600)) if (it && it.id) want.set(String(it.id), it);
  if (!want.size) return j({ error: 'Pick at least one card.' }, 400);
  const rows = (await resolveCards(db, link)).filter((c) => want.has(c.ref) && c.status !== 'sold' && !c.not_for_sale);
  if (!rows.length) return j({ error: 'Those cards are no longer available.' }, 409);
  const disc = discountOf(link);
  const items = rows.map((c) => { const p = cardPrice(link, c, disc); const ph = pickPhotos(c.photos); return { c, ...p, title: cardTitle(c), thumb: ph.front ? ph.front.thumb : null, req: want.get(c.ref) }; });
  const shown = items.reduce((t, x) => t + (x.price || 0), 0), unpriced = items.filter((x) => x.price == null).length;
  const listed = items.reduce((t, x) => t + (x.list ?? x.price ?? 0), 0), comp = items.reduce((t, x) => t + (x.comp || 0), 0);

  let kind = b.kind === 'per_card' ? 'per_card' : 'lot', total = 0;
  if (kind === 'per_card') {
    for (const x of items) { const v = +x.req.offer; if (!(v > 0)) return j({ error: 'Enter an offer for every card.' }, 400); (x as any).offer = r2(v); total += v; }
  } else {
    total = +b.total_offer; if (!(total > 0)) return j({ error: 'Enter your offer.' }, 400);
    // spread a lot offer across cards by shown price (comp when a card has no price) so partial deals can be priced
    const w = items.map((x) => x.price ?? x.comp ?? 1), ws = w.reduce((a, v) => a + v, 0) || 1;
    items.forEach((x, i) => { (x as any).offer = r2(total * w[i] / ws); });
  }
  total = r2(total);
  const claim = !unpriced && (kind === 'per_card' ? items.every((x: any) => x.offer >= (x.price || 0)) : total >= shown);
  if (link.allow_offers === false && !claim) return j({ error: 'This link takes claims at the listed price only.' }, 400);
  if (claim) kind = 'claim';

  const tok = token();
  const { data: o, error } = await db.from('offers').insert({
    link_id: link.id, token: tok, kind, buyer_name: name, buyer_via: via, buyer_contact: contact, message: String(b.message || '').slice(0, 1000) || null,
    total_list: r2(listed), total_shown: r2(shown), total_comp: r2(comp), total_offer: total, status: 'new', turn: 'seller',
  }).select('*').single();
  if (error) return j({ error: error.message }, 500);
  await db.from('offer_items').insert(items.map((x: any) => ({ offer_id: o.id, card_id: x.c.id, ref: x.c.ref, title: x.title, thumb: x.thumb, listed: x.list ?? x.price, shown: x.price, comp: x.comp, offer_price: x.offer })));
  await addEvent(db, o.id, 'buyer', 'offer', total, o.message);
  const url = `${GALLERY}/o/${tok}`;
  await notifyDrew(`${claim ? 'Claim' : 'Offer'}: ${money(total)} for ${items.length} card${items.length === 1 ? '' : 's'} from ${name}`,
    `${name} (${via}: ${contact}) ${claim ? 'claimed' : 'offered'} ${money(total)} on "${link.title}".\nShown ${money(shown)} · comp ${money(comp)}${unpriced ? ' · ' + unpriced + ' unpriced' : ''}\n\n` +
    items.map((x: any) => `• ${x.title} [${x.c.ref}] shown ${money(x.price)} → ${money(x.offer)}`).join('\n') + (o.message ? `\n\nNote: ${o.message}` : '') +
    `\n\nReview it in Card Vault (Share → Offers). Buyer's status page: ${url}`);
  return j({ ok: true, token: tok, status_url: url, kind, total });
}

async function offerView(tok: string) {
  const db = supa();
  const { data: o } = await db.from('offers').select('*').eq('token', tok).maybeSingle();
  if (!o) return j({ error: 'Offer not found.' }, 404);
  const [{ data: items }, { data: ev }, { data: link }] = await Promise.all([
    db.from('offer_items').select('ref,title,thumb,listed,shown,comp,offer_price,counter_price,included').eq('offer_id', o.id),
    db.from('offer_events').select('actor,action,amount,note,created_at').eq('offer_id', o.id).order('created_at'),
    o.link_id ? db.from('share_links').select('slug,title,terms').eq('id', o.link_id).maybeSingle() : Promise.resolve({ data: null } as any),
  ]);
  return j({
    status: o.status, turn: o.turn, kind: o.kind, buyer_name: o.buyer_name, created_at: o.created_at,
    total_list: o.total_list, total_shown: o.total_shown, total_comp: o.total_comp, total_offer: o.total_offer, counter_total: o.counter_total,
    items: items || [], events: ev || [], link: link ? { slug: link.slug, title: link.title, terms: link.terms } : null,
  });
}

async function buyerRespond(b: any) {
  const db = supa();
  const { data: o } = await db.from('offers').select('*').eq('token', String(b.token || '')).maybeSingle();
  if (!o) return j({ error: 'Offer not found.' }, 404);
  const note = String(b.note || '').slice(0, 1000) || null, now = new Date().toISOString();
  const act = b.action;
  if (act === 'withdraw') {
    if (!['new', 'countered'].includes(o.status)) return j({ error: 'This offer is already settled.' }, 409);
    await db.from('offers').update({ status: 'withdrawn', turn: 'none', updated_at: now }).eq('id', o.id);
    await addEvent(db, o.id, 'buyer', 'withdraw', null, note);
    await notifyDrew(`${o.buyer_name} withdrew their offer`, `${o.buyer_name} withdrew their ${money(o.total_offer)} offer.`);
    return j({ ok: true });
  }
  if (o.status !== 'countered' || o.turn !== 'buyer') return j({ error: "It's not your turn on this offer." }, 409);
  if (act === 'accept') {
    await db.from('offers').update({ status: 'accepted', turn: 'none', total_offer: o.counter_total, updated_at: now }).eq('id', o.id);
    await setHolds(db, o.id, true);
    await addEvent(db, o.id, 'buyer', 'accept', o.counter_total, note);
    await notifyDrew(`${o.buyer_name} accepted your ${money(o.counter_total)} counter`, `Deal: ${money(o.counter_total)} with ${o.buyer_name} (${o.buyer_via}: ${o.buyer_contact}). The cards are on hold. Send payment details, then mark it sold in Card Vault.`);
    return j({ ok: true });
  }
  if (act === 'decline') {
    await db.from('offers').update({ status: 'declined', turn: 'none', updated_at: now }).eq('id', o.id);
    await addEvent(db, o.id, 'buyer', 'decline', null, note);
    await notifyDrew(`${o.buyer_name} passed on your counter`, `${o.buyer_name} declined your ${money(o.counter_total)} counter.${note ? '\n\nNote: ' + note : ''}`);
    return j({ ok: true });
  }
  if (act === 'counter') {
    const amt = r2(+b.amount); if (!(amt > 0)) return j({ error: 'Enter an amount.' }, 400);
    await db.from('offers').update({ status: 'new', turn: 'seller', total_offer: amt, seen_at: null, updated_at: now }).eq('id', o.id);
    await addEvent(db, o.id, 'buyer', 'counter', amt, note);
    await notifyDrew(`${o.buyer_name} countered at ${money(amt)}`, `${o.buyer_name} countered your ${money(o.counter_total)} with ${money(amt)}.${note ? '\n\nNote: ' + note : ''}\n\nReview it in Card Vault (Share → Offers).`);
    return j({ ok: true });
  }
  return j({ error: 'unknown action' }, 400);
}

async function listOffers(db: any) {
  const { data: offers, error } = await db.from('offers').select('*').order('created_at', { ascending: false }).limit(300);
  if (error) return j({ error: error.message }, 500);
  const ids = (offers || []).map((o: any) => o.id);
  const items: any[] = [], ev: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const s = ids.slice(i, i + 100);
    const [{ data: it }, { data: e }] = await Promise.all([
      db.from('offer_items').select('*,cards(cost_basis,current_value,status,hold_offer_id)').in('offer_id', s),
      db.from('offer_events').select('*').in('offer_id', s).order('created_at'),
    ]);
    items.push(...(it || [])); ev.push(...(e || []));
  }
  const { data: links } = await db.from('share_links').select('id,title,slug,recipient');
  const L: Record<string, any> = {}; (links || []).forEach((l: any) => { L[l.id] = l; });
  return j({ ok: true, offers: (offers || []).map((o: any) => ({ ...o, link: L[o.link_id] || null, status_url: `${GALLERY}/o/${o.token}`, items: items.filter((x) => x.offer_id === o.id), events: ev.filter((x) => x.offer_id === o.id) })) });
}

async function sellerRespond(db: any, b: any) {
  const { data: o } = await db.from('offers').select('*').eq('id', b.id).maybeSingle();
  if (!o) return j({ error: 'Offer not found.' }, 404);
  const note = String(b.note || '').slice(0, 1000) || null, now = new Date().toISOString(), act = b.action;
  const url = `${GALLERY}/o/${o.token}`;
  if (act === 'seen') { await db.from('offers').update({ seen_at: now }).eq('id', o.id); return j({ ok: true }); }
  if (act === 'accept') {
    if (!['new', 'countered'].includes(o.status)) return j({ error: 'Offer is already settled.' }, 409);
    let total = +o.total_offer;
    const ex: string[] = Array.isArray(b.exclude) ? b.exclude : [];
    if (ex.length) {
      await db.from('offer_items').update({ included: false }).eq('offer_id', o.id).in('card_id', ex);
      const { data: it } = await db.from('offer_items').select('offer_price').eq('offer_id', o.id).eq('included', true);
      total = r2((it || []).reduce((t: number, x: any) => t + (+x.offer_price || 0), 0));
    }
    await db.from('offers').update({ status: 'accepted', turn: 'none', total_offer: total, seen_at: now, updated_at: now }).eq('id', o.id);
    await setHolds(db, o.id, true);
    await addEvent(db, o.id, 'seller', 'accept', total, note || (ex.length ? `Accepted ${ex.length ? 'some of the cards' : ''}` : null));
    await notifyBuyer(o, `Your offer was accepted: ${money(total)}`, `Good news, ${o.buyer_name}: your offer of ${money(total)} was accepted.${note ? '\n\n' + note : ''}\n\nDetails: ${url}`);
    return j({ ok: true, status_url: url, total });
  }
  if (act === 'counter') {
    if (!['new', 'countered'].includes(o.status)) return j({ error: 'Offer is already settled.' }, 409);
    const amt = r2(+b.amount); if (!(amt > 0)) return j({ error: 'Enter a counter amount.' }, 400);
    await db.from('offers').update({ status: 'countered', turn: 'buyer', counter_total: amt, seen_at: now, updated_at: now }).eq('id', o.id);
    await addEvent(db, o.id, 'seller', 'counter', amt, note);
    const emailed = await notifyBuyer(o, `Counter offer: ${money(amt)}`, `${o.buyer_name}, thanks for your offer of ${money(o.total_offer)}. I can do ${money(amt)}.${note ? '\n\n' + note : ''}\n\nAccept, counter or pass here: ${url}`);
    return j({ ok: true, status_url: url, emailed });
  }
  if (act === 'decline') {
    await db.from('offers').update({ status: 'declined', turn: 'none', seen_at: now, updated_at: now }).eq('id', o.id);
    await setHolds(db, o.id, false);
    await addEvent(db, o.id, 'seller', 'decline', null, note);
    const emailed = await notifyBuyer(o, 'About your offer', `${o.buyer_name}, thanks for the offer of ${money(o.total_offer)}. I'm going to pass this time.${note ? '\n\n' + note : ''}\n\n${url}`);
    return j({ ok: true, status_url: url, emailed });
  }
  if (act === 'sold') {
    // the app records each card's sale (lot-ops sell_card) first, then closes the offer here
    await db.from('offers').update({ status: 'sold', turn: 'none', updated_at: now }).eq('id', o.id);
    await setHolds(db, o.id, false);
    await addEvent(db, o.id, 'seller', 'sold', +o.total_offer, note);
    return j({ ok: true });
  }
  if (act === 'release') {
    await db.from('offers').update({ status: 'declined', turn: 'none', updated_at: now }).eq('id', o.id);
    await setHolds(db, o.id, false);
    await addEvent(db, o.id, 'seller', 'release', null, note || 'Deal fell through; cards released.');
    return j({ ok: true });
  }
  return j({ error: 'unknown action' }, 400);
}

function slugify() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = ''; const r = crypto.getRandomValues(new Uint8Array(10));
  for (const x of r) s += a[x % a.length];
  return s;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const u = new URL(req.url);
    if (req.method === 'GET') {
      const ot = (u.searchParams.get('o') || '').replace(/[^a-z0-9]/gi, '');
      if (ot) return await offerView(ot);
      const s = (u.searchParams.get('s') || '').replace(/[^a-z0-9-]/gi, '');
      if (!s) return j({ error: 'missing link' }, 400);
      return await publicView(s);
    }
    const b = await req.json();
    // buyer actions: public, priced and validated server-side
    if (b.op === 'submit_offer') return await submitOffer(b);
    if (b.op === 'buyer_respond') return await buyerRespond(b);
    if (!(await vaultAuthorized(req))) return j({ error: 'locked' }, 401);
    const db = supa();
    const op = b.op;
    const fields = ['title', 'intro', 'scope_type', 'lot_id', 'segment', 'card_ids', 'price_mode', 'markup_pct', 'show_comps', 'terms', 'contact', 'active', 'recipient', 'discount_pct', 'discount_ends_at', 'allow_offers'];
    const pick = (o: any) => { const r: any = {}; for (const k of fields) if (o[k] !== undefined) r[k] = o[k]; return r; };
    if (op === 'list_offers') return await listOffers(db);
    if (op === 'offer_respond') return await sellerRespond(db, b);
    if (op === 'list_links') {
      const { data, error } = await db.from('share_links').select('*').order('created_at', { ascending: false });
      if (error) return j({ error: error.message }, 500);
      return j({ ok: true, links: data });
    }
    if (op === 'create_link') {
      const row = { ...pick(b), slug: b.slug || slugify() };
      if (!row.title) row.title = 'Card collection';
      const { data, error } = await db.from('share_links').insert(row).select('*').single();
      if (error) return j({ error: error.message }, 500);
      return j({ ok: true, link: data });
    }
    if (op === 'update_link') {
      const { data, error } = await db.from('share_links').update({ ...pick(b), updated_at: new Date().toISOString() }).eq('id', b.id).select('*').single();
      if (error) return j({ error: error.message }, 500);
      return j({ ok: true, link: data });
    }
    if (op === 'delete_link') {
      const { error } = await db.from('share_links').delete().eq('id', b.id);
      if (error) return j({ error: error.message }, 500);
      return j({ ok: true });
    }
    if (op === 'set_card') {
      const upd: any = {};
      for (const k of ['ask_price', 'not_for_sale', 'share_hidden']) if (b[k] !== undefined) upd[k] = b[k];
      const { error } = await db.from('cards').update(upd).eq('id', b.card_id);
      if (error) return j({ error: error.message }, 500);
      return j({ ok: true });
    }
    if (op === 'put_display') {
      const bin = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const base = Deno.env.get('SUPABASE_URL');
      const v = Date.now();
      const p1 = `display/${b.card_id}/${b.photo_id}-${v}.webp`;
      const p2 = `display/${b.card_id}/${b.photo_id}-${v}-t.webp`;
      const u1 = await db.storage.from('card-photos').upload(p1, bin(b.display_b64), { contentType: 'image/webp', upsert: true, cacheControl: '31536000' });
      if (u1.error) return j({ error: 'upload: ' + u1.error.message }, 500);
      const u2 = await db.storage.from('card-photos').upload(p2, bin(b.thumb_b64), { contentType: 'image/webp', upsert: true, cacheControl: '31536000' });
      if (u2.error) return j({ error: 'upload thumb: ' + u2.error.message }, 500);
      const pub = (p: string) => `${base}/storage/v1/object/public/card-photos/${p}`;
      const { error } = await db.from('photos').update({ display_url: pub(p1), thumb_url: pub(p2), display_ok: !!b.ok, display_at: new Date().toISOString() }).eq('id', b.photo_id);
      if (error) return j({ error: error.message }, 500);
      return j({ ok: true, display_url: pub(p1), thumb_url: pub(p2) });
    }
    return j({ error: 'unknown op' }, 400);
  } catch (e) { return j({ error: String(e) }, 500); }
});
