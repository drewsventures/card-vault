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
const BULK = new Set(['sketch_comps', 'sketch_artists', 'sketch_characters', 'sketch_cards', 'sketch_valuations', 'sketch_model_params', 'card_market_items']);
const CARD_FIELDS = new Set(['current_value', 'value_source', 'value_date', 'value_basis', 'value_comp_n', 'value_median', 'value_recent', 'value_recent_date', 'needs_review', 'artist']);
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------- sketch model v3 (port of model.py) ----------------
const PRODMAP: [string, string][] = [['masterwork','masterwork'],['chrome galaxy','chrome_galaxy'],['chrome_galaxy','chrome_galaxy'],['galaxy','galaxy'],['hyperspace','hyperspace'],['galactic','galactic'],['finest','finest'],['chrome','chrome'],['evolution','evolution'],['30th','esb30'],['esb30','esb30'],['black & white','esb_bw'],['esb_bw','esb_bw'],['rise of','ros'],['ros','ros'],['force awakens','tfa'],['tfa','tfa']];
function prodkey(p: string | null) { const s = (p || 'unknown').toLowerCase(); for (const [k, v] of PRODMAP) if (s.includes(k)) return v; return s || 'unknown'; }
async function runModel(supa: any, sc: any) {
  const { data: prm } = await supa.from('sketch_model_params').select('key,value');
  const P: Record<string, number> = {}; (prm || []).forEach((r: any) => P[r.key] = Number(r.value));
  let comps: any[] = []; let from = 0;
  while (true) {
    const { data } = await supa.from('sketch_comps').select('id,sold_price,sold_date,artist_id,character_id,product,parallel,format,same_card_id,is_own_purchase').eq('exclude', false).range(from, from + 999);
    if (!data || !data.length) break; comps = comps.concat(data); if (data.length < 1000) break; from += 1000;
  }
  comps = comps.filter((c) => c.sold_price && Number(c.sold_price) > 0 && !['nonsw', 'sketchagraph'].includes(c.product));
  const same = comps.filter((c) => sc.card_id && c.same_card_id === sc.card_id); comps = comps.filter((c) => !(sc.card_id && c.same_card_id === sc.card_id));
  const today = new Date();
  const pidx = (p: string) => P['idx_prod_' + p] ?? (p !== 'unknown' ? 1.0 : (P['idx_prod_unknown'] ?? 0.908));
  const idx = (k: string, v: string) => P[`idx_${k}_${v}`] ?? 1.0;
  const ageW = (d: string) => { const t = Date.parse(String(d).slice(0, 10)); if (isNaN(t)) return 0.5; const a = (today.getTime() - t) / 86400000; if (a > (P['lookback_days'] ?? 730)) return 0; return Math.pow(0.5, a / (P['recency_half_life_days'] ?? 365)); };
  // oversized sketches (5x7 etc.) trade in their own market: Drew wants them comped only against other oversized sketches.
  // artist/character indexes still come from the standard-size market so a Grogu oversized sale is scaled down for an Ewok.
  const baseC = comps.filter((c) => c.format !== 'oversized');
  const prices = baseC.map((c) => Number(c.sold_price)).sort((a, b) => a - b); const MKT = prices[Math.floor(prices.length / 2)];
  const fit = (key: string) => { const g: Record<string, number[]> = {}; baseC.forEach((c) => { if (c[key]) (g[c[key]] = g[c[key]] || []).push(Number(c.sold_price) / (pidx(prodkey(c.product)) * idx('par', c.parallel || 'base') * idx('fmt', c.format || 'standard'))); });
    const k = P['index_shrink_k'] ?? 5; const out: Record<string, number> = {}; for (const [a, v] of Object.entries(g)) { v.sort((x, y) => x - y); const n = v.length; const med = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; out[a] = (n * (med / MKT) + k) / (n + k); } return out; };
  const AI = fit('artist_id'), CI = fit('character_id');
  const cm = (prod: string, par: string, fmt: string, art: string, ch: string, ua: boolean, uc: boolean) => { let m = pidx(prod) * idx('par', par || 'base') * idx('fmt', fmt || 'standard'); if (ua) m *= AI[art] ?? 1; if (uc) m *= CI[ch] ?? 1; return m; };
  const wmed = (L: [number, number][], q = 0.5) => { L.sort((a, b) => a[0] - b[0]); const t = L.reduce((s, x) => s + x[1], 0); let acc = 0; for (const [v, w] of L) { acc += w; if (acc >= t * q) return v; } return L.length ? L[L.length - 1][0] : 0; };
  const QT: Record<string, number> = { A: 0.65, B: 0.5, C: 0.4 };
  const W: Record<string, number> = { T1: P['w_T1'] ?? 1, T2: P['w_T2'] ?? 0.6, T3: P['w_T3'] ?? 0.35, T4: P['w_T4'] ?? 0.3, T5: P['w_T5'] ?? 0.15 };
  const prod = prodkey(sc.product); const par = sc.parallel || 'base'; let fmt = sc.format || 'standard'; if (!['standard', 'panoramic', 'die_cut', 'booklet', 'oversized'].includes(fmt)) fmt = 'standard';
  const OV = fmt === 'oversized';
  const art = sc.artist_id, ch = sc.character_id;
  const pools: Record<string, [number, number, any][]> = { T1: [], T2: [], T3: [], T4: [], T5: [] };
  for (const c of comps) {
    if (OV !== (c.format === 'oversized')) continue;
    const cp = prodkey(c.product), cpar = c.parallel || 'base', cf = c.format || 'standard';
    const sa = art && c.artist_id === art, sch = ch && c.character_id === ch; const same = cpar === par && cf === fmt;
    const t = sa && sch ? (same ? 'T1' : 'T2') : sa ? 'T3' : sch ? 'T4' : 'T5';
    const ua = t === 'T4' || t === 'T5', uc = t === 'T3' || t === 'T5';
    if (par !== cpar && (P['idx_par_' + par] === undefined || P['idx_par_' + cpar] === undefined)) continue;
    const adj = Number(c.sold_price) * cm(prod, par, fmt, art, ch, ua, uc) / cm(cp, cpar, cf, c.artist_id, c.character_id, ua, uc);
    const w = ageW(c.sold_date); if (w > 0) pools[t].push([adj, w, c]);
  }
  const t5 = pools.T5.filter((x) => (OV || prodkey(x[2].product) === prod) && (x[2].parallel || 'base') === par); if (t5.length) pools.T5 = t5;
  const est: Record<string, number> = {}, wts: Record<string, number> = {};
  for (const t of Object.keys(pools)) { const L = pools[t]; if (!L.length) continue; est[t] = wmed(L.map((x) => [x[0], x[1]] as [number, number]), (t === 'T4' || t === 'T5') ? (QT[sc.quality_band || 'B'] ?? 0.5) : 0.5); wts[t] = W[t] * L.length / (L.length + (P['cred_k'] ?? 2)); }
  const tot = Object.values(wts).reduce((a, b) => a + b, 0); if (!tot) return null;
  let val = Object.keys(est).reduce((s, t) => s + wts[t] * est[t], 0) / tot;
  const t1r = pools.T1.filter((x) => ageW(x[2].sold_date) >= 0.5);
  if (t1r.length >= (P['t1_min_n'] ?? 2)) { const ow = Object.keys(est).filter((t) => t !== 'T1').reduce((s, t) => s + wts[t], 0); const oth = ow ? Object.keys(est).filter((t) => t !== 'T1').reduce((s, t) => s + wts[t] * est[t], 0) / ow : est.T1; const share = Math.max(t1r.length === 1 ? (P['t1_share_1'] ?? P['t1_min_share'] ?? 0.7) : (P['t1_min_share'] ?? 0.7), wts.T1 / tot); val = share * est.T1 + (1 - share) * oth; }
  // this exact 1/1 sold before: anchor on that sale (Drew: the card's own sale is the best comp there is)
  const sameR = same.filter((c) => ageW(c.sold_date) > 0).sort((a, b) => String(b.sold_date).localeCompare(String(a.sold_date)));
  const modelOnly = val; let sameNote = '';
  const own = sameR.find((c) => c.is_own_purchase);
  if (own) {
    // Drew's rule: if his purchase is one of the most recent close sales, value = that price + 25%; if several close comps sold since, use the recent comps
    const ownT = Date.parse(String(own.sold_date).slice(0, 10)) + 3 * 86400000;
    const since = comps.filter((c) => ch && c.character_id === ch && (c.parallel || 'base') === par && (c.format || 'standard') === fmt && Date.parse(String(c.sold_date).slice(0, 10)) > ownT).length;
    if (since < (P['own_recent_min'] ?? 3)) { const op = Number(own.sold_price) * (P['own_purchase_premium'] ?? 1.25); val = Math.max(op, modelOnly); sameNote = `your purchase of this card ($${Math.round(Number(own.sold_price))} on ${String(own.sold_date).slice(0, 10)}) is the most recent close sale (${since} same-character${par !== 'base' ? ' ' + par.replace('_', ' ') : ''} sales since): value = that price + 25% = $${Math.round(op)}${op < modelOnly ? `, below the comps ($${Math.round(modelOnly)}), so the comps win` : ''}`; }
    else { val = modelOnly; sameNote = `${since} close sales since your purchase ($${Math.round(Number(own.sold_price))} on ${String(own.sold_date).slice(0, 10)}), so valued on the recent comps`; }
  } else if (sameR.length) { const sw = P['same_card_weight'] ?? 0.75; val = sw * Number(sameR[0].sold_price) + (1 - sw) * val; sameNote = `this exact card sold $${Math.round(Number(sameR[0].sold_price))} on ${String(sameR[0].sold_date).slice(0, 10)}: value = ${Math.round(sw * 100)}% that sale + ${Math.round((1 - sw) * 100)}% the model from other comps ($${Math.round(modelOnly)})`; }
  const n: Record<string, number> = {}; for (const t of Object.keys(W)) n[t] = pools[t].length;
  const conf = (n.T1 >= 2 || n.T2 >= 3) ? 'high' : (n.T2 >= 1 || (n.T3 >= 3 && n.T4 >= 3) || n.T3 >= 8 || n.T4 >= 8 || n.T1 === 1) ? 'medium' : (n.T3 >= 1 || n.T4 >= 1) ? 'low' : 'none';
  const order = ['T1', 'T2', 'T4', 'T3', 'T5']; const show: [string, number, any][] = [];
  for (const c of sameR.slice(0, 3)) show.push(['SC', Number(c.sold_price), c]);
  const CAP: Record<string, number> = { T1: 6, T2: 3, T4: 5, T3: 4, T5: 2 }; for (const t of order) { const L = [...pools[t]].sort((a, b) => String(b[2].sold_date).localeCompare(String(a[2].sold_date))); for (const x of L.slice(0, CAP[t])) show.push([t, x[0], x[2]]); }
  const mx = Math.max(...Object.values(wts)); const used = Object.keys(est).filter((t) => wts[t] >= 0.05 * mx).flatMap((t) => pools[t].map((x) => x[0])).sort((a, b) => a - b);
  const pct = (q: number) => { if (!used.length) return null; const i = (used.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return used[lo] + (used[hi] - used[lo]) * (i - lo); };
  const best = sameR.length ? 'SC' : order.find((t) => pools[t].length); const rec = sameR.length ? [Number(sameR[0].sold_price), 1, sameR[0]] as [number, number, any] : best ? pools[best].reduce((a, b) => String(a[2].sold_date) > String(b[2].sold_date) ? a : b) : null;
  const comp_tiers: Record<string, [string, number]> = {}; show.forEach(([t, a, c]) => comp_tiers[c.id] = [t, Math.round(a * 100) / 100]);
  return { model_value: Math.round(val), low: pct(0.25) !== null ? Math.min(Math.round(pct(0.25)!), Math.round(val)) : null, high: pct(0.75) !== null ? Math.max(Math.round(pct(0.75)!), Math.round(val)) : null, confidence: conf,
    pools: { ...Object.fromEntries(order.map((t) => [t, { n: n[t], median: est[t] !== undefined ? Math.round(est[t] * 100) / 100 : null, weight: Math.round((wts[t] || 0) * 1000) / 1000 }])), comp_tiers, recent_tier: best },
    comp_ids: show.map((x) => x[2].id), recent_price: rec ? Number(rec[2].sold_price) : null, recent_date: rec ? String(rec[2].sold_date).slice(0, 10) : null,
    explanation: (OV ? 'Oversized sketches only. ' : '') + order.filter((t) => est[t] !== undefined).map((t) => `${t}: ${n[t]} sales, median $${Math.round(est[t])}, weight ${wts[t].toFixed(2)}`).join('; ') + (sameNote ? '; ' + sameNote : '') };
}

// ---------------- sketchagraph model (sketch + autograph) ----------------
// Drew's rules: comp only against other sketchagraphs; a sketchagraph is worth at least the same card as a plain sketch.
async function runSketchagraph(supa: any, sc: any) {
  const { data: comps } = await supa.from('sketch_comps').select('id,title,sold_price,sold_date,product').eq('product', 'sketchagraph').eq('exclude', false);
  const today = new Date();
  const age = (d: string) => (today.getTime() - Date.parse(String(d).slice(0, 10))) / 86400000;
  const rw = (d: string) => { const a = age(d); if (isNaN(a)) return 0.3; return a > 730 ? 0 : Math.pow(0.5, a / 365); };
  const last = (x: string | null) => { const p = (x || '').trim().split(/\s+/); return p.length ? p[p.length - 1] : ''; };
  const rx = (w: string) => w && w.length > 2 ? new RegExp('\\b' + w.replace(/[^a-z0-9]/gi, '') + '\\b', 'i') : null;
  const sR = rx(last(sc.signer)), aR = rx(last(sc.artist_raw)), cR = rx(last(sc.character_raw));
  const setKey = (sc.product || '').toLowerCase().includes('illustrated') ? /illustrated/i : null;
  const P: Record<string, [number, number, any][]> = { G2: [], G1: [], G3: [], G4: [] };
  for (const c of comps || []) {
    const t = c.title || ''; const w = rw(c.sold_date); if (!w) continue; const p = Number(c.sold_price); if (!(p > 0)) continue;
    const sig = sR && sR.test(t), art = aR && aR.test(t), ch = cR && cR.test(t);
    const tier = sig && art ? 'G2' : sig && ch ? 'G1' : sig ? 'G3' : (setKey && setKey.test(t)) ? 'G4' : null;
    if (tier) P[tier].push([p, w, c]);
  }
  const W: Record<string, number> = { G2: 1.0, G1: 0.6, G3: 0.5, G4: 0.15 };
  const wmed = (L: [number, number, any][]) => { const S = [...L].sort((a, b) => a[0] - b[0]); const tot = S.reduce((a, x) => a + x[1], 0); let acc = 0; for (const x of S) { acc += x[1]; if (acc >= tot / 2) return x[0]; } return 0; };
  const est: Record<string, number> = {}, wt: Record<string, number> = {};
  for (const t of Object.keys(P)) if (P[t].length) { est[t] = wmed(P[t]); wt[t] = W[t] * P[t].length / (P[t].length + 2); }
  const tot = Object.values(wt).reduce((a, b) => a + b, 0); if (!tot) return null;
  let val = Object.keys(est).reduce((a, t) => a + wt[t] * est[t], 0) / tot; const notes: string[] = [];
  if (est.G2 && est.G2 > val) { val = est.G2; notes.push(`held at the same signer + same artist sale ($${Math.round(est.G2)})`); }
  const plain = await runModel(supa, { ...sc, format: 'standard' });
  if (plain && plain.model_value > val) { val = plain.model_value; notes.push(`floored at the plain-sketch value ($${plain.model_value}): a sketchagraph is worth at least the sketch alone`); }
  const order = ['G2', 'G1', 'G3', 'G4']; const CAP: Record<string, number> = { G2: 6, G1: 6, G3: 5, G4: 3 };
  const show: [string, number, any][] = []; for (const t of order) for (const x of [...P[t]].sort((a, b) => String(b[2].sold_date).localeCompare(String(a[2].sold_date))).slice(0, CAP[t])) show.push([t, x[0], x[2]]);
  const used = order.filter((t) => t !== 'G4' || !(est.G2 || est.G1 || est.G3)).flatMap((t) => P[t].map((x) => x[0])).sort((a, b) => a - b);
  const q = (f: number) => used.length ? used[Math.min(used.length - 1, Math.round(f * (used.length - 1)))] : null;
  const best = order.find((t) => P[t].length && t !== 'G4') || order.find((t) => P[t].length);
  const rec = best ? P[best].reduce((a, b) => String(a[2].sold_date) > String(b[2].sold_date) ? a : b) : null;
  const n = (t: string) => P[t].length;
  const conf = n('G2') >= 2 || n('G1') + n('G2') >= 3 ? 'high' : n('G2') + n('G1') + n('G3') >= 2 ? 'medium' : n('G2') + n('G1') + n('G3') === 1 ? 'low' : 'none';
  const lab: Record<string, string> = { G2: 'same signer + same artist', G1: 'same signer + character, other artist', G3: 'same signer, other artist', G4: 'same set, other signer' };
  const comp_tiers: Record<string, [string, number]> = {}; show.forEach(([t, p, c]) => comp_tiers[c.id] = [t, p]);
  return { model_value: Math.round(val), low: q(0.25) != null ? Math.min(q(0.25)!, Math.round(val)) : null, high: Math.max(q(0.75) || 0, Math.round(val)), confidence: conf,
    pools: { ...Object.fromEntries(order.map((t) => [t, { n: n(t), median: est[t] ?? null, weight: Math.round((wt[t] || 0) * 1000) / 1000 }])), comp_tiers, recent_tier: best, plain_sketch_value: plain?.model_value ?? null },
    comp_ids: show.map((x) => x[2].id), recent_price: rec ? Number(rec[0]) : null, recent_date: rec ? String(rec[2].sold_date).slice(0, 10) : null,
    explanation: 'Sketchagraph comps (2 yr): ' + order.filter((t) => est[t] !== undefined).map((t) => `${lab[t]}: ${n(t)} sales, median $${Math.round(est[t])}`).join('; ') + (notes.length ? '; ' + notes.join('; ') : '') };
}

// ---------------- non-Star Wars sketches (sports / entertainment): same character-first order, on stored nonsw comps ----------------
async function runNonSW(supa: any, sc: any) {
  const { data: prm } = await supa.from('sketch_model_params').select('key,value');
  const P: Record<string, number> = {}; (prm || []).forEach((r: any) => P[r.key] = Number(r.value));
  let comps: any[] = []; let from = 0;
  while (true) {
    const { data } = await supa.from('sketch_comps').select('id,title,sold_price,sold_date,artist_id,character_id,same_card_id,is_own_purchase').eq('exclude', false).eq('product', 'nonsw').range(from, from + 999);
    if (!data || !data.length) break; comps = comps.concat(data); if (data.length < 1000) break; from += 1000;
  }
  const today = new Date();
  const ageW = (d: string) => { const t = Date.parse(String(d).slice(0, 10)); if (isNaN(t)) return 0.5; const a = (today.getTime() - t) / 86400000; if (a > 730) return 0; return Math.pow(0.5, a / 365); };
  const lastw = (x: string | null) => { const p = (x || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').trim().split(/\s+/).filter((w) => w.length > 2 && !['the', 'and', 'sketch', 'card'].includes(w)); return p.length ? p[p.length - 1] : ''; };
  const aw = lastw(sc.artist_raw);
  const aR = aw && aw.length >= 4 ? new RegExp('\\b' + aw.replace(/[^a-z0-9']/g, '') + '\\b', 'i') : null;
  let cNames: string[] = [norm(String(sc.character_raw || '').replace(/\b(sr|jr)\.?$/i, ''))].filter((x) => x.length >= 4);
  if (sc.character_id) { const { data: crow } = await supa.from('sketch_characters').select('name,aliases').eq('id', sc.character_id).single(); if (crow) cNames = cNames.concat([crow.name, ...(crow.aliases || [])].map((x: string) => norm(x)).filter((x: string) => x.length >= 4)); }
  const cHit = (t: string) => { const tt = ' ' + norm(t) + ' '; return cNames.some((k) => tt.includes(' ' + k + ' ')); };
  const same = comps.filter((c) => c.same_card_id === sc.card_id && ageW(c.sold_date) > 0).sort((a, b) => String(b.sold_date).localeCompare(String(a.sold_date)));
  const pools: Record<string, [number, number, any][]> = { T1: [], T4: [], T3: [] };
  for (const c of comps) {
    if (c.same_card_id === sc.card_id) continue; const w = ageW(c.sold_date); if (!w) continue; const p = Number(c.sold_price); if (!(p >= 10)) continue;
    const t = c.title || '';
    if (!/sketch|1\/1|one of one|original art/i.test(t) || /\b\d{1,2} ?x ?\d{1,2}\b|\bcgc\b|\bcbcs\b|comic|cover|funko|poster|print\b|psc|personal sketch/i.test(t)) continue;
    const sch = (sc.character_id && c.character_id === sc.character_id) || cHit(t);
    const sa = (sc.artist_id && c.artist_id === sc.artist_id) || (aR && aR.test(t));
    const tier = sch && sa ? 'T1' : sch ? 'T4' : sa ? 'T3' : null; if (tier) pools[tier].push([p, w, c]);
  }
  const QT: Record<string, number> = { A: 0.65, B: 0.5, C: 0.4 };
  const wq = (L: [number, number, any][], q: number) => { const S = [...L].sort((a, b) => a[0] - b[0]); const tot = S.reduce((a, x) => a + x[1], 0); let acc = 0; for (const x of S) { acc += x[1]; if (acc >= tot * q) return x[0]; } return S.length ? S[S.length - 1][0] : 0; };
  const W: Record<string, number> = { T1: 1.0, T4: P['w_T4'] ?? 0.5, T3: P['w_T3'] ?? 0.3 };
  const est: Record<string, number> = {}, wt: Record<string, number> = {};
  for (const t of Object.keys(pools)) if (pools[t].length) { est[t] = wq(pools[t], t === 'T4' ? (QT[sc.quality_band || 'B'] ?? 0.5) : 0.5); wt[t] = W[t] * pools[t].length / (pools[t].length + 2); }
  const tot = Object.values(wt).reduce((a, b) => a + b, 0);
  if (!tot && !same.length) return null;
  let val = tot ? Object.keys(est).reduce((a, t) => a + wt[t] * est[t], 0) / tot : Number(same[0].sold_price);
  const t1r = pools.T1.filter((x) => x[1] >= 0.5);
  if (t1r.length >= (P['t1_min_n'] ?? 2) && tot) { const ow = Object.keys(est).filter((t) => t !== 'T1').reduce((s, t) => s + wt[t], 0); const oth = ow ? Object.keys(est).filter((t) => t !== 'T1').reduce((s, t) => s + wt[t] * est[t], 0) / ow : est.T1; const share = Math.max(t1r.length === 1 ? (P['t1_share_1'] ?? 0.7) : (P['t1_min_share'] ?? 0.7), wt.T1 / tot); val = share * est.T1 + (1 - share) * oth; }
  const modelOnly = val; let note = '';
  const own = same.find((c) => c.is_own_purchase);
  if (own) { const ownT = Date.parse(String(own.sold_date).slice(0, 10)) + 3 * 86400000; const since = pools.T1.concat(pools.T4).filter((x) => Date.parse(String(x[2].sold_date).slice(0, 10)) > ownT).length;
    if (since < (P['own_recent_min'] ?? 3)) { const op = Number(own.sold_price) * (P['own_purchase_premium'] ?? 1.25); val = Math.max(op, modelOnly); note = `your purchase ($${Math.round(Number(own.sold_price))}, ${String(own.sold_date).slice(0, 10)}) is the most recent close sale: value = that + 25%`; } else note = `${since} close sales since your purchase, valued on recent comps`; }
  else if (same.length) { const sw = P['same_card_weight'] ?? 0.75; val = sw * Number(same[0].sold_price) + (1 - sw) * val; note = `this exact card sold $${Math.round(Number(same[0].sold_price))}: 75% that sale + 25% other comps`; }
  const n = (t: string) => pools[t].length;
  const conf = n('T1') >= 2 ? 'high' : (n('T1') === 1 || n('T4') >= 5) ? 'medium' : (n('T4') + n('T3')) >= 1 ? 'low' : 'none';
  const show: [string, number, any][] = []; for (const c of same.slice(0, 2)) show.push(['SC', Number(c.sold_price), c]);
  const CAP: Record<string, number> = { T1: 6, T4: 6, T3: 5 }; for (const t of ['T1', 'T4', 'T3']) for (const x of [...pools[t]].sort((a, b) => String(b[2].sold_date).localeCompare(String(a[2].sold_date))).slice(0, CAP[t])) show.push([t, x[0], x[2]]);
  const used = ['T1', 'T4', 'T3'].flatMap((t) => pools[t].map((x) => x[0])).sort((a, b) => a - b);
  const q = (f: number) => used.length ? used[Math.min(used.length - 1, Math.round(f * (used.length - 1)))] : null;
  const best = same.length ? 'SC' : ['T1', 'T4', 'T3'].find((t) => pools[t].length);
  const rec = same.length ? same[0] : best ? pools[best].reduce((a, b) => String(a[2].sold_date) > String(b[2].sold_date) ? a : b)[2] : null;
  const lab: Record<string, string> = { T1: 'same artist + same subject', T4: 'same subject, other artists', T3: 'same artist, other subjects' };
  const comp_tiers: Record<string, [string, number]> = {}; show.forEach(([t, p, c]) => comp_tiers[c.id] = [t, p]);
  return { model_value: Math.round(val), low: q(0.25) != null ? Math.min(q(0.25)!, Math.round(val)) : null, high: Math.max(q(0.75) || 0, Math.round(val)), confidence: conf,
    pools: { ...Object.fromEntries(['T1', 'T4', 'T3'].map((t) => [t, { n: n(t), median: est[t] ?? null, weight: Math.round((wt[t] || 0) * 1000) / 1000 }])), comp_tiers, recent_tier: best },
    comp_ids: show.map((x) => x[2].id), recent_price: rec ? Number(rec.sold_price) : null, recent_date: rec ? String(rec.sold_date).slice(0, 10) : null,
    explanation: ['T1', 'T4', 'T3'].filter((t) => est[t] !== undefined).map((t) => `${lab[t]}: ${n(t)} sales, median $${Math.round(est[t])}`).join('; ') + (note ? '; ' + note : '') };
}
async function valueCard(supa: any, s2: any) {
  if (s2.ensemble) return null;
  if (s2.subject_category) return await runNonSW(supa, s2);
  return s2.format === 'sketchagraph' ? await runSketchagraph(supa, s2) : await runModel(supa, s2);
}
const JUNK = /(reproduction|repro\b|reprint|\bprint\b|poster|sketch variation|\blot\b|\bbox\b|\bcase\b|break|digital|card ?fun|custom|aceo|fan art|\binches\b|sticker|stellar|\bpsc\b|personal sketch|\/\s?(5|10|15|25|50|75|99|100)\b|cgc|cbcs|funko|figure|comic book|cover)/i;
async function ingestHits(supa: any, sc: any, hits: any[]) {
  const nonsw = !!sc.subject_category;
  const [{ data: chars }, { data: arts }] = await Promise.all([supa.from('sketch_characters').select('id,name,aliases'), supa.from('sketch_artists').select('id,name,aliases')]);
  const match = (t: string, rows: any[], minlen: number) => { const tt = ' ' + norm(t) + ' '; let best: [string, number] | null = null; for (const r of rows || []) for (const nm of [r.name, ...(r.aliases || [])]) { const k = norm(nm); if (k.length >= minlen && tt.includes(' ' + k + ' ') && (!best || k.length > best[1])) best = [r.id, k.length]; } return best ? best[0] : null; };
  const PROD: [string, string][] = [['chrome galaxy', 'chrome_galaxy'], ['masterwork', 'masterwork'], ['galaxy', 'galaxy'], ['hyperspace', 'hyperspace'], ['galactic', 'galactic'], ['finest', 'finest'], ['chrome', 'chrome'], ['evolution', 'evolution'], ['illustrated', 'illustrated'], ['30th anniversary', 'esb30'], ['3d widevision', 'esb30'], ['black & white', 'esb_bw'], ['black and white', 'esb_bw']];
  const prod = (t: string) => { if (nonsw) return 'nonsw'; if (/sketch ?a ?graph/i.test(t)) return 'sketchagraph'; const tl = t.toLowerCase(); for (const [k, v] of PROD) if (tl.includes(k)) return v; return 'unknown'; };
  const par = (t: string) => { const tl = t.toLowerCase(); for (const [k, v] of [['gold foil', 'gold_foil'], ['silver foil', 'silver_foil'], ['black foil', 'black_foil'], ['red foil', 'red_foil'], ['blue foil', 'blue_foil'], [' wood', 'wood'], ['acetate', 'acetate'], ['metal', 'metal']]) if (tl.includes(k)) return v; return 'base'; };
  const fmt = (t: string) => /oversize|over-size|\b5 ?x ?7\b/i.test(t) && !/carded/i.test(t) ? 'oversized' : /panoramic|widevision|pano\b/i.test(t) ? 'panoramic' : /booklet/i.test(t) ? 'booklet' : 'standard';
  const urls = hits.map((h) => h.url).filter(Boolean);
  const existing = new Set<string>();
  for (let i = 0; i < urls.length; i += 100) { const { data } = await supa.from('sketch_comps').select('url').in('url', urls.slice(i, i + 100)); (data || []).forEach((r: any) => existing.add(r.url)); }
  const rows: any[] = []; const seen = new Set<string>();
  for (const h of hits) {
    const t = String(h.title || '').replace(/Opens in a new window or tab|Opens in a new window|New Listing/gi, '').trim(); const p = Number(h.price); if (!(p >= 10) || !h.date) continue;
    if (!/sketch|original art|hand ?drawn/i.test(t) || JUNK.test(t)) continue;
    if (h.url && existing.has(h.url)) continue;
    const k = norm(t).slice(0, 50) + '|' + Math.round(p) + '|' + h.date; if (seen.has(k)) continue; seen.add(k); if (h.url) existing.add(h.url);
    rows.push({ source: h.url && /ebay/.test(h.url) ? 'ebay' : 'other', url: h.url || null, title: t.slice(0, 300), sold_price: p, sold_date: h.date, image_url: h.img || null,
      character_id: match(t, chars, 4), artist_id: match(t, arts, 5), product: prod(t), parallel: par(t), format: fmt(t), is_graded: /\b(psa|bgs|cgc|sgc)\b/i.test(t), notes: JSON.stringify({ h: 'runner', card: sc.card_id }) });
  }
  let added = 0;
  const withUrl = rows.filter((r) => r.url), noUrl = rows.filter((r) => !r.url);
  if (withUrl.length) { const { data, error } = await supa.from('sketch_comps').upsert(withUrl, { onConflict: 'url', ignoreDuplicates: true }).select('id'); if (error) throw new Error(error.message); added += (data || []).length; }
  if (noUrl.length) { const { error } = await supa.from('sketch_comps').insert(noUrl); if (error) throw new Error(error.message); added += noUrl.length; }
  return added;
}
async function saveValuation(supa: any, card_id: string, v: any, mv: string, today: string, apply: boolean, reviewNote: string | null) {
  const { data: card } = await supa.from('cards').select('current_value').eq('id', card_id).single();
  const { data: ins } = await supa.from('sketch_valuations').insert({ card_id, model_version: mv, model_value: v.model_value, low: v.low, high: v.high, confidence: v.confidence, pools: v.pools, explanation: v.explanation, comp_ids: v.comp_ids, recent_price: v.recent_price, recent_date: v.recent_date, prior_value: num(card?.current_value) }).select('id').single();
  if (apply) {
    await supa.from('cards').update({ current_value: v.model_value, value_source: 'sketch-model', value_date: today, needs_review: true, value_recent: v.recent_price, value_recent_date: v.recent_date }).eq('id', card_id);
    if (reviewNote) await supa.from('value_reviews').insert({ card_id, action: 'reset', model_value: v.model_value, prior_value: num(card?.current_value), final_value: v.model_value, valuation_id: ins?.id || null, note: reviewNote });
  }
  return ins?.id;
}
async function findOrCreate(supa: any, table: string, name: string) {
  if (!name || !name.trim()) return null;
  const { data } = await supa.from(table).select('id,name,aliases');
  const k = norm(name);
  const hit = (data || []).find((r: any) => norm(r.name) === k || (r.aliases || []).some((a: string) => norm(a) === k));
  if (hit) return hit.id;
  const { data: ins, error } = await supa.from(table).insert({ name: name.trim(), aliases: [] }).select('id').single();
  if (error) throw new Error(error.message); return ins.id;
}
function acceptNotes(notes: string | null, extra: string | null) {
  const d = new Date().toISOString().slice(0, 10);
  let n = (notes || '').replace('Sep 22 photo review:', `Sep 22 photo review (resolved by Drew ${d}):`);
  if (extra) n = (n ? n + ' || ' : '') + `Drew ${d}: ${extra}`;
  return n || null;
}
async function composePlayer(supa: any, card_id: string) {
  const { data: s } = await supa.from('sketch_cards').select('character_raw,artist_raw,is_artist_proof,format,signer,parallel').eq('card_id', card_id).single();
  if (!s) return null;
  const who = s.character_raw || 'Sketch'; const art = s.artist_raw && !/illegible|tbd|unreadable|scrawl/i.test(s.artist_raw) ? ' / ' + s.artist_raw : '';
  const PAR: Record<string, string> = { wood: 'Wood', gold_foil: 'Gold Foil', silver_foil: 'Silver Foil', black_foil: 'Black Foil', red_foil: 'Red Foil', blue_foil: 'Blue Foil', acetate: 'Acetate', metal: 'Metal' };
  const pl = (s.parallel && PAR[s.parallel] ? ' ' + PAR[s.parallel] : '') + (s.format === 'oversized' ? ' Oversized' : '');
  if (s.format === 'sketchagraph') return `${who} Sketchagraph${art}${s.signer ? ', auto ' + s.signer : ''} (1/1)${pl}${s.is_artist_proof ? ' AP' : ''}`;
  return `${who}${art} (1/1)${pl}${s.is_artist_proof ? ' AP' : ''}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!(await vaultAuthorized(req))) return j({ error: 'locked' }, 401);
    const b = await req.json();
    const op = b.op;
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const today = new Date().toISOString().slice(0, 10);

    if (op === 'upsert') {
      if (!BULK.has(b.table)) return j({ error: 'table not allowed' }, 400);
      const { error } = await supa.from(b.table).upsert(b.rows || [], b.onConflict ? { onConflict: b.onConflict } : undefined);
      return error ? j({ error: error.message }, 500) : j({ ok: true, n: (b.rows || []).length });
    }
    if (op === 'insert') {
      if (!BULK.has(b.table)) return j({ error: 'table not allowed' }, 400);
      const { data, error } = await supa.from(b.table).insert(b.rows || []).select(b.returning || 'id');
      return error ? j({ error: error.message }, 500) : j({ ok: true, data });
    }
    if (op === 'patch_many') {
      if (!BULK.has(b.table) && b.table !== 'cards') return j({ error: 'table not allowed' }, 400);
      const key = b.key || 'id'; let n = 0; const errs: string[] = [];
      for (const r of (b.rows || [])) {
        let patch = r.patch || {};
        if (b.table === 'cards') { const p: Record<string, unknown> = {}; for (const k of Object.keys(patch)) if (CARD_FIELDS.has(k)) p[k] = patch[k]; patch = p; }
        if (!Object.keys(patch).length) continue;
        const { error } = await supa.from(b.table).update(patch).eq(key, r.key_value);
        if (error) errs.push(String(r.key_value) + ': ' + error.message); else n++;
      }
      return j({ ok: errs.length === 0, n, errs: errs.slice(0, 20) });
    }
    if (op === 'market_replace') {
      // replace a card's comps from the given sources
      await supa.from('card_market_items').delete().eq('card_id', b.card_id).in('source', b.sources || ['ebay', 'cardladder']);
      const rows = (b.rows || []).map((r: any) => ({ ...r, card_id: b.card_id }));
      const { error } = rows.length ? await supa.from('card_market_items').insert(rows) : { error: null };
      return error ? j({ error: error.message }, 500) : j({ ok: true, n: rows.length });
    }

    // ---------- review queue (UI) ----------
    if (op === 'review_confirm' || op === 'review_override' || op === 'review_reset') {
      const { data: card, error: ce } = await supa.from('cards').select('id,current_value,value_source').eq('id', b.card_id).single();
      if (ce || !card) return j({ error: ce?.message || 'card not found' }, 404);
      const { data: vals } = await supa.from('sketch_valuations').select('id,model_value').eq('card_id', b.card_id).order('run_at', { ascending: false }).limit(1);
      const v = vals && vals[0];
      let final: number | null = null; let src = ''; let action = '';
      if (op === 'review_confirm') { final = num(b.value) ?? num(v?.model_value) ?? num(card.current_value); src = b.source_label || 'sketch-confirmed'; action = 'confirm'; }
      if (op === 'review_override') { final = num(b.value); if (final === null) return j({ error: 'value required' }, 400); src = 'owner-estimate'; action = 'override'; }
      if (op === 'review_reset') {
        action = 'reset';
        if (v && num(v.model_value) !== null) { final = num(v.model_value); src = 'sketch-model'; }
        else { const { data: prev } = await supa.from('value_reviews').select('prior_value').eq('card_id', b.card_id).neq('action', 'reset').order('reviewed_at', { ascending: false }).limit(1); final = num(prev?.[0]?.prior_value) ?? num(card.current_value); src = card.value_source; }
      }
      const { error: ue } = await supa.from('cards').update({ current_value: final, value_source: src, value_date: today, needs_review: action === 'reset' }).eq('id', b.card_id);
      if (ue) return j({ error: ue.message }, 500);
      const { error: re } = await supa.from('value_reviews').insert({ card_id: b.card_id, action, model_value: num(v?.model_value), prior_value: num(card.current_value), final_value: final, valuation_id: v?.id || null, note: b.note || null });
      if (re) return j({ error: re.message }, 500);
      return j({ ok: true, final_value: final, value_source: src });
    }

    // accept the photo-review correction as-is
    if (op === 'sketch_accept') {
      const { data: s } = await supa.from('sketch_cards').select('notes').eq('card_id', b.card_id).single();
      await supa.from('sketch_cards').update({ notes: acceptNotes(s?.notes, b.note || null), artist_confidence: 'confirmed' }).eq('card_id', b.card_id);
      const player = await composePlayer(supa, b.card_id);
      if (player) await supa.from('cards').update({ player }).eq('id', b.card_id);
      return j({ ok: true, player });
    }

    // change what the card is (character / artist / set / parallel / AP) and re-run the model
    if (op === 'sketch_update') {
      const { data: s } = await supa.from('sketch_cards').select('*').eq('card_id', b.card_id).single();
      if (!s) return j({ error: 'not a sketch card' }, 404);
      const patch: Record<string, unknown> = {};
      if (b.character !== undefined) { patch.character_raw = b.character || null; patch.character_id = b.character ? await findOrCreate(supa, 'sketch_characters', b.character) : null; }
      if (b.artist !== undefined) { patch.artist_raw = b.artist || null; patch.artist_id = b.artist ? await findOrCreate(supa, 'sketch_artists', b.artist) : null; patch.artist_confidence = b.artist ? 'confirmed' : 'unknown'; }
      if (b.product !== undefined) patch.product = b.product || 'unknown';
      if (b.parallel !== undefined) patch.parallel = b.parallel || 'base';
      if (b.is_artist_proof !== undefined) patch.is_artist_proof = !!b.is_artist_proof;
      if (b.format !== undefined && b.format !== null && b.format !== '') patch.format = b.format;
      if (b.signer !== undefined) patch.signer = b.signer || null;
      patch.notes = acceptNotes(s.notes, b.note || 'details edited in review');
      const { error: ue } = await supa.from('sketch_cards').update(patch).eq('card_id', b.card_id);
      if (ue) return j({ error: ue.message }, 500);
      const player = await composePlayer(supa, b.card_id);
      if (player) await supa.from('cards').update({ player }).eq('id', b.card_id);
      const { data: s2 } = await supa.from('sketch_cards').select('*').eq('card_id', b.card_id).single();
      // always queue a live comp pull for this card (the runner in Drew's eBay tab fulfills it and re-values)
      const { data: cref } = await supa.from('cards').select('ref').eq('id', b.card_id).single();
      await supa.from('comp_requests').insert({ card_id: b.card_id, ref: cref?.ref || null, status: 'pending', result: 'sketch' });
      if (s2.ensemble) return j({ ok: true, player, revalued: false, queued: true, reason: 'multi-character sketch: live pull queued; it is valued against other multi-character sketches' });
      const v = await valueCard(supa, s2);
      if (!v) return j({ ok: true, player, revalued: false, queued: true, reason: 'no stored comps yet for this character or artist; a live comp pull is queued' });
      const vid = await saveValuation(supa, b.card_id, v, (s2.subject_category ? 'nonsw-edit-' : s2.format === 'sketchagraph' ? 'sketchagraph-edit-' : 'v3-edit-') + today, today, true, 'details edited, re-valued');
      return j({ ok: true, player, revalued: true, queued: true, valuation: { ...v, id: vid } });
    }

    // re-value one card with no identity change (used after a comp refresh)
    if (op === 'sketch_revalue') {
      const { data: s2 } = await supa.from('sketch_cards').select('*').eq('card_id', b.card_id).single();
      if (!s2) return j({ error: 'not a sketch card' }, 404);
      if (s2.ensemble && !b.force) return j({ ok: true, revalued: false, reason: 'multi-character sketch (custom ensemble valuation)' });
      const v = await valueCard(supa, s2);
      if (!v) return j({ ok: true, revalued: false });
      const vid = await saveValuation(supa, b.card_id, v, (s2.subject_category ? 'nonsw-rv-' : s2.format === 'sketchagraph' ? 'sketchagraph-v2-' : 'v3-edit-') + today, today, !!b.apply, null);
      const player = await composePlayer(supa, b.card_id); if (player && b.apply) await supa.from('cards').update({ player }).eq('id', b.card_id);
      return j({ ok: true, revalued: true, player, valuation: { ...v, id: vid } });
    }

    // live comps pulled by the runner for one card: store them, re-value, apply
    if (op === 'sketch_ingest') {
      const { data: s2 } = await supa.from('sketch_cards').select('*').eq('card_id', b.card_id).single();
      if (!s2) return j({ error: 'not a sketch card' }, 404);
      const added = await ingestHits(supa, s2, b.hits || []);
      if (s2.ensemble) return j({ ok: true, added, revalued: false, reason: 'multi-character: comps stored, value kept (custom ensemble valuation)' });
      const { data: rv } = await supa.from('value_reviews').select('action').eq('card_id', b.card_id).order('reviewed_at', { ascending: false }).limit(1);
      const reviewed = rv && rv[0] && rv[0].action !== 'reset';
      const v = await valueCard(supa, s2);
      if (!v) return j({ ok: true, added, revalued: false });
      const vid = await saveValuation(supa, b.card_id, v, 'live-' + today, today, !reviewed, reviewed ? null : 'live comps pulled, re-valued');
      return j({ ok: true, added, revalued: true, applied: !reviewed, model_value: v.model_value, confidence: v.confidence, id: vid });
    }

    // take a card out of the sketch group (it's a plate / insert / parallel / other)
    if (op === 'sketch_remove') {
      const T: Record<string, [string, string, string]> = { printing_plate: ['SW Relic/Parallel/Art', 'parallel', 'printing_plate'], parallel: ['SW Relic/Parallel/Art', 'parallel', 'parallel'], insert: ['SW Insert', 'insert', 'insert'], other: ['Star Wars', 'base', 'base'] };
      const t = T[b.as_type] || T.other;
      const { data: card } = await supa.from('cards').select('notes').eq('id', b.card_id).single();
      await supa.from('sketch_valuations').delete().eq('card_id', b.card_id);
      await supa.from('sketch_cards').delete().eq('card_id', b.card_id);
      const note = `Removed from sketch group ${today}: ${b.as_type || 'other'}${b.note ? ' (' + b.note + ')' : ''}`;
      const { error } = await supa.from('cards').update({ category: t[0], cost_tier: t[1], tax_type: t[2], needs_review: true, value_source: 'comp-uncertain', notes: (card?.notes ? card.notes + ' | ' : '') + note }).eq('id', b.card_id);
      return error ? j({ error: error.message }, 500) : j({ ok: true });
    }
    return j({ error: 'unknown op' }, 400);
  } catch (e) { return j({ error: String(e) }, 500); }
});
