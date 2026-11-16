// getpricewink.com demo request form. Run: node backend/test/demo.test.js
const makeEnv=require('./harness'); const E=makeEnv(); let fails=0;
const ok=(c,m)=>{ console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++; };
const base={action:'demo_request',name:'Justin Hale',business:'ABC Fence Co',email:'justin@abc.com',phone:'(865) 555-0101',type:'Fence',interest:'New website with a quote tool',best_time:'Mornings'};
ok(E.post(Object.assign({},base,{email:'nope'})).error==='missing_fields','bad email rejected');
ok(E.post(Object.assign({},base,{business:''})).error==='missing_fields','business required');
ok(E.post(Object.assign({},base,{website_url:'x'})).ok && !E.mail.length,'honeypot: quietly ignored');
const r=E.post(base);
const m=E.mail.find(x=>/^Demo request: ABC Fence Co \(Fence\)$/.test(x.subject));
ok(r.ok && m && m.to==='rj@getpricewink.com' && m.replyTo==='justin@abc.com' && /Mornings/.test(m.htmlBody),'emailed to you, reply goes to them');
const T=E.sheets['Demo requests']; ok(T && T.length===2 && T[1][T[0].indexOf('business')]==='ABC Fence Co','saved on Demo requests tab');
ok(E.post(Object.assign({},base,{name:'=HYPERLINK("x")'})).ok && E.sheets['Demo requests'][2][1]==='=HYPERLINK("x")'.slice(0,80),'stored (formula-safe via cell_)');
console.log(fails?fails+' FAILED':'ALL PASSED');
