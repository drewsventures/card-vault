import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SECRET = 'cv_ingest_7Kq2mZ';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ingest-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
function j(o: unknown, s = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json', ...extra } });
}
const supa = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Only buyer-safe columns. Never cost basis, P&L, notes, acquisition data, sale data.
const SAFE = 'id,ref,player,year,set_name,card_number,variation,serial,grade,grader,cert_number,is_auto,is_rookie,is_relic,status,current_value,ask_price,not_for_sale,share_hidden,team,tax_domain,tax_league,tax_category,tax_franchise,tax_set_line,item_type,sport,category,value_recent,value_source,serial_den,photos(side,is_primary,url,display_url,thumb_url)';

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
    rows = rows.filter((c) => c.status !== 'duplicate');
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
    let price: number | null = null;
    const nfs = !!c.not_for_sale;
    if (!sold && !nfs) {
      if (link.price_mode === 'ask') { const b = askBase(c); price = c.ask_price != null ? +c.ask_price : (b ? niceCeil(b * (1 + (+link.markup_pct || 0) / 100)) : null); }
      else if (link.price_mode === 'value') price = c.current_value ? niceCeil(+c.current_value) : null;
    }
    let list: number | undefined;
    if (disc && price != null) { list = price; price = Math.max(1, Math.round(price * (1 - disc / 100))); }
    const tags: string[] = [];
    if (c.is_rookie) tags.push('RC');
    if (c.is_auto) tags.push('Auto');
    if (c.is_relic) tags.push('Relic');
    return {
      id: c.ref, player: cleanPlayer(c.player), year: c.year || '', set: c.set_name || '',
      num: c.card_number ? String(c.card_number).replace(/^#/, '') : '', variation: c.variation && !/^base$/i.test(c.variation) ? c.variation : '',
      serial: c.serial && c.serial !== '-' ? c.serial : '', grade: cleanGrade(c.grade, c.grader), cert: c.cert_number || null,
      team: c.team || '', tags, seg: segKey(c), price, list, nfs, sold, photos: pickPhotos(c.photos), comps: comps[c.id] || undefined,
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
      const s = (u.searchParams.get('s') || '').replace(/[^a-z0-9-]/gi, '');
      if (!s) return j({ error: 'missing link' }, 400);
      return await publicView(s);
    }
    if (req.headers.get('x-ingest-secret') !== SECRET) return j({ error: 'unauthorized' }, 401);
    const b = await req.json();
    const db = supa();
    const op = b.op;
    const fields = ['title', 'intro', 'scope_type', 'lot_id', 'segment', 'card_ids', 'price_mode', 'markup_pct', 'show_comps', 'terms', 'contact', 'active', 'recipient', 'discount_pct', 'discount_ends_at', 'allow_offers'];
    const pick = (o: any) => { const r: any = {}; for (const k of fields) if (o[k] !== undefined) r[k] = o[k]; return r; };
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
