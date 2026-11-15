// Incomplete leads, quote-tool counts, results. Run: node backend/test/leads.test.js
const makeEnv=require('./harness'); const E=makeEnv(); let fails=0;
const ok=(c,m)=>{ console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };
E.addClient('abc-fence','owner@abc.com',{site:'https://getpricewink.com/demos/abc-fence/'}); E.addClient('gonzalez','g@tree.com',{site:'https://x.com/'});
E.post({action:'login_code',client:'abc-fence',email:'owner@abc.com'});
const T=E.post({action:'login_verify',client:'abc-fence',email:'owner@abc.com',code:E.mail[0].subject.slice(0,6)}).token; E.mail.length=0;
E.post({action:'login_code',client:'gonzalez',email:'g@tree.com'});
const TG=E.post({action:'login_verify',client:'gonzalez',email:'g@tree.com',code:E.mail[0].subject.slice(0,6)}).token; E.mail.length=0;
const age=(id,mins)=>{ const S=E.sheets.Leads,H=S[0]; S.forEach(r=>{ if(r[0]===id) r[H.indexOf('updated')]=new Date(Date.now()-mins*60000); }); };
// tracking
['visit','visit','start','contact','bogus'].forEach(ev=>E.post({action:'track',client:'abc-fence',event:ev,source:'facebook'}));
ok(E.sheets.Events.length===5,'4 valid events stored, bogus ignored');
ok(!JSON.stringify(E.sheets.Events).match(/@|\d{10}/),'events hold no personal info');
// save lead
ok(E.post({action:'save_lead',client:'abc-fence',name:'P',phone:'865'}).error==='missing_fields','needs name + phone');
ok(E.post({action:'save_lead',client:'abc-fence',name:'Bot',phone:'8655550100',website:'x'}).id==='ignored','honeypot');
const L=E.post({action:'save_lead',client:'abc-fence',name:'Pat Smith',phone:'(865) 555-0100',service:'Cedar fence',estimateLow:5400,estimateHigh:8200,step:'Contact info',source:'Facebook',state:{svc:'cedar',size:'avg'}});
ok(L.ok&&L.id&&L.key.length===64,'lead saved, private key returned');
ok(!JSON.stringify(E.sheets.Leads).includes(L.key),'key not stored raw');
const L2=E.post({action:'save_lead',client:'abc-fence',id:L.id,key:L.key,name:'Pat Smith',phone:'8655550100',address:'12 Main St',step:'Contact info',source:'Facebook'});
ok(L2.id===L.id&&L2.key===L.key&&E.sheets.Leads.length===2,'update with key: same lead, no duplicate');
ok(E.post({action:'inbox',token:T}).leads.length===0,'fresh lead not shown yet (under 30 min)');
age(L.id,31);
let ib=E.post({action:'inbox',token:T});
ok(ib.leads.length===1&&ib.leads[0].name==='Pat Smith'&&ib.leads[0].step==='Contact info','after 30 quiet minutes: shows as incomplete lead');
ok(E.post({action:'inbox',token:TG}).leads.length===0,'other business never sees it');
ok(/\{link\}/.test(ib.followup),'default follow-up message');
// resume
const R=E.get({action:'resume',c:'abc-fence',t:L.key}); ok(R.ok&&R.lead.address==='12 Main St'&&R.lead.state.includes('cedar'),'resume link returns their saved quote');
ok(E.get({action:'resume',c:'gonzalez',t:L.key}).error==='not_found','resume key bound to business');
// someone else types the same phone, without key: replaces (no merge), new key, old key dead
const X=E.post({action:'save_lead',client:'abc-fence',name:'Imposter',phone:'865-555-0100',step:'Price'});
ok(X.id===L.id&&X.key!==L.key&&E.sheets.Leads.length===2,'same phone without key: same lead, new key (no duplicate)');
ok(E.get({action:'resume',c:'abc-fence',t:L.key}).error==='not_found','old key no longer works');
const RX=E.get({action:'resume',c:'abc-fence',t:X.key}); ok(RX.lead.address===''&&RX.lead.name==='Imposter','nothing from the earlier save leaks to the new key');
// owner ops
age(L.id,40);
const lk=E.post({action:'lead',token:T,id:L.id,op:'link'}); ok(lk.ok&&lk.url.startsWith('https://getpricewink.com/demos/abc-fence/?resume='),'owner gets a fresh resume link for the text');
ok(E.post({action:'lead',token:TG,id:L.id,op:'link'}).error==='not_found','other business cannot touch it');
ok(E.post({action:'lead',token:T,id:L.id,op:'contacted'}).ok&&E.post({action:'inbox',token:T}).leads[0].contactedAt,'mark contacted');
ok(E.post({action:'followup',token:T,text:'Hey {first}! {link}'}).followup==='Hey {first}! {link}','custom follow-up saved');
// booking completes the lead
const s0=E.get({action:'slots',c:'abc-fence'}).days[0].times[0].start;
const bk=E.post({action:'book',client:'abc-fence',slotStart:s0,name:'Pat Smith',phone:'8655550100',address:'12 Main St',job:'Cedar fence',source:'Facebook',leadKey:lk.url.split('resume=')[1]});
ok(bk.ok&&E.post({action:'inbox',token:T}).leads.length===0,'booking removes it from incomplete leads');
const H=E.sheets.Leads[0]; ok(E.sheets.Leads[1][H.indexOf('status')]==='Completed'&&E.sheets.Leads[1][H.indexOf('bookingId')]===bk.id,'lead marked Completed with booking id');
// forget + dnc
const F=E.post({action:'save_lead',client:'abc-fence',name:'Sam Lee',phone:'8655550222',email:'sam@x.com',emailMe:true,estimateLow:300,service:'Gate'});
ok(E.mail.some(m=>m.to==='sam@x.com'&&/resume=/.test(m.htmlBody)&&/Delete my info/.test(m.htmlBody)),'"save this price" emails their own link + delete option');
E.post({action:'forget_lead',client:'abc-fence',t:F.key});
const fr=E.sheets.Leads.find(r=>r[0]===F.id); ok(fr[H.indexOf('name')]===''&&fr[H.indexOf('phone')]===''&&fr[H.indexOf('status')]==='Deleted','"delete my info" wipes it');
const D=E.post({action:'save_lead',client:'abc-fence',name:'Dee',phone:'8655550333'}); age(D.id,45);
E.post({action:'lead',token:T,id:D.id,op:'dnc'}); ib=E.post({action:'inbox',token:T});
const dl=ib.leads.find(l=>l.id===D.id); ok(dl.optOut&&dl.phone===''&&E.post({action:'lead',token:T,id:D.id,op:'link'}).error==='opted_out','"don\'t contact": phone hidden, no follow-up link');
const D2=E.post({action:'save_lead',client:'abc-fence',name:'Dee',phone:'8655550333'}); ok(D2.key==='','opted-out person saving again stays opted out');
// purge
const P=E.post({action:'save_lead',client:'abc-fence',name:'Old Lead',phone:'8655550444'}); age(P.id,31*24*60);
E.ctx.purgeLeads_(); const pr=E.sheets.Leads.find(r=>r[0]===P.id); ok(pr[H.indexOf('status')]==='Expired'&&pr[H.indexOf('name')]==='','30-day-old lead deleted');
E.sheets.Events.splice(1,0,['2020-01-01','abc-fence','visit','x']); E.ctx.purgeEvents_(); ok(!E.sheets.Events.some(r=>r[0]==='2020-01-01'),'old counts purged');
// stats
const st=E.post({action:'inbox',token:T}).stats;
ok(st.visits===2&&st.started===1&&st.contact===1&&st.bookedOnline===1,'funnel: visits, started, contact, booked');
ok(st.bySource[0].source==='Facebook'&&st.bySource[0].bookings===1,'bookings by source');
console.log(fails?fails+' FAILED':'ALL PASSED');
