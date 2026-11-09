/**
 * PriceWink booking backend (Google Apps Script web app).
 * One deployment serves every PriceWink client. Each client is a row on the "Clients" tab.
 *
 *   GET  ?action=slots&c=<client>            open times for the next two weeks
 *   GET  ?action=inbox&c=<client>&key=<key>  that client's bookings (owner inbox)
 *   POST {action:"book", client, slotStart, ...}       books a time (re-checks it is still free)
 *   POST {action:"status", client, key, id, status}    owner updates a booking from the inbox
 *   POST {action:"block", client, key, start, end, label}  owner blocks time (phone job, day off)
 *   POST {action:"unblock", client, key, eventId}       owner removes a block
 *
 * Open times automatically skip anything on the owner's own calendars: Google calendars shared with this
 * account (free/busy is enough) and private calendar links (iPhone/iCloud, Outlook). See README.md.
 * sendDigests() emails each owner tomorrow's schedule every evening (run installTriggers() once).
 *
 * Bookings land on the "Bookings" tab, on the client's Google Calendar (which the owner sees on
 * their phone), and in the owner's email. The customer gets a confirmation email if they gave one.
 * Setup steps: see README.md next to this file.
 */

const TZ = 'America/New_York';
const DAYS_AHEAD = 14;
const CLIENT_COLS = ['id', 'name', 'ownerEmail', 'ownerSms', 'calendarId', 'days', 'start', 'end', 'slotMinutes', 'leadHours', 'inboxKey', 'active', 'phone', 'site', 'busyCalendars', 'busyIcs', 'digest'];
const BLOCK_PREFIX = 'Blocked: ';
const INBOX_BASE = 'https://rydermansell.github.io/demos/inbox/';
const BOOKING_COLS = ['id', 'created', 'client', 'status', 'slotStart', 'slotLabel', 'service', 'details', 'estimateLow', 'estimateHigh', 'urgent', 'name', 'phone', 'email', 'address', 'notes', 'eventId'];
const STATUSES = ['New', 'Confirmed', 'Done', 'Canceled'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ------------------------------------------------------------------ one-time setup (run from the editor) */

/** Creates the spreadsheet and its tabs. Run once. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss = props.getProperty('SHEET_ID') ? SpreadsheetApp.openById(props.getProperty('SHEET_ID')) : null;
  if (!ss) { ss = SpreadsheetApp.create('PriceWink bookings'); props.setProperty('SHEET_ID', ss.getId()); }
  ensureSheet_(ss, 'Clients', CLIENT_COLS);
  ensureSheet_(ss, 'Bookings', BOOKING_COLS);
  const first = ss.getSheetByName('Sheet1'); if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  installTriggers();   // nightly summary emails + auto-setup of new client rows
  Logger.log('Spreadsheet ready: ' + ss.getUrl());
}

/**
 * Adds a client. Edit the values below and run it once per new client.
 * Creates their bookings calendar and prints the inbox link to give the owner.
 */
function addClient() {
  const c = {
    id: 'gonzalez',                         // short name used in the site and inbox links
    name: 'Gonzalez Tree Service',
    ownerEmail: 'owner@example.com',        // where new-booking emails go
    ownerSms: '',                           // optional: carrier email-to-text address, e.g. 8655551234@vtext.com
    busyCalendars: '',                      // owner's Google calendar(s) shared with this account, comma-separated (usually their Gmail address)
    busyIcs: '',                            // owner's private calendar link(s) from iPhone/iCloud or Outlook, comma-separated
    digest: true,                           // email tomorrow's schedule every evening
    days: 'Mon,Tue,Wed,Thu,Fri,Sat',        // days that take estimate visits
    start: '08:00', end: '17:00',           // first and last start times
    slotMinutes: 60,                        // one visit per hour
    leadHours: 12,                          // no bookings sooner than this
    phone: '(865) 367-4667',
    site: 'https://rydermansell.github.io/demos/gonzalez-tree/',
  };
  const ss = sheet_();
  if (findClient_(c.id)) throw new Error('A client with id "' + c.id + '" already exists. Edit their row on the Clients tab instead.');
  c.active = true;
  ss.getSheetByName('Clients').appendRow(CLIENT_COLS.map(k => c[k] === undefined ? '' : c[k]));
  const done = prepare_(findClient_(c.id), false);
  Logger.log('Added ' + c.name + '.\nOwner inbox link: ' + INBOX_BASE + '?c=' + c.id + '#' + done.inboxKey);
}

/**
 * New client = new row on the Clients tab (by hand, or by Claude through Google Sheets).
 * The first time a row is used (or within 10 minutes, via the trigger) it gets its bookings calendar,
 * that calendar is shared with the owner (they can add jobs to it too), an inbox key if blank,
 * and you get an email with the owner's inbox link. Safe to run any time.
 */
function setupNewClients() {
  const rows = sheet_().getSheetByName('Clients').getDataRange().getValues();
  for (let r = 1; r < rows.length; r++) { const c = findClient_(rows[r][0]); if (c && isOn_(c.active) && (!c.calendarId || !c.inboxKey)) prepare_(c, true); }
}
function prepare_(client, lock) {
  if (!client || (client.calendarId && client.inboxKey)) return client;
  const l = lock ? LockService.getScriptLock() : null;
  if (l) l.waitLock(15000);
  try {
    client = findClient_(client.id);   // re-read inside the lock so two visits can't make two calendars
    if (client.calendarId && client.inboxKey) return client;
    let shared = false;
    if (!client.calendarId) {
      const cal = CalendarApp.createCalendar(client.name + ' bookings', { timeZone: TZ, color: CalendarApp.Color.YELLOW });
      setClientField_(client.id, 'calendarId', cal.getId());
      if (client.ownerEmail) {
        try { Calendar.Acl.insert({ role: 'writer', scope: { type: 'user', value: String(client.ownerEmail).trim() } }, cal.getId(), { sendNotifications: true }); shared = true; } catch (err) {}
      }
    }
    if (!client.inboxKey) setClientField_(client.id, 'inboxKey', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
    const ready = findClient_(client.id), me = Session.getEffectiveUser().getEmail();
    if (me) MailApp.sendEmail({ to: me, subject: 'PriceWink: ' + ready.name + ' is set up',
      body: ready.name + ' is ready to take bookings.\n\nOwner inbox link (send this to them):\n' + INBOX_BASE + '?c=' + ready.id + '#' + ready.inboxKey +
        '\n\nBookings calendar: ' + (shared ? 'created and shared with ' + ready.ownerEmail + '.' : 'created. Share it with the owner in Google Calendar (no owner email on the row, or sharing failed).') +
        '\nSite: ' + (ready.site || '(not set)') + '\nClient id for the site: ' + ready.id });
    return ready;
  } finally { if (l) try { l.releaseLock(); } catch (err) {} }
}

/* ------------------------------------------------------------------ web endpoints */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    let client = findClient_(p.c);
    if (!client || !isOn_(client.active)) return json_({ ok: false, error: 'unknown_client' });
    client = prepare_(client, true);
    if (p.action === 'slots') return json_({ ok: true, tz: TZ, days: openSlots_(client) });
    if (p.action === 'inbox') {
      if (!p.key || p.key !== String(client.inboxKey)) return json_({ ok: false, error: 'bad_key' });
      return json_({ ok: true, name: client.name, bookings: bookingsFor_(client.id), blocks: blocksFor_(client), synced: syncedSources_(client), sources: sources_(client) });
    }
    if (p.action === 'connectInfo') {   // used by the Connect app (connect/Code.gs) before it shares the owner's calendar
      if (!p.key || p.key !== String(client.inboxKey)) return json_({ ok: false, error: 'bad_key' });
      return json_({ ok: true, name: client.name, shareWith: Session.getEffectiveUser().getEmail() });
    }
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) { return json_({ ok: false, error: 'server', detail: String(err) }); }
}

function doPost(e) {
  let d;
  try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    let client = findClient_(d.client);
    if (!client || !isOn_(client.active)) return json_({ ok: false, error: 'unknown_client' });
    client = prepare_(client, false);   // already holding the script lock
    if (d.action === 'status') return json_(setStatus_(client, d));
    if (d.action === 'block') return json_(block_(client, d));
    if (d.action === 'unblock') return json_(unblock_(client, d));
    if (d.action === 'connect') return json_(connect_(client, d));
    if (d.action === 'disconnect') return json_(disconnect_(client, d));
    return json_(book_(client, d));
  } catch (err) {
    return json_({ ok: false, error: 'server', detail: String(err) });
  } finally { try { lock.releaseLock(); } catch (err) {} }
}

/* ------------------------------------------------------------------ booking */

function book_(client, d) {
  const name = clean_(d.name, 80), phone = clean_(d.phone, 30), address = clean_(d.address, 160);
  if (d.website) return { ok: true, id: 'ignored' };                       // honeypot field filled = bot
  if (name.length < 2 || phone.replace(/\D/g, '').length < 10 || address.length < 5) return { ok: false, error: 'missing_fields' };
  const urgent = !!d.urgent;
  let start = null, slotLabel = urgent ? 'Emergency, ASAP' : clean_(d.when, 60) || 'Flexible';
  if (d.slotStart) {
    start = new Date(d.slotStart);
    if (isNaN(start)) return { ok: false, error: 'bad_slot' };
    if (!slotIsOpen_(client, start)) return { ok: false, error: 'slot_taken' };
    slotLabel = label_(start);
  }
  const id = 'B' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const b = {
    id: id, created: new Date(), client: client.id, status: 'New', slotStart: start ? start.toISOString() : '', slotLabel: slotLabel,
    service: clean_(d.job, 60), details: clean_(d.details, 600), estimateLow: Number(d.estimateLow) || '', estimateHigh: Number(d.estimateHigh) || '',
    urgent: urgent ? 'Yes' : '', name: name, phone: phone, email: clean_(d.email, 120), address: address, notes: clean_(d.notes, 600), eventId: ''
  };
  const range = b.estimateLow ? '$' + fmt_(b.estimateLow) + ' to $' + fmt_(b.estimateHigh) : '';
  // calendar event (the slot is held for slotMinutes)
  if (start && client.calendarId) {
    const cal = CalendarApp.getCalendarById(client.calendarId);
    if (cal) {
      const ev = cal.createEvent('Estimate: ' + b.service + ' - ' + name, start, new Date(start.getTime() + Number(client.slotMinutes || 60) * 60000), {
        location: address,
        description: [b.service + (range ? ' (' + range + ')' : ''), b.details, 'Customer: ' + name + ', ' + phone + (b.email ? ', ' + b.email : ''), b.notes ? 'Notes: ' + b.notes : '', 'Booking ' + id + ' via PriceWink'].filter(String).join('\n')
      });
      b.eventId = ev.getId();
    }
  }
  sheet_().getSheetByName('Bookings').appendRow(BOOKING_COLS.map(k => b[k]));
  notifyOwner_(client, b, range);
  if (b.email) notifyCustomer_(client, b);
  return { ok: true, id: id, slotLabel: slotLabel };
}

function notifyOwner_(client, b, range) {
  const inbox = INBOX_BASE + '?c=' + client.id + '#' + client.inboxKey;
  const subject = (b.urgent ? 'EMERGENCY request: ' : 'New booking: ') + b.service + ' - ' + b.slotLabel;
  const rows = [['When', b.slotLabel], ['Job', b.service], ['Estimate', range], ['Details', b.details], ['Name', b.name], ['Phone', b.phone], ['Email', b.email], ['Address', b.address], ['Notes', b.notes]].filter(r => r[1]);
  const html = '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#121a14">' +
    '<h2 style="margin:0 0 12px">' + esc_(subject) + '</h2><table cellpadding="6" style="border-collapse:collapse">' +
    rows.map(r => '<tr><td style="color:#5d6459">' + esc_(r[0]) + '</td><td><b>' + esc_(String(r[1])) + '</b></td></tr>').join('') + '</table>' +
    '<p><a href="tel:' + b.phone.replace(/[^\d+]/g, '') + '">Call ' + esc_(b.name) + '</a> &nbsp;·&nbsp; <a href="https://maps.google.com/?q=' + encodeURIComponent(b.address) + '">Directions</a> &nbsp;·&nbsp; <a href="' + inbox + '">Open your inbox</a></p>' +
    '<p style="color:#8a8f86;font-size:12px">Booking ' + b.id + ' · sent by PriceWink</p></div>';
  if (client.ownerEmail) MailApp.sendEmail({ to: client.ownerEmail, subject: subject, htmlBody: html, replyTo: b.email || undefined, name: 'PriceWink bookings' });
  if (client.ownerSms) MailApp.sendEmail({ to: client.ownerSms, subject: '', body: (b.urgent ? 'EMERGENCY: ' : 'New booking: ') + b.service + ', ' + b.slotLabel + '. ' + b.name + ' ' + b.phone + ', ' + b.address });
}

function notifyCustomer_(client, b) {
  const when = b.slotStart ? 'Your free estimate visit is booked for <b>' + esc_(b.slotLabel) + '</b>.' : 'We got your request and will reach out shortly to set a time.';
  MailApp.sendEmail({
    to: b.email, name: client.name, replyTo: client.ownerEmail || undefined,
    subject: (b.slotStart ? 'You’re booked: ' + b.slotLabel : 'Request received') + ' - ' + client.name,
    htmlBody: '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#121a14"><p>Hi ' + esc_(b.name.split(' ')[0]) + ',</p><p>' + when + '</p>' +
      '<p>Job: ' + esc_(b.service) + '<br>Address: ' + esc_(b.address) + '</p>' +
      '<p>Need to change it? Call or text ' + esc_(client.phone || '') + '.</p><p>' + esc_(client.name) + '</p></div>'
  });
}

function setStatus_(client, d) {
  if (!d.key || d.key !== String(client.inboxKey)) return { ok: false, error: 'bad_key' };
  if (STATUSES.indexOf(d.status) < 0) return { ok: false, error: 'bad_status' };
  const sh = sheet_().getSheetByName('Bookings'), rows = sh.getDataRange().getValues(), H = rows[0];
  const iId = H.indexOf('id'), iC = H.indexOf('client'), iS = H.indexOf('status'), iE = H.indexOf('eventId');
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][iId] === d.id && rows[r][iC] === client.id) {
      sh.getRange(r + 1, iS + 1).setValue(d.status);
      if (d.status === 'Canceled' && rows[r][iE] && client.calendarId) {        // free the slot
        const cal = CalendarApp.getCalendarById(client.calendarId), ev = cal && cal.getEventById(rows[r][iE]);
        if (ev) ev.deleteEvent();
      }
      return { ok: true };
    }
  }
  return { ok: false, error: 'not_found' };
}

/* ------------------------------------------------------------------ availability */

/** Every candidate start time in the window, minus anything already on the client's calendar. */
function openSlots_(client) {
  const now = new Date(), earliest = new Date(now.getTime() + Number(client.leadHours || 12) * 3600000);
  const busy = busy_(client, now, new Date(now.getTime() + (DAYS_AHEAD + 1) * 86400000));
  const out = [];
  candidates_(client, now).forEach(s => {
    if (s < earliest || overlaps_(s, client, busy)) return;
    const key = Utilities.formatDate(s, TZ, 'yyyy-MM-dd');
    let day = out[out.length - 1];
    if (!day || day.date !== key) { day = { date: key, label: Utilities.formatDate(s, TZ, 'EEE MMM d'), times: [] }; out.push(day); }
    day.times.push({ start: s.toISOString(), label: Utilities.formatDate(s, TZ, 'h:mm a') });
  });
  return out;
}

function slotIsOpen_(client, start) {
  const now = new Date();
  if (start.getTime() < now.getTime() + Number(client.leadHours || 12) * 3600000) return false;
  if (!candidates_(client, now).some(s => s.getTime() === start.getTime())) return false;
  return !overlaps_(start, client, busy_(client, new Date(start.getTime() - 86400000), new Date(start.getTime() + 86400000), true));
}

function candidates_(client, now) {
  const days = String(client.days || 'Mon,Tue,Wed,Thu,Fri').split(',').map(s => s.trim().slice(0, 3));
  const step = Number(client.slotMinutes || 60), a = hm_(client.start || '08:00'), b = hm_(client.end || '17:00'), out = [];
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const ymd = Utilities.formatDate(new Date(now.getTime() + i * 86400000), TZ, 'yyyy-MM-dd');
    const dow = DOW[new Date(ymd + 'T12:00:00Z').getUTCDay()];
    if (days.indexOf(dow) < 0) continue;
    for (let m = a; m <= b; m += step) out.push(zoned_(ymd, m));
  }
  return out;
}

function busy_(client, from, to, fresh) {
  const list = [];
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId);
  if (cal) cal.getEvents(from, to).forEach(ev => list.push([ev.getStartTime().getTime(), ev.getEndTime().getTime()]));
  // the owner's own calendars: cached for 5 minutes when listing times, always fresh when booking
  const key = 'ext_' + client.id + '_' + syncVer_(client) + '_' + Math.floor(from.getTime() / 3600000) + '_' + Math.floor(to.getTime() / 3600000);
  const cache = CacheService.getScriptCache(); let ext = !fresh && cache.get(key);
  if (ext) ext = JSON.parse(ext);
  else { ext = googleBusy_(client, from, to).concat(icsBusy_(client, from, to)); try { cache.put(key, JSON.stringify(ext), 300); } catch (e) {} }
  return list.concat(ext);
}

/** Free/busy from the owner's Google calendars that are shared with this account ("See only free/busy" is enough). */
function googleBusy_(client, from, to) {
  const ids = String(client.busyCalendars || '').split(',').map(x => x.trim()).filter(String), out = [];
  if (!ids.length) return out;
  try {   // Advanced Calendar service (enabled in appsscript.json): works with free/busy-only sharing
    const r = Calendar.Freebusy.query({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: ids.map(id => ({ id: id })) });
    Object.keys(r.calendars || {}).forEach(id => (r.calendars[id].busy || []).forEach(b => out.push([new Date(b.start).getTime(), new Date(b.end).getTime()])));
    return out;
  } catch (err) {   // fallback: calendars shared with full details
    ids.forEach(id => { const c = CalendarApp.getCalendarById(id); if (c) c.getEvents(from, to).forEach(ev => out.push([ev.getStartTime().getTime(), ev.getEndTime().getTime()])); });
    return out;
  }
}

/** Busy times from private calendar links (iPhone/iCloud "Public Calendar", Outlook "Publish calendar" .ics). */
function icsBusy_(client, from, to) {
  const urls = String(client.busyIcs || '').split(/[\s,]+/).filter(String), out = [];
  urls.forEach(u => {
    try {
      const res = UrlFetchApp.fetch(u.replace(/^webcal:/i, 'https:'), { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() >= 300) return;
      parseIcs_(res.getContentText(), from.getTime(), to.getTime()).forEach(x => out.push(x));
    } catch (err) {}
  });
  return out;
}

function parseIcs_(text, a, b) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/), out = [];
  let ev = null;
  lines.forEach(line => {
    if (line === 'BEGIN:VEVENT') { ev = { ex: [] }; return; }
    if (line === 'END:VEVENT') { if (ev) expand_(ev, a, b).forEach(x => out.push(x)); ev = null; return; }
    if (!ev) return;
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/); if (!m) return;
    const name = m[1], params = m[2], val = m[3];
    if (name === 'DTSTART') ev.start = icsDate_(val, params);
    else if (name === 'DTEND') ev.end = icsDate_(val, params);
    else if (name === 'DURATION') ev.dur = icsDur_(val);
    else if (name === 'RRULE') ev.rrule = val;
    else if (name === 'EXDATE') val.split(',').forEach(v => ev.ex.push(icsDate_(v, params).t));
    else if (name === 'STATUS') ev.cancelled = /CANCELLED/i.test(val);
    else if (name === 'TRANSP') ev.free = /TRANSPARENT/i.test(val);
  });
  return out;
}
function icsDate_(val, params) {
  const allDay = /VALUE=DATE(?!-)/.test(params) || /^\d{8}$/.test(val);
  const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/); if (!m) return { t: NaN };
  const ymd = m[1] + '-' + m[2] + '-' + m[3];
  if (allDay) return { t: zoned_(ymd, 0).getTime(), allDay: true };
  if (m[7]) return { t: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) };
  const tz = (params.match(/TZID=([^;:]+)/) || [])[1];
  return { t: zonedIn_(ymd, +m[4] * 60 + +m[5], tz || TZ).getTime() };   // floating times are read as the business's time zone
}
function icsDur_(v) { const m = v.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/) || []; return ((+m[1] || 0) * 604800 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000; }
function expand_(ev, a, b) {
  if (!ev.start || isNaN(ev.start.t) || ev.cancelled || ev.free) return [];
  const len = ev.end && !isNaN(ev.end.t) ? ev.end.t - ev.start.t : (ev.dur || (ev.start.allDay ? 86400000 : 3600000));
  const hit = t => (t < b && t + len > a && ev.ex.indexOf(t) < 0) ? [[t, t + len]] : [];
  if (!ev.rrule) return hit(ev.start.t);
  const r = {}; ev.rrule.split(';').forEach(kv => { const p = kv.split('='); r[p[0]] = p[1]; });
  const step = { DAILY: 86400000, WEEKLY: 604800000 }[r.FREQ]; if (!step) return hit(ev.start.t);   // monthly/yearly: first occurrence only
  const interval = (+r.INTERVAL || 1) * step, until = r.UNTIL ? icsDate_(r.UNTIL, '').t : Infinity, count = +r.COUNT || Infinity;
  const days = r.FREQ === 'WEEKLY' && r.BYDAY ? r.BYDAY.split(',').map(d => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(d.slice(-2))) : null;
  const out = []; let n = 0;
  for (let base = ev.start.t; base <= Math.min(b, until) && n < count; base += interval) {
    const starts = days ? days.map(dw => base + ((dw - dayOf_(base) + 7) % 7) * 86400000).sort() : [base];
    for (const t of starts) { if (t < ev.start.t || t > until || n >= count) continue; n++; hit(t).forEach(x => out.push(x)); }
  }
  return out;
}
function dayOf_(t) { return DOW.indexOf(Utilities.formatDate(new Date(t), TZ, 'EEE')); }
function zonedIn_(ymd, minutes, tz) {
  const hh = ('0' + Math.floor(minutes / 60)).slice(-2), mm = ('0' + minutes % 60).slice(-2);
  let t = new Date(ymd + 'T' + hh + ':' + mm + ':00Z');
  for (let k = 0; k < 2; k++) { const shown = Utilities.formatDate(t, tz, "yyyy-MM-dd'T'HH:mm"); t = new Date(t.getTime() - (new Date(shown + ':00Z').getTime() - new Date(ymd + 'T' + hh + ':' + mm + ':00Z').getTime())); }
  return t;
}
function syncedSources_(client) {
  return { google: String(client.busyCalendars || '').split(',').filter(x => x.trim()).length, links: String(client.busyIcs || '').split(/[\s,]+/).filter(String).length };
}

/* ------------------------------------------------------------------ connect the owner's calendar (from the inbox) */

function sources_(client) {
  const g = String(client.busyCalendars || '').split(',').map(x => x.trim()).filter(String)
    .map(id => ({ type: 'google', id: id, label: 'Google Calendar', detail: id }));
  const l = String(client.busyIcs || '').split(/[\s,]+/).filter(String)
    .map(u => ({ type: 'ics', id: u, label: /icloud\.com/i.test(u) ? 'iPhone calendar' : /outlook|office365|live\.com|hotmail/i.test(u) ? 'Outlook calendar' : 'Calendar link', detail: '' }));
  return g.concat(l);
}
/** Google: the Connect app has already shared the owner's calendar (free/busy) with this account; check we can really read it, then save it. iPhone/Outlook: check the link is a real calendar, then save it. */
function connect_(client, d) {
  if (!d.key || d.key !== String(client.inboxKey)) return { ok: false, error: 'bad_key' };
  if (d.calendarId) {
    const id = clean_(d.calendarId, 200).toLowerCase();
    if (!/^[^\s@,]+@[^\s@,]+$/.test(id)) return { ok: false, error: 'bad_calendar' };
    const now = new Date();
    try {
      const r = Calendar.Freebusy.query({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 86400000).toISOString(), items: [{ id: id }] });
      const c = (r.calendars || {})[id];
      if (!c || (c.errors && c.errors.length)) return { ok: false, error: 'not_shared' };
    } catch (err) { return { ok: false, error: 'not_shared' }; }
    addSource_(client, 'busyCalendars', id);
  } else if (d.ics) {
    const url = clean_(d.ics, 600).replace(/^webcal:/i, 'https:');
    if (!/^https:\/\/[^\s,]+$/i.test(url)) return { ok: false, error: 'bad_link' };
    let ok = false;
    try { const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true }); ok = res.getResponseCode() < 300 && /BEGIN:VCALENDAR/.test(res.getContentText().slice(0, 2000)); } catch (err) {}
    if (!ok) return { ok: false, error: 'bad_link' };
    addSource_(client, 'busyIcs', url);
  } else return { ok: false, error: 'missing' };
  const fresh = findClient_(client.id);
  return { ok: true, synced: syncedSources_(fresh), sources: sources_(fresh) };
}
function disconnect_(client, d) {
  if (!d.key || d.key !== String(client.inboxKey)) return { ok: false, error: 'bad_key' };
  const col = d.type === 'google' ? 'busyCalendars' : d.type === 'ics' ? 'busyIcs' : '';
  if (!col) return { ok: false, error: 'missing' };
  const list = String(client[col] || '').split(/[\s,]+/).filter(String), keep = list.filter(x => x.toLowerCase() !== String(d.id || '').toLowerCase());
  if (keep.length === list.length) return { ok: false, error: 'not_found' };
  setClientField_(client.id, col, keep.join(','));
  const fresh = findClient_(client.id);
  return { ok: true, synced: syncedSources_(fresh), sources: sources_(fresh) };
}
function addSource_(client, col, value) {
  const list = String(client[col] || '').split(/[\s,]+/).filter(String);
  if (!list.some(x => x.toLowerCase() === value.toLowerCase())) list.push(value);
  setClientField_(client.id, col, list.join(','));
}
function setClientField_(id, col, value) {
  const sh = sheet_().getSheetByName('Clients'), rows = sh.getDataRange().getValues(), H = rows[0];
  let c = H.indexOf(col);
  if (c < 0) { c = H.length; sh.getRange(1, c + 1).setValue(col); }
  for (let r = 1; r < rows.length; r++) if (String(rows[r][0]) === String(id)) { sh.getRange(r + 1, c + 1).setValue(value); break; }
  const p = PropertiesService.getScriptProperties();   // new version number = the 5-minute busy cache starts fresh
  p.setProperty('sync_' + id, String(Number(p.getProperty('sync_' + id) || 0) + 1));
}
function syncVer_(client) { return PropertiesService.getScriptProperties().getProperty('sync_' + client.id) || '0'; }

/* ------------------------------------------------------------------ owner blocks (phone jobs, days off) */

function block_(client, d) {
  if (!d.key || d.key !== String(client.inboxKey)) return { ok: false, error: 'bad_key' };
  const start = new Date(d.start), end = new Date(d.end);
  if (isNaN(start) || isNaN(end) || end <= start || end - start > 14 * 86400000) return { ok: false, error: 'bad_time' };
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId); if (!cal) return { ok: false, error: 'no_calendar' };
  const ev = cal.createEvent(BLOCK_PREFIX + (clean_(d.label, 80) || 'Busy'), start, end, { description: 'Blocked from the PriceWink inbox' });
  return { ok: true, id: ev.getId() };
}
function unblock_(client, d) {
  if (!d.key || d.key !== String(client.inboxKey)) return { ok: false, error: 'bad_key' };
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId), ev = cal && cal.getEventById(String(d.eventId || ''));
  if (!ev || ev.getTitle().indexOf(BLOCK_PREFIX) !== 0) return { ok: false, error: 'not_found' };
  ev.deleteEvent(); return { ok: true };
}
function blocksFor_(client) {
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId); if (!cal) return [];
  const now = new Date();
  return cal.getEvents(new Date(now.getTime() - 86400000), new Date(now.getTime() + (DAYS_AHEAD + 1) * 86400000))
    .filter(ev => ev.getTitle().indexOf(BLOCK_PREFIX) === 0)
    .map(ev => ({ id: ev.getId(), label: ev.getTitle().slice(BLOCK_PREFIX.length), start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString() }));
}

/* ------------------------------------------------------------------ evening digest */

/** Run once from the editor: emails every owner tomorrow's schedule at 7pm Eastern. */
function installTriggers() {
  ScriptApp.getProjectTriggers().filter(t => ['sendDigests', 'setupNewClients'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('setupNewClients').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('sendDigests').timeBased().atHour(19).everyDays(1).inTimezone(TZ).create();
}
function sendDigests() {
  const rows = sheet_().getSheetByName('Clients').getDataRange().getValues(), H = rows[0];
  for (let r = 1; r < rows.length; r++) { const c = {}; H.forEach((h, i) => c[h] = rows[r][i]); if (isOn_(c.active) && c.ownerEmail && c.digest !== false && !/^(FALSE|NO|OFF)$/i.test(String(c.digest).trim())) digest_(c); }
}
function digest_(client) {
  const now = new Date(), tomorrow = Utilities.formatDate(new Date(now.getTime() + 86400000), TZ, 'yyyy-MM-dd');
  const dayStart = zoned_(tomorrow, 0), dayEnd = new Date(dayStart.getTime() + 86400000);
  const booked = bookingsFor_(client.id).filter(b => b.status !== 'Canceled' && b.slotStart && new Date(b.slotStart) >= dayStart && new Date(b.slotStart) < dayEnd)
    .sort((x, y) => new Date(x.slotStart) - new Date(y.slotStart));
  const blocks = blocksFor_(client).filter(b => new Date(b.start) < dayEnd && new Date(b.end) > dayStart);
  const open = (openSlots_(client).filter(d => d.date === tomorrow)[0] || { times: [] }).times.map(t => t.label);
  const label = Utilities.formatDate(dayStart, TZ, 'EEEE, MMM d'), inbox = INBOX_BASE + '?c=' + client.id + '#' + client.inboxKey;
  const li = (t, x) => '<li style="margin:4px 0"><b>' + esc_(t) + '</b> ' + esc_(x) + '</li>';
  const html = '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#121a14"><h2 style="margin:0 0 6px">Tomorrow: ' + esc_(label) + '</h2>' +
    (booked.length ? '<p style="margin:12px 0 4px"><b>Booked estimates</b></p><ul style="padding-left:18px;margin:0">' + booked.map(b => li(Utilities.formatDate(new Date(b.slotStart), TZ, 'h:mm a'), b.name + ', ' + b.service + ', ' + b.address)).join('') + '</ul>' : '<p>No estimates booked yet.</p>') +
    (blocks.length ? '<p style="margin:12px 0 4px"><b>Blocked</b></p><ul style="padding-left:18px;margin:0">' + blocks.map(b => li(Utilities.formatDate(new Date(b.start), TZ, 'h:mm a'), b.label)).join('') + '</ul>' : '') +
    '<p style="margin:12px 0 4px"><b>Still open to customers</b></p><p style="margin:0">' + (open.length ? esc_(open.join(', ')) : 'Nothing, the day is full.') + '</p>' +
    '<p style="margin:16px 0"><a href="' + inbox + '" style="background:#f5b70f;color:#1a1203;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:700">Booked something by phone? Block it here</a></p>' +
    '<p style="color:#8a8f86;font-size:12px">PriceWink sends this every evening. Anything on your calendar is already blocked automatically.</p></div>';
  MailApp.sendEmail({ to: client.ownerEmail, subject: 'Tomorrow: ' + booked.length + ' booked, ' + open.length + ' open', htmlBody: html, name: 'PriceWink bookings' });
}


function overlaps_(s, client, busy) {
  const a = s.getTime(), b = a + Number(client.slotMinutes || 60) * 60000;
  return busy.some(x => x[0] < b && x[1] > a);
}

/* ------------------------------------------------------------------ helpers */

function sheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Run setup() first.');
  return SpreadsheetApp.openById(id);
}
function ensureSheet_(ss, name, cols) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(cols); sh.setFrozenRows(1); sh.getRange(1, 1, 1, cols.length).setFontWeight('bold'); }
  return sh;
}
function findClient_(id) {
  if (!id) return null;
  const rows = sheet_().getSheetByName('Clients').getDataRange().getValues(), H = rows[0];
  for (let r = 1; r < rows.length; r++) if (String(rows[r][0]) === String(id)) { const o = {}; H.forEach((h, i) => o[h] = rows[r][i]); return o; }
  return null;
}
function bookingsFor_(clientId) {
  const rows = sheet_().getSheetByName('Bookings').getDataRange().getValues(), H = rows[0], out = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][H.indexOf('client')] !== clientId) continue;
    const o = {}; H.forEach((h, i) => { o[h] = rows[r][i] instanceof Date ? rows[r][i].toISOString() : rows[r][i]; }); delete o.eventId; out.push(o);
  }
  return out;
}
/** Wall-clock time in TZ (e.g. 9:00 AM Eastern) as a real Date, correct across daylight-saving changes. */
function zoned_(ymd, minutes) {
  const hh = ('0' + Math.floor(minutes / 60)).slice(-2), mm = ('0' + minutes % 60).slice(-2);
  let t = new Date(ymd + 'T' + hh + ':' + mm + ':00Z');
  for (let k = 0; k < 2; k++) {
    const shown = Utilities.formatDate(t, TZ, "yyyy-MM-dd'T'HH:mm"), want = ymd + 'T' + hh + ':' + mm;
    t = new Date(t.getTime() - (new Date(shown + ':00Z').getTime() - new Date(want + ':00Z').getTime()));
  }
  return t;
}
function hm_(s) { const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : 480; }
function label_(d) { return Utilities.formatDate(d, TZ, "EEE, MMM d 'at' h:mm a"); }
function isOn_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || v === 1; }
function clean_(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
function fmt_(n) { return Number(n).toLocaleString('en-US'); }
function esc_(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
