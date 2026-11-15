const fs=require('fs'), crypto=require('crypto'), vm=require('vm');
function makeEnv(){
  const sheets={}, props={SHEET_ID:'S1',GOOGLE_CLIENT_ID:'gcid.apps.googleusercontent.com'}, cache={}, mail=[], cals={};
  const sheetObj=name=>{ const data=sheets[name]; const api={
    getDataRange:()=>({getValues:()=>data.map(r=>r.slice())}),
    appendRow:row=>{ data.push(row.map(v=>typeof v==='string'&&v[0]==="'"?v.slice(1):v)); },
    getLastRow:()=>data.length, getLastColumn:()=>data[0]?data[0].length:0,
    getRange:(r,c,nr,nc)=>({ setValue:v=>{ while(data.length<r) data.push([]); if(typeof v==='string'&&v[0]==="'") v=v.slice(1); data[r-1][c-1]=v; return {setFontWeight(){}}; },
      setValues:vals=>{ vals.forEach((row,i)=>row.forEach((v,j)=>{ data[r-1+i][c-1+j]=v; })); }, getValues:()=>[data[r-1].slice(c-1,c-1+(nc||1))], setFontWeight(){} }),
    deleteRows:(start,n)=>{ data.splice(start-1,n); }, setFrozenRows(){} }; return api; };
  const ss={getSheetByName:n=>sheets[n]?sheetObj(n):null, insertSheet:n=>{sheets[n]=[];return sheetObj(n);}, getSheets:()=>Object.keys(sheets), getId:()=>'S1'};
  const fmt=(d,tz,pat)=>{ const p=new Intl.DateTimeFormat('en-US',{timeZone:tz==='UTC'?'UTC':tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,weekday:'short'}).formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
    if(p.hour==='24') p.hour='00';
    return pat.replace("'T'",'T').replace(/yyyy|yy|MM|dd|HH|mm|ss|EEE|H|m/g,t=>({yyyy:p.year,yy:p.year.slice(2),MM:p.month,dd:p.day,HH:p.hour,mm:p.minute,ss:p.second,EEE:p.weekday,H:String(+p.hour),m:String(+p.minute)}[t])); };
  const ctx={ console, Date, JSON, Math, String, Number, Object, Array, Error, isNaN, parseInt, encodeURIComponent, RegExp,
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null,setProperty:(k,v)=>{props[k]=v;}})},
    SpreadsheetApp:{openById:()=>ss, getActiveSpreadsheet:()=>ss},
    CacheService:{getScriptCache:()=>({get:k=>k in cache?cache[k]:null,put:(k,v)=>{cache[k]=String(v);},remove:k=>{delete cache[k];}})},
    LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){},hasLock:()=>false})},
    MailApp:{sendEmail:o=>mail.push(o)},
    Session:{getEffectiveUser:()=>({getEmail:()=>'admin@pw.com'})},
    Logger:{log:x=>ctx._log.push(x)}, _log:[],
    Utilities:{getUuid:()=>crypto.randomUUID(), Charset:{UTF_8:'utf8'}, DigestAlgorithm:{SHA_256:'sha256'},
      computeDigest:(a,s)=>[...crypto.createHash('sha256').update(String(s),'utf8').digest()].map(b=>b>127?b-256:b), formatDate:fmt},
    ContentService:{MimeType:{JSON:'json',TEXT:'t',ICAL:'i'},createTextOutput:t=>({_t:t,setMimeType(){return this;}})},
    UrlFetchApp:{fetch:u=>{ const tok=decodeURIComponent(u.split('id_token=')[1]||''); const g=ctx._google[tok]; return {getResponseCode:()=>g?200:400,getContentText:()=>JSON.stringify(g||{})}; }}, _google:{},
    CalendarApp:{getCalendarById:id=>cals[id]||null, createCalendar:()=>({getId:()=>'cal1'}), Color:{YELLOW:1}},
    Calendar:{Acl:{insert(){}}},
  };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(process.argv[2]||require('path').join(__dirname,'..','Code.gs'),'utf8'),ctx);
  // events calendar stub
  const evs=[]; cals.cal1={getEvents:(a,b)=>evs.filter(e=>e.s<b&&e.e>a).map(e=>({getStartTime:()=>e.s,getEndTime:()=>e.e,getId:()=>e.id,getTitle:()=>e.t})),createEvent:(t,s,e)=>{const x={t,s,e,id:'ev'+evs.length};evs.push(x);return {getId:()=>x.id};},getEventById:()=>null};
  sheets.Clients=[vm.runInContext('CLIENT_COLS',ctx).slice()]; sheets.Bookings=[vm.runInContext('BOOKING_COLS',ctx).slice()]; sheets.Sessions=[vm.runInContext('SESSION_COLS',ctx).slice()];
  const addClient=(id,email,extra)=>{ const H=sheets.Clients[0]; const o=Object.assign({id,name:id.toUpperCase(),ownerEmail:email,calendarId:'cal1',inboxKey:'k'+id,active:true,days:'Mon,Tue,Wed,Thu,Fri,Sat',start:'08:00',end:'17:00',slotMinutes:60,leadHours:12},extra||{}); sheets.Clients.push(H.map(h=>o[h]===undefined?'':o[h])); };
  const post=d=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify(d)}})._t);
  const get=p=>{ const r=ctx.doGet({parameter:p})._t; try{return JSON.parse(r);}catch(e){return r;} };
  return {ctx,sheets,cache,mail,addClient,post,get};
}
module.exports=makeEnv;
