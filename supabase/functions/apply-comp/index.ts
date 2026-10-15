import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SECRET='cv_ingest_7Kq2mZ';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-ingest-secret, x-agent-pass','Access-Control-Allow-Methods':'POST, OPTIONS'};
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
const J=(o:any,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{...cors,'content-type':'application/json'}});
function r2(x:number){return Math.round(x*100)/100;}
function pdate(s:any){if(!s)return null;const d=new Date(s);if(isNaN(d.getTime()))return null;return d.toISOString().slice(0,10);}
function med(a:number[]){if(!a.length)return null;const b=a.slice().sort((x,y)=>x-y);const n=b.length,h=Math.floor(n/2);return n%2?b[h]:(b[h-1]+b[h])/2;}
Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  try{
    if(!(await vaultAuthorized(req)))return J({error:'locked'},401);
    const body=await req.json().catch(()=>({}));const limit=body.limit||60;const onlyBatch=body.batch||null;
    const supa=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    let qb=supa.from('comp_run').select('card_id,ref,ebay_result,cl_result,is_parallel,batch').not('cl_result','is',null).not('ebay_result','is',null).is('applied_at',null);
    if(onlyBatch) qb=qb.eq('batch',onlyBatch);
    const {data:rows,error:selErr}=await qb.order('prio',{ascending:true}).limit(limit);
    if(selErr)return J({error:'sel: '+selErr.message},500);
    if(!rows||!rows.length)return J({ok:true,applied:0,remaining:0});
    const ids=rows.map(r=>r.card_id);
    const {data:cards}=await supa.from('cards').select('id,current_value,value_source,grade,serial,is_auto,is_relic').in('id',ids);
    const cmap:any={};(cards||[]).forEach(c=>cmap[c.id]=c);
    await supa.from('card_market_items').delete().in('card_id',ids).in('source',['ebay','cardladder']);
    const items:any[]=[];const results:any[]=[];
    for(const row of rows){
      const eb=row.ebay_result||{};const cl=row.cl_result||{};const card=cmap[row.card_id]||{};
      const ebN=eb.sold_n||0, clN=cl.cl_n||0; const eb_med=eb.sold_median, cl_med=cl.cl_median;
      const ebB=!!eb.broad, clB=!!cl.broad;
      const ebClean=ebN>0&&!ebB, clClean=clN>0&&!clB;
      let useEb=false,useCl=false,broad=false;
      if(ebClean&&clClean){useEb=true;useCl=true;}
      else if(ebClean){useEb=true;}
      else if(clClean){useCl=true;}
      else {useEb=ebN>0;useCl=clN>0;broad=true;}
      let vmed:any=null,vsrc='no-comps';
      const nEff=(useEb?ebN:0)+(useCl?clN:0);
      if(useEb&&useCl){vmed=r2((eb_med+cl_med)/2);vsrc=(ebN>=3&&clN>=3)?'ebay+cl':'thin-both';}
      else if(useEb){vmed=eb_med;vsrc=ebN>=3?'ebay-median':'ebay-thin';}
      else if(useCl){vmed=cl_med;vsrc=clN>=3?'cardladder-median':'cardladder-thin';}
      // most recent from used sources
      let vrec=null,vrecd:any=null;const ebd=useEb?pdate(eb.sold_recent_date):null;const cld=useCl?(cl.cl_recent_date||null):null;
      if(ebd&&cld){if(ebd>=cld){vrec=eb.sold_recent;vrecd=ebd;}else{vrec=cl.cl_recent;vrecd=cld;}}else if(ebd){vrec=eb.sold_recent;vrecd=ebd;}else if(cld){vrec=cl.cl_recent;vrecd=cld;}
      let assessed=vmed;
      if(vrec!=null&&vmed!=null&&vmed>0){const within=vrec<=2*vmed&&vrec>=0.5*vmed;assessed=within?r2(0.6*vrec+0.4*vmed):vmed;}
      else if(vrec!=null&&vmed==null){assessed=vrec;}
      let high=0;(eb.ebay_sold||[]).forEach((x:any)=>{if(x.price>high)high=x.price;});(cl.cl||[]).forEach((x:any)=>{if(x.price>high)high=x.price;});
      // dispersion guard on the chosen source set
      const cand = (useEb? (eb.ebay_sold||[]).map((x:any)=>+x.price):[]).concat(useCl?(cl.cl||[]).map((x:any)=>+x.price):[]).filter((x:number)=>x>0);
      let mixed=false; if(cand.length>=4){const m=med(cand)||0; if(m>0){const hi=cand.filter((p:number)=>p>=2.5*m).length; if(hi>=3) mixed=true;}}
      (eb.ebay_sold||[]).forEach((x:any)=>items.push({card_id:row.card_id,source:'ebay',kind:'sold',title:x.title,price:x.price,item_date:pdate(x.date),url:x.url,matched:true,pulled_at:new Date().toISOString()}));
      (eb.ebay_active||[]).forEach((x:any)=>items.push({card_id:row.card_id,source:'ebay',kind:'active',title:x.title,price:x.price,url:x.url,matched:true,pulled_at:new Date().toISOString()}));
      (cl.cl||[]).forEach((x:any)=>items.push({card_id:row.card_id,source:'cardladder',kind:'sold',title:x.title,price:x.price,item_date:x.date||null,condition:(x.company?(x.company.toUpperCase()+' '+(x.grade||'')):null),url:x.url,matched:true,pulled_at:new Date().toISOString()}));
      const cv=card.current_value!=null?Number(card.current_value):null;const vs=card.value_source||'';const gr=(card.grade||'').toLowerCase();
      const gem=/\b(10|9\.5)\b/.test(gr);const premium=(card.serial!=null&&String(card.serial).trim()!=='')||card.is_auto===true||card.is_relic===true||gem;
      const protectedCard=(cv!=null&&cv>=100)||/^(cardladder|sketch|ebay-1st)/.test(vs)||(gem&&cv!=null&&cv>=60);
      const upd:any={value_median:vmed,value_recent:vrec,value_recent_date:vrecd,value_high_comp:high>0?high:null,value_comp_n:(ebN+clN),value_comps_broad:(broad||mixed),value_date:new Date().toISOString()};
      let action='refresh-protected';
      if(!protectedCard){
        if(assessed==null){upd.value_source=vs||'no-comps';action='no-comps';}
        else if(mixed){upd.value_source='comp-mixed-review';action='mixed-review';}
        else if(broad&&premium){upd.value_source='comp-uncertain';action='uncertain-premium-broad';}
        else{upd.current_value=assessed;upd.value_source=broad?(vsrc+'-broad'):vsrc;action='set:'+upd.value_source;}
      }
      const {error:uErr}=await supa.from('cards').update(upd).eq('id',row.card_id);
      if(uErr){results.push({ref:row.ref,err:uErr.message});continue;}
      await supa.from('comp_run').update({applied_at:new Date().toISOString(),status:'done'}).eq('card_id',row.card_id);
      results.push({ref:row.ref,action,assessed});
    }
    let inserted=0;for(let i=0;i<items.length;i+=500){const chunk=items.slice(i,i+500);const {error}=await supa.from('card_market_items').insert(chunk);if(error)return J({error:'ins: '+error.message,applied:results.length,inserted},500);inserted+=chunk.length;}
    let cq=supa.from('comp_run').select('card_id',{count:'exact',head:true}).not('cl_result','is',null).not('ebay_result','is',null).is('applied_at',null); if(onlyBatch) cq=cq.eq('batch',onlyBatch);
    const {count}=await cq;
    return J({ok:true,applied:results.length,items_inserted:inserted,remaining:count||0});
  }catch(e){return J({error:String(e)},500);}
});
