// Automatic texts (Twilio). Run: node backend/test/texting.test.js
const makeEnv=require('./harness'); let fails=0;
const ok=(c,m)=>{ console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };

function env(props){
  const E=makeEnv(), sent=[];
  E.ctx.Utilities.base64Encode=s=>Buffer.from(s).toString('base64');
  E.ctx.ScriptApp={getService:()=>({getUrl:()=>'https://script.example/exec'})};
  E.ctx.UrlFetchApp={fetch:(u,o)=>{
    if(/Messages\.json$/.test(u)){ sent.push(Object.assign({auth:o.headers.Authorization},o.payload));
      const bad=o.payload.To==='+18655550666';
      return {getResponseCode:()=>bad?400:201,getContentText:()=>JSON.stringify(bad?{code:21610,message:'unsubscribed'}:{sid:'SM'+sent.length})}; }
    if(/\.mp3$/.test(u)) return {getResponseCode:()=>200,getBlob:()=>({setName(n){this.n=n;return this;}})};
    return {getResponseCode:()=>404,getContentText:()=>'{}'}; }};
  const P=E.ctx.PropertiesService.getScriptProperties(); Object.entries(props||{}).forEach(([k,v])=>P.setProperty(k,v));
  const hook=p=>E.ctx.doPost({parameter:p,postData:{contents:'From=x'}})._t;
  return Object.assign(E,{sent,hook,P});
}
const ON={TWILIO_SID:'AC1',TWILIO_TOKEN:'tok',TEXTING:'on',TWILIO_HOOK_KEY:'hk'};
const ABC={smsNumber:'(865) 555-0900',ownerCell:'865-555-0101',autoTexts:'alerts, missed, incomplete, review',site:'https://abc.example/'};
const slot=E=>E.get({action:'slots',client:'abc-fence'}).days[0].times[0].start;
const book=(E,extra)=>E.post(Object.assign({action:'book',client:'abc-fence',slotStart:slot(E),name:'Pat Smith',phone:'(865) 555-0200',address:'1 Oak St, Kodak',job:'Wood privacy'},extra||{}));

// --- off by default: nothing is sent, booking still works, old email-to-text still works
let E=env({}); E.addClient('abc-fence','owner@abc.com',Object.assign({},ABC,{ownerSms:'8655550101@vtext.com'}));
ok(book(E).ok && E.sent.length===0,'texting off: booking works, no Twilio call');
ok(E.mail.some(m=>m.to==='8655550101@vtext.com'),'texting off: old email-to-text alert still sent');
ok(E.hook({action:'voice',client:'abc-fence',k:'hk',From:'+18655550300'})==='<?xml version="1.0" encoding="UTF-8"?><Response></Response>','texting off: webhook answers empty');

// --- owner alerts
E=env(ON); E.addClient('abc-fence','owner@abc.com',ABC);
const b=book(E,{smsOk:true});
const alert=E.sent.find(s=>s.To==='+18655550101');
ok(b.ok && alert && alert.From==='+18655550900' && /New booking: Wood privacy/.test(alert.Body),'booking texts the owner from the client number');
ok(alert.auth==='Basic '+Buffer.from('AC1:tok').toString('base64'),'Twilio basic auth');
ok(E.sheets.Texts.some(r=>r[3]==='alert'&&r[4]==='sent'&&r[2]==='…0101'),'logged on Texts tab with last 4 digits only');
ok(!E.mail.some(m=>/vtext/.test(m.to)),'no email-to-text when Twilio alerts are on');
let E2=env(ON); E2.addClient('abc-fence','o@x.com',Object.assign({},ABC,{autoTexts:'missed'})); book(E2);
ok(E2.sent.length===0,'alerts not in autoTexts: no owner text');
E2=env(ON); E2.addClient('abc-fence','o@x.com',Object.assign({},ABC,{smsNumber:''})); book(E2);
ok(E2.sent.length===0,'no smsNumber: nothing sent');

// --- missed call
E.sent.length=0;
let x=E.hook({action:'voice',client:'abc-fence',k:'nope',From:'+18655550300'});
ok(!/Say/.test(x) && E.sent.length===0,'wrong webhook key: ignored');
x=E.hook({action:'voice',client:'abc-fence',k:'hk',From:'+18655550300'});
ok(E.sent.length===1 && E.sent[0].To==='+18655550300' && /ABC-FENCE/.test(E.sent[0].Body) && /src=missed/.test(E.sent[0].Body),'missed call: caller gets text with quote link');
ok(/<Say/.test(x) && /just sent you a text/.test(x) && /<Record/.test(x) && /action=voice_done/.test(x) && /action=recording&amp;client=abc-fence&amp;k=hk&amp;from=%2B18655550300/.test(x),'TwiML: greeting + record with callbacks (XML-escaped)');
E.hook({action:'voice',client:'abc-fence',k:'hk',From:'+18655550300'});
ok(E.sent.length===1,'same caller again soon: no second text');
E.hook({action:'voice',client:'abc-fence',k:'hk',From:'+18655550101'});
ok(E.sent.length===1,'owner calling his own number: no text');
x=E.hook({action:'voice',client:'abc-fence',k:'hk',From:'Anonymous'});
ok(E.sent.length===1 && /<Record/.test(x) && !/just sent you a text/.test(x),'blocked caller id: voicemail only');
ok(/<Hangup\/>/.test(E.hook({action:'voice_done',client:'abc-fence',k:'hk'})),'after recording: hang up (no loop)');

// --- voicemail + replies
E.mail.length=0; E.sent.length=0;
E.hook({action:'recording',client:'abc-fence',k:'hk',from:'+18655550300',RecordingUrl:'https://api.twilio.com/rec/RE1',RecordingDuration:'23'});
const vm=E.mail.find(m=>/Voicemail from \(865\) 555-0300 \(0:23\)/.test(m.subject));
ok(vm && vm.to==='owner@abc.com' && vm.attachments && vm.attachments.length===1,'voicemail emailed to owner with the audio');
ok(E.sent.some(s=>s.To==='+18655550101'&&/Voicemail from/.test(s.Body)),'voicemail heads-up text to owner');
E.mail.length=0; E.sent.length=0;
E.hook({action:'sms_in',client:'abc-fence',k:'hk',From:'+18655550300',Body:'Can you come Tuesday? <b>'});
ok(E.mail.some(m=>m.subject==='Text from (865) 555-0300'&&/Can you come Tuesday\? &lt;b&gt;/.test(m.htmlBody)),'customer reply forwarded to owner email (escaped)');
ok(E.sent.some(s=>s.To==='+18655550101'&&/Can you come Tuesday/.test(s.Body)),'customer reply forwarded to owner cell');
E.mail.length=0; E.sent.length=0;
E.hook({action:'sms_in',client:'abc-fence',k:'hk',From:'+18655550300',Body:'STOP'});
ok(!E.mail.length && !E.sent.length,'STOP is left to Twilio');

// --- incomplete quotes
const fmt=E.ctx.Utilities.formatDate, realNow=Date.now;
const atHour=(E,h)=>{ E.ctx.Utilities.formatDate=(d,tz,p)=>p==='H'?String(h):fmt(d,tz,p); };
E.sent.length=0;
E.post({action:'save_lead',client:'abc-fence',name:'Rae Lane',phone:'(865) 555-0400',service:'Chain link',estimateLow:1800,estimateHigh:2400,smsOk:true});
E.post({action:'save_lead',client:'abc-fence',name:'No Box',phone:'(865) 555-0401',service:'Vinyl'});
E.post({action:'save_lead',client:'abc-fence',name:'Opted Out',phone:'(865) 555-0666',service:'Vinyl',smsOk:true});
atHour(E,14); E.ctx.runAutoTexts();
ok(E.sent.length===0,'too fresh (under 30 min): no text yet');
const L=E.sheets.Leads, iU=L[0].indexOf('updated'); L.slice(1).forEach(r=>r[iU]=new Date(realNow()-45*60000));
atHour(E,22); E.ctx.runAutoTexts();
ok(E.sent.length===0,'10 PM: customer texts wait');
atHour(E,14); E.ctx.runAutoTexts();
const rae=E.sent.find(s=>s.To==='+18655550400');
ok(rae && /Hi Rae, this is ABC-FENCE/.test(rae.Body) && /chain link/.test(rae.Body) && /https:\/\/abc\.example\/\?resume=\w{40,}/.test(rae.Body),'ticked the box: follow-up text with a fresh resume link');
ok(!E.sent.some(s=>s.To==='+18655550401'),'did not tick the box: no text');
const iO=L[0].indexOf('optOut'), iT=L[0].indexOf('textedAt');
ok(L.find(r=>/0666/.test(r[L[0].indexOf('phone')]))[iO]==='Yes','Twilio says unsubscribed: lead marked do-not-contact');
const n=E.sent.length; E.ctx.runAutoTexts();
ok(E.sent.length===n,'each lead texted only once');
const resumeKey=rae.Body.match(/resume=(\w+)/)[1];
ok(E.get({action:'resume',client:'abc-fence',t:resumeKey}).ok,'the texted link opens their saved quote');
const T=(()=>{ E.post({action:'login_code',client:'abc-fence',email:'owner@abc.com'}); const code=E.mail.filter(m=>/sign-in code|code/i.test(m.subject)).pop().subject.slice(0,6); return E.post({action:'login_verify',client:'abc-fence',email:'owner@abc.com',code}).token; })();
const ib=E.post({action:'inbox',token:T});
ok(ib.leads.find(l=>l.name==='Rae Lane').textedAt,'inbox shows the lead was auto-texted');
E.post({action:'save_lead',client:'abc-fence',name:'Rae Lane',phone:'(865) 555-0400',smsOk:false});
ok(L.find(r=>/0400/.test(r[L[0].indexOf('phone')]))[L[0].indexOf('smsOk')]==='No','unticking the box is saved');

// --- review texts
E.sent.length=0;
const b2=book(E,{smsOk:true,phone:'(865) 555-0500',slotStart:E.get({action:'slots',client:'abc-fence'}).days[1].times[0].start});
const b3=book(E,{phone:'(865) 555-0501',slotStart:E.get({action:'slots',client:'abc-fence'}).days[1].times[1].start});
E.sent.length=0;
ok(E.post({action:'status',token:T,id:b2.id,status:'Done'}).ok && E.post({action:'status',token:T,id:b3.id,status:'Done'}).ok,'jobs marked Done');
E.ctx.runAutoTexts();
ok(E.sent.length===0,'right after Done: review text waits 2 hours');
const B=E.sheets.Bookings, iD=B[0].indexOf('doneAt'); B.slice(1).forEach(r=>{ if(r[iD]) r[iD]=new Date(realNow()-3*3600000).toISOString(); });
E.ctx.runAutoTexts();
const rv=E.sent.find(s=>s.To==='+18655550500');
ok(rv && /Hi Pat, thanks for choosing ABC-FENCE/.test(rv.Body) && /google\.com\/search\?q=ABC-FENCE/.test(rv.Body),'review text after 2 hours (falls back to Google search link)');
ok(!E.sent.some(s=>s.To==='+18655550501'),'no box ticked: no review text');
E.ctx.runAutoTexts(); ok(E.sent.filter(s=>s.To==='+18655550500').length===1,'review text sent once');

// --- test mode: every text goes to Ryder's phone
E=env(Object.assign({},ON,{TEXT_TEST_TO:'865-555-0999'})); E.addClient('abc-fence','owner@abc.com',ABC);
E.hook({action:'voice',client:'abc-fence',k:'hk',From:'+18655550300'});
ok(E.sent[0].To==='+18655550999' && /^\[TEST for \(865\) 555-0300\]/.test(E.sent[0].Body),'TEXT_TEST_TO: redirected and labeled');

console.log(fails?fails+' FAILED':'ALL PASSED');
