/* Card Vault — comp-refresh runner (window.CV2)  [v7 — adds CV2.watchlistSync() (eBay watchlist -> watchlist_items) and CV2.popsSync() (Alt PSA/BGS/CGC pops -> card_pops); the armed loop runs both once a day. v5 — adds sketch live-comp pulls: comp_requests with result='sketch' are fulfilled by CV2.sketchPull()]
 * WHERE TO RUN: inject into an eBay.com tab where Drew is LOGGED IN (same-origin cookies needed).
 * WHAT IT DOES:
 *   - refreshStale(opts): weekly/monthly batch (unchanged from v3).
 *   - processQueue(): pulls pending rows from comp_requests, refreshes each card's eBay sold+active,
 *       ingests market items (so the sell range + comps + pulled date update), and updates the value
 *       + value_date for the requested card. Then marks the request done. This is what the app's
 *       "Update comp now" button feeds.
 *   - armQueue({intervalMs}): starts a polling loop so every button tap is fulfilled within seconds.
 *       Keep the eBay tab open while working; call disarmQueue() (or close the tab) to stop.
 * VALUE RULE for explicit requests: eBay same-grade median becomes the value (ebay-median >=3 comps,
 *   else ebay-thin). EXCEPTION: cards whose value_source is cardladder or sketch keep their curated
 *   value (eBay structurally under-prices graded/auto/1-of-1s); their comps + date still refresh.
 */
(()=>{
const SUPA='https://kcmrmswazprkizbzewpm.supabase.co';
const ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjbXJtc3dhenBya2l6Ynpld3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NTEzMzAsImV4cCI6MjEwNDEyNzMzMH0.EuB77E8I0b6HzdK8zfDG1qlg-q_k0FUej6pYLyEFiJI';
const SECRET='cv_ingest_7Kq2mZ';
const money=t=>{const m=(t||'').replace(/,/g,'').match(/\$\s?([0-9]+(?:\.[0-9]{2})?)/);return m?parseFloat(m[1]):null;};
const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
function lastname(p){if(!p)return '';let w=(p+'').toLowerCase().replace(/[^a-z0-9\s'-]/g,' ').trim().split(/\s+/);const stop=['jr','sr','ii','iii','psa','sgc','bgs','cgc','rc','hof'];while(w.length>1&&stop.includes(w[w.length-1]))w.pop();return w[w.length-1]||'';}
function itemGrade(t){const m=String(t).match(/\b(PSA|BGS|BVG|SGC|CGC|CSG|BAS|HGA|GMA|TAG|RCG)\s*\.?\s*(10|[1-9](?:\.5)?)\b/i);if(m)return{g:true,gr:m[1].toUpperCase(),n:m[2]};if(/\b(psa|bgs|sgc|cgc|graded|gem\s*mint)\b/i.test(t))return{g:true,gr:'',n:''};return{g:false};}
function cardGI(c){const g=(c.grade||'').toString();if(!g||/^raw$/i.test(g.trim())){return{g:false};}const m=g.match(/\b(PSA|BGS|BVG|SGC|CGC|CSG|BAS|HGA)\s*\.?\s*(10|[1-9](?:\.5)?)/i);if(m)return{g:true,gr:m[1].toUpperCase(),n:m[2]};if(c.grader||/graded/i.test(g))return{g:true,gr:(c.grader||'').toUpperCase(),n:(g.match(/\b(10|[1-9](?:\.5)?)\b/)||[])[0]||''};return{g:false};}
function isReprint(t){return /\b(reprint|re-print|rp|custom|aceo|novelty|proxy|fantasy)\b/i.test(t);}
function autoCard(c){return !!c.is_auto||/auto|signed|autograph/i.test((c.grade||'')+' '+(c.variation||''));}
function autoItem(t){return /\b(auto|autographed|autograph|signed|on[\s-]?card)\b/i.test(t);}
function bucketOf(t,c){const ci=cardGI(c),ii=itemGrade(t);let b;if(ci.g){if(!ii.g)b='raw';else if(ii.n&&ci.n&&ii.n===ci.n&&(!ii.gr||!ci.gr||ii.gr===ci.gr))b='same';else b='different';}else{b=ii.g?'different':'same';}if(b==='same'&&autoCard(c)!==autoItem(t))b='different';return b;}
function buildQuery(c){const parts=[];const yr=(c.year||'').toString().match(/(19|20)\d{2}/);if(yr)parts.push(yr[0]);if(c.player)parts.push((c.player+'').replace(/\b(psa|sgc|bgs|cgc)\b/gi,'').trim());if(c.set_name)parts.push(c.set_name);if(c.card_number)parts.push(c.card_number);if(c.variation&&c.variation.length<28&&!/^base$/i.test(c.variation))parts.push(c.variation.replace(/insert|die-?cut/gi,'').trim());if(c.serial&&/^\/?\d+$/.test(c.serial))parts.push('/'+c.serial.replace(/^\//,''));if(autoCard(c))parts.push('auto');const gi=cardGI(c);if(gi.g&&gi.n){parts.push((c.grader||'')+' '+gi.n);}return parts.join(' ').replace(/\s+/g,' ').trim().slice(0,80);}
async function fetchList(q,sold,ipg){const url='https://www.ebay.com/sch/i.html?_nkw='+encodeURIComponent(q)+'&_sacat=0&_ipg='+(ipg||60)+'&LH_Complete=1'+(sold?'&LH_Sold=1':'');const ctl=new AbortController();const to=setTimeout(()=>ctl.abort(),9000);let html;try{const r=await fetch(url,{credentials:'include',signal:ctl.signal});html=await r.text();}finally{clearTimeout(to);}const doc=new DOMParser().parseFromString(html,'text/html');const out=[];for(const n of [...doc.querySelectorAll('li.s-item, li.s-card, .su-card-container')]){const tEl=n.querySelector('.s-item__title, .s-card__title, .su-styled-text.primary.default, [role=heading]');const title=tEl?tEl.textContent.replace(/Opens in a new window or tab|Opens in a new window|New Listing/gi,'').trim():'';if(!title||/Shop on eBay/i.test(title))continue;const pEl=n.querySelector('.s-item__price, .s-card__price');const price=money(pEl?pEl.textContent:'');if(price==null)continue;const dm=(n.textContent||'').match(/Sold\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);const aEl=n.querySelector('a.s-item__link, a[href*="/itm/"]');const url2=aEl?aEl.href.split('?')[0]:null;const iEl=n.querySelector('img');const img=iEl?(iEl.src||iEl.getAttribute('data-src')):null;if(sold&&!dm)continue;out.push({title:title.slice(0,140),price,date:dm?dm[1]:null,url:url2,img});}return out;}
async function post(path,body){const r=await fetch(SUPA+'/functions/v1/'+path,{method:'POST',headers:{'content-type':'application/json','x-ingest-secret':SECRET,'apikey':ANON},body:JSON.stringify(body)});return r.ok;}
async function getStale(staleDays,maxCards,maxValue){const d=new Date(Date.now()-staleDays*86400000).toISOString().slice(0,10);const sel='id,ref,player,year,set_name,variation,card_number,serial,grade,grader,sport,is_auto,current_value,value_source,value_date,status';let url=SUPA+'/rest/v1/cards?select='+sel+'&order=current_value.desc.nullslast&limit='+maxCards+'&or=(value_date.is.null,value_date.lt.'+d+')';if(maxValue!=null)url+='&current_value=lte.'+maxValue+'&current_value=gt.0';const r=await fetch(url,{headers:{apikey:ANON,Authorization:'Bearer '+ANON}});return await r.json();}
async function refreshCard(c){const ln=lastname(c.player);const q=buildQuery(c);const sold=await fetchList(q,true);let active=[];try{active=await fetchList(q,false);}catch(e){}
 function keep(x){const t=(x.title||'').toLowerCase();if(!t)return false;if(isReprint(t))return false;if(ln&&!t.includes(ln))return false;return true;}
 const items=[];const sameSold=[];
 for(const s of sold.slice(0,80)){if(!keep(s))continue;const bk=bucketOf(s.title,c);if(bk==='same')sameSold.push(s.price);items.push({card_id:c.id,kind:'sold',title:s.title,price:s.price,item_date:s.date,url:s.url,image:s.img,matched:bk==='same',source:'ebay'});if(items.length>=60)break;}
 for(const a of active.slice(0,60)){if(!keep(a))continue;const bk=bucketOf(a.title,c);items.push({card_id:c.id,kind:'active',title:a.title,price:a.price,item_date:null,url:a.url,image:a.img,matched:bk==='same',source:'ebay'});}
 return {items,mm:med(sameSold),nSame:sameSold.length};}

// ---- v5: sketch live comps (character + artist searches -> sketch-ops sketch_ingest, which stores, re-values and applies) ----
const H={apikey:ANON,Authorization:'Bearer '+ANON};
async function sketchInfo(cardId){const r=await fetch(SUPA+'/rest/v1/sketch_cards?card_id=eq.'+cardId+'&select=character_raw,artist_raw,product,subject_category,franchise,signer,format,parallel',{headers:H});return (await r.json())[0];}
const badName=s=>!s||/illegible|unreadable|tbd|scrawl|unknown|unidentified|not named|\?/i.test(s);
const lastOf=s=>{const w=(s||'').replace(/[^A-Za-z0-9' -]/g,' ').trim().split(/\s+/).filter(x=>x.length>1);return w.length?w[w.length-1]:'';};
function sketchQueries(s){const ch=badName(s.character_raw)?'':s.character_raw.replace(/\(.*?\)/g,'').trim();const ar=badName(s.artist_raw)?'':s.artist_raw.replace(/\(.*?\)/g,'').replace(/,.*$/,'').trim();const sw=!s.subject_category;const q=[];
 if(ch)q.push(sw?'star wars sketch '+ch:ch+' sketch card');if(ar)q.push(sw?'star wars sketch '+ar:ar+' sketch card');if(ch&&ar)q.push(ch+' '+lastOf(ar)+' sketch');
 if(s.format==='sketchagraph'&&s.signer)q.push('sketchagraph '+s.signer);if(s.parallel&&s.parallel!=='base'&&ch)q.push(ch+' '+s.parallel.replace('_',' ')+' sketch');if(s.format==='oversized'){q.push(sw?'star wars oversized sketch':'oversized sketch card');if(ch)q.push(ch+' oversized sketch');q.push(sw?'star wars jumbo sketch':'jumbo sketch card');}return [...new Set(q)];}
async function sketchPull(cardId){const s=await sketchInfo(cardId);if(!s)return {err:'not a sketch card'};const qs=sketchQueries(s);if(!qs.length)return {err:'no character/artist name to search'};const hits=[];
 for(const q of qs){try{const L=await fetchList(q,true,240);for(const x of L){let d=null;try{d=x.date?new Date(x.date).toISOString().slice(0,10):null;}catch(e){}hits.push({title:x.title,price:x.price,date:d,url:x.url,img:x.img});}}catch(e){}}
 const r=await fetch(SUPA+'/functions/v1/sketch-ops',{method:'POST',headers:{'content-type':'application/json','x-ingest-secret':SECRET,'apikey':ANON},body:JSON.stringify({op:'sketch_ingest',card_id:cardId,hits})});let j={};try{j=await r.json();}catch(e){j={error:'bad response '+r.status};}
 return Object.assign({queries:qs,hits:hits.length},j);}
function sketchResult(o){if(o.err||o.error)return 'sketch: '+(o.err||o.error);let t='sketch: +'+(o.added||0)+' new comps from '+(o.hits||0)+' eBay sold results';if(o.revalued)t+=o.applied?', value now $'+o.model_value+' ('+o.confidence+')':', model says $'+o.model_value+' (your reviewed value kept)';else t+=', value unchanged'+(o.reason?' ('+o.reason+')':'');return t;}
async function patchReq(id,body){await fetch(SUPA+'/rest/v1/comp_requests?id=eq.'+id,{method:'PATCH',headers:{apikey:ANON,Authorization:'Bearer '+ANON,'content-type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(body)});}
  // ---------- eBay watchlist sync (v7) ----------
  const WL_FN = 'https://kcmrmswazprkizbzewpm.supabase.co/functions/v1/watchlist-ops';
  function wlCategory(t) {
    const s = (t || '').toLowerCase();
    const R = [
      ['Sketch & Original Art', /sketch|original art|1\/1 art|artist proof|hand[- ]drawn|canvas collection/],
      ['Star Wars', /star wars|mandalorian|jedi|sith|vader|skywalker|grogu|boba fett|obi-wan|chewbacca/],
      ['Pokemon', /pok[eé]mon|pikachu|charizard/],
      ['Garbage Pail Kids', /garbage pail|\bgpk\b/],
      ['Wrestling', /\bwwe\b|\bwwf\b|\bwcw\b|\baew\b|njpw|wrestl|hulk hogan|undertaker|john cena|rock dwayne/],
      ['Boxing & MMA', /boxing|\bufc\b|\bmma\b|cassius clay|muhammad ali|mayweather|tyson|brown's boxing/],
      ['Music', /nsync|nirvana|cobain|beatles|elvis|taylor swift|michael jackson|rock cards|hip[- ]hop|tupac|2pac|eminem|biggie|music|kiss |metallica|madonna/],
      ['Basketball', /\bnba\b|wnba|basketball|lebron|jordan|kobe|curry|ewing|wembanyama|mikan|hoops|prizm dp|knicks|walton|larry bird|magic johnson|shaq|duncan|garnett|bueckers|caitlin clark|hardcourt|precious metal gems|fleer ultra|anthony edwards|luka|giannis/],
      ['Baseball', /baseball|\bmlb\b|bowman|ohtani|aaron judge|mantle|ichiro|yankees|griffey|project 70|trout|shoeless|babe ruth|ty cobb|willie mays|hank aaron|jeter|acu[nñ]a|juan soto|skenes|misiorowski|topps now|red sox|dodgers|mets\b|deion sanders|yount/],
      ['Football', /\bnfl\b|football|brady|mahomes|panini prizm football|rookie ticket|contenders/],
      ['Marvel & DC', /marvel|x-men|spider|batman|superman|dc comics|thanos|hulk|wolverine|joker|wonder woman|avengers|national periodical/],
      ['Harry Potter', /harry potter|hogwarts|quidditch|wizards of the coast.*potter/],
      ['Movies & TV', /ghostbusters|anchorman|godfather|happy gilmore|muppet|nickelodeon|movie|film|\btv\b|hollywood|stranger things|heath ledger|lord of the rings|gollum|james bond|\b007\b|simpsons|disney|looney|warner bros|road runner|star trek|jurassic|g\.?i\.? joe|he-man|tmnt|ninja turtles|shrek|toy story|seinfeld|cartoon|saturday morning|inspector gadget|terminator|rocky|back to the future|goonies|indiana jones|scarface/],
    ];
    for (const [c, re] of R) if (re.test(s)) return c;
    const y = Number((s.match(/\b(18[89]\d|19\d\d|20[0-2]\d)\b/) || [])[1]);
    if (y && y < 1980) return 'Vintage & Oddball';
    return 'Other';
  }
  function wlParse(html) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    d.querySelectorAll('.m-item-3').forEach((e) => {
      const a = e.querySelector('a[href*="/itm/"]'); const m = a && a.getAttribute('href').match(/\/itm\/(?:[^\/?]+\/)?(\d{9,})/);
      if (!m) return;
      const title = (e.querySelector('.m-item-3-col__title')?.innerText || a.innerText || '').trim();
      const secs = [...e.querySelectorAll('.m-item-3-col__section')].map((x) => x.innerText.replace(/\s+/g, ' ').trim());
      const all = secs.join(' | ');
      const cond = (secs[0] || '').replace(title, '').trim() || null;
      const priceTxt = e.querySelector('.m-item--price')?.innerText || '';
      const price = Number((priceTxt.match(/[\d,]+\.\d{2}/) || [''])[0].replace(/,/g, '')) || null;
      const oldTxt = e.querySelector('.m-item--old-price')?.innerText || '';
      const bidsM = all.match(/(\d+)\s+bids?\b/i);
      const ends = (e.querySelector('.m-item--listing-ends')?.innerText || '').trim();
      const ended = /\bended\b|\bsold\b|no longer available|out of stock/i.test(ends + ' ' + secs.slice(1, 3).join(' '));
      const seller = (all.match(/([A-Za-z0-9._\-*]+) user ID/) || [])[1] || null;
      const watchers = Number((all.match(/(\d+) watching/) || [])[1]) || null;
      const img = e.querySelector('img')?.getAttribute('src') || null;
      let lt = bidsM ? (/buy it now/i.test(all) ? 'auction_bin' : 'auction') : (/best offer/i.test(all) ? 'bin_bo' : 'bin');
      out.push({ item_id: m[1], title, condition: cond, price, was_price: Number((oldTxt.match(/[\d,]+\.\d{2}/) || [''])[0].replace(/,/g, '')) || null,
        bids: bidsM ? Number(bidsM[1]) : null, ends_in: ends || null, ended, seller, watchers, image_url: img && img.replace(/s-l\d+\.(jpg|webp|png)/, 's-l500.jpg'),
        listing_type: lt, category: wlCategory(title) });
    });
    const total = Number(((html.match(/Watchlist[^<]{0,40}\((\d+)\)/) || html.match(/\((\d{2,5})\)<\//) || [])[1])) || null;
    const links = [...d.querySelectorAll('a.pagination__item')].map((x) => ({ n: Number(x.innerText.trim()), href: x.getAttribute('href') })).filter((x) => x.n && x.href && x.href !== '#');
    return { items: out, total, links };
  }
  async function watchlistSync(opts = {}) {
    const base = 'https://www.ebay.com/mye/myebay/watchlist';
    const seen = new Map(); let total = null; const log = [];
    const get = async (u) => { const r = await fetch(u, { credentials: 'include' }); return r.text(); };
    const first = wlParse(await get(base)); total = first.total; first.items.forEach((i) => seen.set(i.item_id, i));
    const pages = total ? Math.ceil(total / Math.max(first.items.length, 1)) : 1;
    for (let p = 2; p <= Math.min(pages + 1, opts.maxPages || 40); p++) {
      const pr = wlParse(await get(base + '?page=' + p)); let fresh = 0;
      pr.items.forEach((i) => { if (!seen.has(i.item_id)) { seen.set(i.item_id, i); fresh++; } });
      log.push(p + ':' + pr.items.length + '/' + fresh);
      if (!fresh) break;
    }
    const items = [...seen.values()];
    window.__wlItems = items;
    const complete = !!total && items.length >= total * 0.97;
    if (opts.dry) return { total, scraped: items.length, complete, pages: log };
    const res = [];
    for (let k = 0; k < items.length; k += 150) {
      const r = await fetch(WL_FN, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-secret': 'cv_ingest_7Kq2mZ' },
        body: JSON.stringify({ op: 'watchlist_ingest', items: items.slice(k, k + 150), mark_missing: false }) });
      res.push(await r.json());
    }
    if (complete) { // second pass only to retire items no longer on the watchlist
      const r = await fetch(WL_FN, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-secret': 'cv_ingest_7Kq2mZ' },
        body: JSON.stringify({ op: 'watchlist_retire', ids: items.map((i) => i.item_id) }) });
      res.push(await r.json());
    }
    const summary = { total, scraped: items.length, complete, pages: log, results: res.map((r) => ({ ok: r.ok, ins: r.inserted, upd: r.updated, removed: r.removed, errs: r.errs })) };
    window.__wlLast = summary; return summary;
  }

  // ---------- v7: population counts from Alt (PSA / BGS / CGC / SGC per grade) ----------
  const ALT_GQL = 'https://alt-platform-server.production.internal.onlyalt.com/graphql/';
  async function altCfg() {
    const q = 'query SearchServiceConfig { serviceConfig { search { assetSearch { clientConfig { nodes { host port protocol } apiKey } collectionName expiresAt } } } }';
    const r = await (await fetch(ALT_GQL + 'SearchServiceConfig', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'SearchServiceConfig', query: q, variables: {} }) })).json();
    const c = r.data.serviceConfig.search.assetSearch; const n = c.clientConfig.nodes[0];
    return { url: n.protocol + '://' + n.host + '/collections/' + c.collectionName + '/documents/search', key: c.clientConfig.apiKey, exp: (c.expiresAt || 0) * 1000 };
  }
  async function altPops(assetId) {
    const q = 'query AssetCardPops($id: ID!) { asset(id: $id) { id cardPops { gradingCompany gradeNumber count } } }';
    const r = await (await fetch(ALT_GQL + 'AssetCardPops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'AssetCardPops', query: q, variables: { id: assetId } }) })).json();
    return (r.data && r.data.asset && r.data.asset.cardPops) || [];
  }
  const PARWORDS = /refractor|prizm|holo|silver|gold|blue|red|green|orange|purple|pink|black|white|bronze|platinum|sapphire|atomic|wave|mojo|shimmer|cracked ice|disco|tiger|zebra|camo|x-fractor|xfractor|superfractor|speckle|lava|velocity|hyper|scope|pulsar|choice|fast break|parallel|\/\d+|auto|autograph|patch|jersey|relic|signature/;
  const STOP = new Set(['base','rc','rookie','card','insert','the','and','of','nba','nfl','mlb','raw','set','edition','series','sp','ssp','variation','variant','panini','topps','upper','deck','#']);
  const toks = (s) => (s || '').toLowerCase().replace(/#/g, ' ').replace(/[^a-z0-9\/ ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  function cleanPlayer(p) { return (p || '').replace(/\(.*?\)/g, '').replace(/\b(PSA|BGS|SGC|CGC|BVG|Beckett)\b.*$/i, '').replace(/\/.*$/, '').trim(); }
  function cardQuery(c) {
    const yr = ((c.year || c.set_name || '').match(/(19|20)\d\d/) || [''])[0];
    const set = (c.set_name || '').replace(/(19|20)\d\d(-\d\d)?/g, '').trim();
    const varc = (c.variation || '').replace(/\b(base|rc|rookie card|rookie|insert|raw)\b/ig, '').replace(/\(.*?\)/g, '').trim();
    const num = (c.card_number || '').replace(/^#/, '').trim();
    return { yr, set, varc, num, player: cleanPlayer(c.player) };
  }
  // Match rule: every identifying token on the Alt asset (year, brand words, variety words, card #, subject surname)
  // has to appear somewhere in our card's text. That keeps parallels from matching base cards and vice versa,
  // and it works even when our fields are messy (set name inside the player field, etc).
  const GENERIC = new Set(['basketball','baseball','football','cards','card','trading','nba','nfl','mlb','wnba','rookie','rc','prospects','draft','the','and','of','edition','set','series','base','sticker','stickers','premium']);
  function scoreDoc(c, q, d) {
    const ctext = ' ' + [c.year, c.set_name, c.player, c.variation, c.card_number, c.serial].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9\/ ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
    const flat = ctext.replace(/ /g, '');
    const has = (w) => ctext.includes(' ' + w + ' ') || (w.length > 4 && ctext.includes(w)) || (w.length > 5 && flat.includes(w));
    const surname = (String(d.subject || '').split(/[\s,&]+/).filter(Boolean).pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!surname || !has(surname)) return { ok: false, why: 'subject ' + d.subject };
    const cy = (ctext.match(/\b(19|20)\d\d\b/g) || []);
    const yrOk = !cy.length ? null : cy.includes(String(d.year));
    if (yrOk === false) return { ok: false, why: 'year ' + d.year };
    const brandT = toks(d.brand).filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w));
    const BFILL = new Set(['picks','collection']); const bMiss = brandT.filter((w) => !has(w) && !BFILL.has(w)); const bHit = brandT.length - bMiss.length; if (bMiss.length) return { ok: false, why: 'brand ' + d.brand };
    const varT = toks(d.variety).filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w));
    const vMiss = varT.filter((w) => !has(w.replace(/^\//, '')) && !has(w)); if (vMiss.length) return { ok: false, why: 'variety ' + d.variety };
    const cardPar = PARWORDS.test((c.variation || '') + ' ' + (c.player || '') + ' ' + (c.serial || '').replace(/^\d+\s*of\s*\d+$/i, ''));
    const docPar = PARWORDS.test(String(d.variety || '').toLowerCase());
    if (cardPar && !docPar && !/signed|psa dna|psa\/dna|jsa|in person/.test(ctext)) return { ok: false, why: 'we have a parallel/auto, asset is base' };
    const VFILL = new Set(['design','retro','insert','rookie','rookies','base','pick','draft','lot','duplicate','dup','raw','card','cards','issue','prospect','prospects','edition','hit','case','year','era','sp','ssp','short','print','variation','variant','version','front','back','nba','nfl','mlb','college','signed','full','name','certified','sticker','stickers','card']);
    const cv = toks(String(c.variation || '').replace(/\(.*?\)/g, ' ')).filter((w) => w.length > 3 && !VFILL.has(w) && !PARWORDS.test(w) && !/^\d/.test(w) && !toks(d.subject).includes(w));
    const dtext = (String(d.name || '') + ' ' + String(d.variety || '')).toLowerCase();
    if (cv.length && !cv.some((w) => dtext.includes(w))) return { ok: false, why: 'our variation (' + cv.join(' ') + ') not on asset' };
    const dSer = (String(d.name || '').match(/\/(\d+)\b/) || [])[1];
    if (dSer && !ctext.includes('/' + dSer) && !ctext.includes('of ' + dSer)) return { ok: false, why: 'asset is numbered /' + dSer };
    let numOk = null; const dn = String(d.cardNumber || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '');
    const cn = String(c.card_number || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^0+/, '');
    if (cn) { numOk = cn === dn; if (!numOk) return { ok: false, why: 'number ' + d.cardNumber }; }
    else if (dn && has(dn) && dn.length > 1) numOk = true;
    if (yrOk !== true && numOk !== true) return { ok: false, why: 'unverified (no year or card # to confirm): ' + d.name };
    return { ok: true, exact: numOk === true && yrOk === true && (!brandT.length || bHit > 0), score: bHit + varT.length * 2 + (numOk ? 3 : 0) + (yrOk ? 2 : 0) };
  }
  async function popsOne(c, cfg) {
    const q = cardQuery(c); if (!q.player) return { card_id: c.id, match: 'none', match_note: 'no player/subject' };
    const text = [q.yr, q.set, q.player, q.varc, q.num].filter(Boolean).join(' ').replace(/\b(PSA|BGS|SGC|CGC)\s*\d+(\.\d)?\b/ig, '').replace(/\s+/g, ' ').trim();
    const p = new URLSearchParams({ q: text, query_by: 'name', per_page: '20', drop_tokens_threshold: '5' });
    const j = await (await fetch(cfg.url + '?' + p, { headers: { 'X-TYPESENSE-API-KEY': cfg.key } })).json();
    const hits = (j.hits || []).map((h) => h.document);
    const ok = hits.map((d) => ({ d, s: scoreDoc(c, q, d) })).filter((x) => x.s.ok).sort((a, b) => b.s.score - a.s.score);
    if (!ok.length) { const t0 = hits[0] ? scoreDoc(c, q, hits[0]) : null; return { card_id: c.id, match: 'none', asset_name: hits[0] ? hits[0].name : null, match_note: 'searched "' + text + '"' + (hits[0] ? '; top hit rejected: ' + t0.why : '; no hits') }; }
    const best = ok[0]; const tie = ok[1] && ok[1].s.score === best.s.score && ok[1].d.id !== best.d.id;
    const match = best.s.exact && !tie ? 'exact' : (tie ? 'ambiguous' : 'probable');
    if (match === 'ambiguous') return { card_id: c.id, match, asset_id: best.d.id, asset_name: best.d.name, match_note: 'tied with ' + ok[1].d.name };
    const pops = (await altPops(best.d.id)).filter((x) => x.count > 0).map((x) => ({ grader: x.gradingCompany, grade: String(x.gradeNumber).replace(/\.0$/, ''), pop: x.count }));
    return { card_id: c.id, asset_id: best.d.id, asset_name: best.d.name, asset_image: (best.d.images || [])[0] && best.d.images[0].url, match, match_note: 'query "' + text + '"', pop_total: pops.reduce((s, x) => s + x.pop, 0), pops };
  }
  async function popsSync(opts = {}) {
    if (window.__popsRunning) return 'already running'; window.__popsRunning = true;
    const P = { done: false, i: 0, exact: 0, probable: 0, none: 0, ambiguous: 0, errs: 0, log: [] }; window.CV2 && (window.CV2.popsProg = P); window.__popsProg = P;
    const H = { apikey: ANON, Authorization: 'Bearer ' + ANON };
    const get = async (path) => { let all = []; for (let f = 0; ; f += 1000) { const r = await fetch(SUPA + '/rest/v1/' + path + (path.includes('?') ? '&' : '?') + 'offset=' + f + '&limit=1000', { headers: H }); const d = await r.json(); all = all.concat(d); if (d.length < 1000) break; } return all; };
    const sk = new Set((await get('sketch_cards?select=card_id')).map((x) => x.card_id));
    const done = new Map((await get('card_alt_assets?select=card_id,checked_at')).map((x) => [x.card_id, x.checked_at]));
    const maxAge = (opts.maxAgeDays ?? 30) * 86400000;
    let cards = (await get('cards?select=id,ref,player,year,set_name,variation,card_number,serial,grader,grade,current_value&status=not.in.(sold,duplicate)&order=current_value.desc.nullslast'))
      .filter((c) => !sk.has(c.id) && (!done.has(c.id) || Date.now() - Date.parse(done.get(c.id)) > maxAge));
    if (opts.refs) cards = cards.filter((c) => opts.refs.includes(c.ref));
    if (opts.recheck) { const ids = new Set((await get('card_alt_assets?select=card_id&match=in.(' + opts.recheck + ')')).map((x) => x.card_id)); cards = (await get('cards?select=id,ref,player,year,set_name,variation,card_number,serial,grader,grade,current_value&status=not.in.(sold,duplicate)')).filter((c) => ids.has(c.id) && !sk.has(c.id)); }
    cards = cards.slice(0, opts.limit || 5000); P.total = cards.length;
    let cfg = await altCfg(); let buf = [];
    const flush = async () => { if (!buf.length) return; if (opts.dry) { P.sample = (P.sample || []).concat(buf.map((o) => ({ m: o.match, a: o.asset_name, n: (o.match_note || '').slice(0, 100), pop: o.pop_total }))); buf = []; return; } const r = await fetch(WL_FN, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-secret': SECRET }, body: JSON.stringify({ op: 'pops_ingest', results: buf }) }); const o = await r.json(); if (!o.ok) P.log.push('save: ' + JSON.stringify(o.errs || o.error).slice(0, 120)); buf = []; };
    for (const c of cards) {
      try { if (Date.now() > cfg.exp - 60000) cfg = await altCfg(); const o = await popsOne(c, cfg); P[o.match] = (P[o.match] || 0) + 1; buf.push(o); if (opts.verbose) P.log.push(c.ref + ' ' + o.match + ' ' + (o.asset_name || o.match_note || '').slice(0, 90) + (o.pop_total != null ? ' pop ' + o.pop_total : '')); }
      catch (e) { P.errs++; P.log.push(c.ref + ' ERR ' + String(e).slice(0, 60)); }
      P.i++; if (buf.length >= 25) await flush(); if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    await flush(); P.done = true; window.__popsRunning = false; return P;
  }

window.CV2={prog:{},sketchPull,sketchQueries,watchlistSync,popsSync,wlParse,wlCategory,async refreshOne(cardId){const r=await fetch(SUPA+'/rest/v1/cards?id=eq.'+cardId+'&select=id,ref,player,year,set_name,variation,card_number,serial,grade,grader,sport,is_auto,current_value,value_source',{headers:{apikey:ANON,Authorization:'Bearer '+ANON}});const c=(await r.json())[0];if(!c)return 'no card';const {items,mm,nSame}=await refreshCard(c);if(items.length)await post('ingest-market-items',{items});return {ref:c.ref,items:items.length,sameSold:nSame,median:mm};},
async refreshStale(opts){opts=opts||{};const staleDays=opts.staleDays??7;const maxCards=opts.maxCards??150;const protMin=opts.autoUpdateMaxValue??100;const maxValue=opts.maxValue??null;const cards=(await getStale(staleDays,maxCards,maxValue)).filter(c=>c.status!=='sold');const P={total:cards.length,i:0,updated:0,items:0,protectedCnt:0,nocomp:0,errs:0,done:false,log:[]};window.CV2.prog=P;const today=new Date().toISOString().slice(0,10);for(const c of cards){try{const {items,mm,nSame}=await refreshCard(c);if(items.length){const ok=await post('ingest-market-items',{items});if(ok)P.items++;}const cv=parseFloat(c.current_value)||0;const vs=(c.value_source||'');const gi=cardGI(c);const protectedCard=cv>=protMin||/cardladder|sketch/.test(vs)||(gi.g&&(gi.n==='10'||gi.n==='9.5')&&cv>=60);let action='no-comp';if(nSame>=1&&mm!=null){if(protectedCard){action='protected(items only)';P.protectedCnt++;}else{const src=nSame>=3?'ebay-median':'ebay-thin';await post('lot-ops',{op:'set_card',card_id:c.id,current_value:Math.round(mm*100)/100,value_source:src,value_date:today});action='updated $'+(Math.round(mm*100)/100)+' ('+nSame+' same)';P.updated++;}}else{if(protectedCard)P.protectedCnt++;else P.nocomp++;}P.log.push(c.ref+': '+action);}catch(e){P.errs++;P.log.push((c.ref||'?')+': ERR '+String(e).slice(0,30));}P.i++;await new Promise(r=>setTimeout(r,250));}P.done=true;return P;},
async processQueue(){const today=new Date().toISOString().slice(0,10);try{await fetch(SUPA+'/rest/v1/comp_requests?status=eq.running&started_at=lt.'+new Date(Date.now()-240000).toISOString(),{method:'PATCH',headers:{apikey:ANON,Authorization:'Bearer '+ANON,'content-type':'application/json',Prefer:'return=minimal'},body:JSON.stringify({status:'pending',started_at:null})});}catch(e){}window.__CVBEAT=Date.now();const r=await fetch(SUPA+'/rest/v1/comp_requests?status=eq.pending&order=requested_at.asc&limit=5',{headers:{apikey:ANON,Authorization:'Bearer '+ANON}});const reqs=await r.json();if(!reqs||!reqs.length)return 0;let n=0;for(const req of reqs){await patchReq(req.id,{status:'running',started_at:new Date().toISOString()});if(req.result==='sketch'){try{const o=await sketchPull(req.card_id);await patchReq(req.id,{status:(o.err||o.error)?'error':'done',done_at:new Date().toISOString(),result:sketchResult(o)});n++;}catch(e){await patchReq(req.id,{status:'error',done_at:new Date().toISOString(),result:'sketch: '+String(e).slice(0,80)});}continue;}try{const cr=await fetch(SUPA+'/rest/v1/cards?id=eq.'+req.card_id+'&select=id,ref,player,year,set_name,variation,card_number,serial,grade,grader,sport,is_auto,current_value,value_source,status',{headers:{apikey:ANON,Authorization:'Bearer '+ANON}});const c=(await cr.json())[0];if(!c){await patchReq(req.id,{status:'error',done_at:new Date().toISOString(),result:'card not found'});continue;}const {items,mm,nSame}=await refreshCard(c);if(items.length)await post('ingest-market-items',{items});const vs=(c.value_source||'');let result;if(/cardladder|sketch/.test(vs)){result='comps refreshed; value kept ('+vs+' — eBay under-prices these)';}else if(nSame>=1&&mm!=null){const src=nSame>=3?'ebay-median':'ebay-thin';await post('lot-ops',{op:'set_card',card_id:c.id,current_value:Math.round(mm*100)/100,value_source:src,value_date:today});result='value $'+(Math.round(mm*100)/100)+' ('+nSame+' same-grade sold), comps + date updated';}else{result='comps refreshed; no same-grade sold found, value kept';}await patchReq(req.id,{status:'done',done_at:new Date().toISOString(),result});n++;}catch(e){await patchReq(req.id,{status:'error',done_at:new Date().toISOString(),result:String(e).slice(0,80)});}}return n;},
armQueue(opts){opts=opts||{};const iv=opts.intervalMs||12000;window.__CVARMED=true;if(window.__CVQ){clearInterval(window.__CVQ);window.__CVQ=null;}
 if(navigator.locks&&!window.__CVLOCK){window.__CVLOCK=true;navigator.locks.request('cv-comp-runner-keepalive',function(){return new Promise(function(){});}).catch(function(){});}
 if(!window.__CVVIS){window.__CVVIS=true;document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&window.__CVARMED&&window.__CVWAKE)window.__CVWAKE();});}
 if(!window.__CVLOOP){window.__CVLOOP=(async function(){while(window.__CVARMED){let n=0;try{n=await window.CV2.processQueue();}catch(e){}try{let last=0;try{last=+localStorage.getItem('cv_wl_last')||0;}catch(e){}if(!n&&Date.now()-last>20*3600000){try{localStorage.setItem('cv_wl_last',String(Date.now()));}catch(e){}await window.CV2.watchlistSync();await window.CV2.popsSync({maxAgeDays:30,limit:250});}}catch(e){}if(!n)await new Promise(function(r){window.__CVWAKE=r;setTimeout(r,iv);});}window.__CVLOOP=null;})();}
 return 'Card Vault comp runner ARMED (checks every '+(iv/1000)+'s, one request at a time). Leave this eBay tab open; if it sits in the background for a long time Chrome may pause it, and clicking the tab wakes it.';},
disarmQueue(){window.__CVARMED=false;if(window.__CVWAKE)window.__CVWAKE();if(window.__CVQ){clearInterval(window.__CVQ);window.__CVQ=null;}return 'disarmed';}};
return 'CV2 v7 installed';
})();
