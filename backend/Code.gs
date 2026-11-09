/**
 * PriceWink booking backend (Google Apps Script web app).
 * One deployment serves every PriceWink client. Each client is a row on the "Clients" tab.
 *
 *   GET  ?action=slots&c=<client>            open times for the next two weeks
 *   GET  ?action=inbox&c=<client>&key=<key>  that client's bookings (owner inbox)
 *   POST {action:"book", client, slotStart, ...}       books a time (re-checks it is still free)
 *   POST {action:"status", client, key, id, status}    owner updates a booking from the inbox
 *
 * Bookings land on the "Bookings" tab, on the client's Google Calendar (which the owner sees on
 * their phone), and in the owner's email. The customer gets a confirmation email if they gave one.
 * Setup steps: see README.md next to this file.
 */

const TZ = 'America/New_York';
const DAYS_AHEAD = 14;
const CLIENT_COLS = ['id', 'name', 'ownerEmail', 'ownerSms', 'calendarId', 'days', 'start', 'end', 'slotMinutes', 'leadHours', 'inboxKey', 'active', 'phone', 'site'];
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
    days: 'Mon,Tue,Wed,Thu,Fri,Sat',        // days that take estimate visits
    start: '08:00', end: '17:00',           // first and last start times
    slotMinutes: 60,                        // one visit per hour
    leadHours: 12,                          // no bookings sooner than this
    phone: '(865) 367-4667',
    site: 'https://rydermansell.github.io/demos/gonzalez-tree/',
  };
  const ss = sheet_();
  if (findClient_(c.id)) throw new Error('A client with id "' + c.id + '" already exists. Edit their row on the Clients tab instead.');
  const cal = CalendarApp.createCalendar(c.name + ' bookings', { timeZone: TZ, color: CalendarApp.Color.YELLOW });
  c.calendarId = cal.getId();
  c.inboxKey = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  c.active = true;
  ss.getSheetByName('Clients').appendRow(CLIENT_COLS.map(k => c[k] === undefined ? '' : c[k]));
  Logger.log('Added ' + c.name + '.\nCalendar: ' + c.calendarId +
    '\nShare that calendar with ' + c.ownerEmail + ' in Google Calendar (Settings > ' + c.name + ' bookings > Share with specific people).' +
    '\nOwner inbox link: https://rydermansell.github.io/demos/inbox/?c=' + c.id + '#' + c.inboxKey);
}

/* ------------------------------------------------------------------ web endpoints */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    const client = findClient_(p.c);
    if (!client || !isOn_(client.active)) return json_({ ok: false, error: 'unknown_client' });
    if (p.action === 'slots') return json_({ ok: true, tz: TZ, days: openSlots_(client) });
    if (p.action === 'inbox') {
      if (!p.key || p.key !== String(client.inboxKey)) return json_({ ok: false, error: 'bad_key' });
      return json_({ ok: true, name: client.name, bookings: bookingsFor_(client.id) });
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
    const client = findClient_(d.client);
    if (!client || !isOn_(client.active)) return json_({ ok: false, error: 'unknown_client' });
    if (d.action === 'status') return json_(setStatus_(client, d));
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
  const inbox = 'https://rydermansell.github.io/demos/inbox/?c=' + client.id + '#' + client.inboxKey;
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
  return !overlaps_(start, client, busy_(client, new Date(start.getTime() - 86400000), new Date(start.getTime() + 86400000)));
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

function busy_(client, from, to) {
  const list = [];
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId);
  if (cal) cal.getEvents(from, to).forEach(ev => list.push([ev.getStartTime().getTime(), ev.getEndTime().getTime()]));
  return list;
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
