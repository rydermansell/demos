/**
 * PriceWink booking backend (Google Apps Script web app).
 * One deployment serves every PriceWink client. Each client is a row on the "Clients" tab.
 *
 * Public (customers):
 *   GET  ?action=slots&c=<client>                    open times for the next two weeks
 *   GET  ?action=auth&c=<client>                     business name for the sign-in screen (nothing private)
 *   POST {action:"book", client, slotStart, ...}     books a time (re-checks it is still free)
 *
 *   POST {action:"track", client, event, source}     quote-tool counts: visit / start / contact (no personal info)
 *   POST {action:"save_lead", client, name, phone, ...}  saves an unfinished quote (after the customer gives name + phone)
 *   GET  ?action=resume&c=<client>&t=<token>          the customer's own saved quote, for their "pick up where you left off" link
 *   POST {action:"forget_lead", client, t}           the customer deletes their saved quote
 *
 * Owner sign-in (no password is ever stored):
 *   POST {action:"login_code", client, email}             emails a 6-digit code (same answer whether or not the email is on file)
 *   POST {action:"login_verify", client, email, code}     code -> device session token
 *   POST {action:"login_google", client, credential}      Google ID token -> device session token
 *   POST {action:"login_invite", client, invite}          one-time setup link -> device session token
 *
 * Owner actions: every one sends {token} and is checked by ownerAction_(). The business is taken from the
 * session, never from the request, so one owner can never reach another business's data.
 *   inbox, photo, status, block, unblock, connect, disconnect, reschedule, add (+ New Job), outcome, connectTicket, signout,
 *   lead (contacted / don't contact / delete / make a resume link), followup (save the follow-up message)
 *
 * Open times automatically skip anything on the owner's own calendars: Google calendars shared with this
 * account (free/busy is enough) and private calendar links (iPhone/iCloud, Outlook). See README.md.
 * sendDigests() emails each owner tomorrow's schedule every evening (run installTriggers() once).
 *
 * Bookings land on the "Bookings" tab, on the client's Google Calendar (which the owner sees on
 * their phone), and in the owner's email. The customer gets a confirmation email if they gave one,
 * an email if the owner cancels or moves the visit, and a reminder the evening before (sendDigests).
 * Setup steps: see README.md next to this file.
 */

const TZ = 'America/New_York';
const DAYS_AHEAD = 14;
const CLIENT_COLS = ['id', 'name', 'ownerEmail', 'ownerSms', 'calendarId', 'days', 'start', 'end', 'slotMinutes', 'leadHours', 'inboxKey', 'active', 'phone', 'site', 'busyCalendars', 'busyIcs', 'digest', 'reviewUrl', 'loginEmails', 'followupText'];
const BLOCK_PREFIX = 'Blocked: ';
const INBOX_BASE = 'https://getpricewink.com/inbox/';
const BOOKING_COLS = ['id', 'created', 'client', 'status', 'slotStart', 'slotLabel', 'service', 'details', 'estimateLow', 'estimateHigh', 'urgent', 'name', 'phone', 'email', 'address', 'notes', 'eventId', 'photos', 'outcome', 'jobValue', 'reminded', 'source'];
const STATUSES = ['New', 'Confirmed', 'Done', 'Canceled'];
const SESSION_COLS = ['tokenHash', 'client', 'email', 'method', 'device', 'created', 'lastSeen', 'expires', 'revoked'];
const LEAD_COLS = ['id', 'client', 'created', 'updated', 'status', 'step', 'name', 'phone', 'email', 'address', 'service', 'details', 'estimateLow', 'estimateHigh', 'slotLabel', 'source', 'state', 'resumeHash', 'resumeExpires', 'bookingId', 'contactedAt', 'optOut'];
const EVENT_COLS = ['date', 'client', 'event', 'source'];
const ABANDON_MINUTES = 30;    // an unfinished quote counts as an incomplete lead after this long with no activity
const LEAD_DAYS = 30;          // incomplete leads (and their contact info) are deleted after this many days without activity
const RESUME_DAYS = 7;         // "pick up where you left off" links work this long
const EVENT_DAYS = 35;         // raw visit counts are kept this long (no personal info in them)
const SESSION_DAYS = 180;      // a signed-in phone stays signed in this long after its last use
const INVITE_HOURS = 72;       // one-time setup links expire after this
const CODE_MINUTES = 10;       // emailed sign-in codes expire after this
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ------------------------------------------------------------------ one-time setup (run from the editor) */

/** Creates the spreadsheet and its tabs. Run once. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  // Uses the spreadsheet this script is attached to (Extensions > Apps Script from inside the
  // "PriceWink bookings" sheet), otherwise the one it set up before, otherwise makes a new one.
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) {}
  if (!ss && props.getProperty('SHEET_ID')) ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  if (!ss) ss = SpreadsheetApp.create('PriceWink bookings');
  props.setProperty('SHEET_ID', ss.getId());
  ensureSheet_(ss, 'Clients', CLIENT_COLS);
  ensureSheet_(ss, 'Bookings', BOOKING_COLS);
  ensureSheet_(ss, 'Sessions', SESSION_COLS);
  ensureSheet_(ss, 'Leads', LEAD_COLS);
  ensureSheet_(ss, 'Events', EVENT_COLS);
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
    reviewUrl: '',                          // their Google "write a review" link, used by the inbox's Ask for a review button
  };
  const ss = sheet_();
  if (findClient_(c.id)) throw new Error('A client with id "' + c.id + '" already exists. Edit their row on the Clients tab instead.');
  c.active = true;
  ss.getSheetByName('Clients').appendRow(CLIENT_COLS.map(k => c[k] === undefined ? '' : cell_(c[k])));
  const done = prepare_(findClient_(c.id), false);
  Logger.log('Added ' + c.name + '.\nOwner inbox link: ' + ownerLink_(done) + '\nOne-time setup link (signs their phone in, ' + INVITE_HOURS + ' hours): ' + makeInvite_(done.id));
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
      body: ready.name + ' is ready to take bookings.\n\nOwner inbox link (they sign in with their email code or Google):\n' + ownerLink_(ready) +
        '\n\nOne-time setup link (signs one phone in without a code; expires in ' + INVITE_HOURS + ' hours, run inviteLink() for a new one):\n' + makeInvite_(ready.id) +
        '\n\nBookings calendar: ' + (shared ? 'created and shared with ' + ready.ownerEmail + '.' : 'created. Share it with the owner in Google Calendar (no owner email on the row, or sharing failed).') +
        '\nSite: ' + (ready.site || '(not set)') + '\nClient id for the site: ' + ready.id });
    return ready;
  } finally { if (l) try { l.releaseLock(); } catch (err) {} }
}

/* ------------------------------------------------------------------ web endpoints */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'connectInfo') {   // used by the Connect app (connect/Code.gs), with a short-lived ticket from the inbox
      const t = ticketAuth_(p.ticket);
      if (!t || t.client !== String(p.c || '')) return json_({ ok: false, error: 'auth' });
      const tc = findClient_(t.client);
      return json_({ ok: true, name: tc ? tc.name : '', shareWith: Session.getEffectiveUser().getEmail() });
    }
    let client = findClient_(p.c);
    if (!client || !isOn_(client.active)) return json_({ ok: false, error: 'unknown_client' });
    client = prepare_(client, true);
    if (p.action === 'slots') return json_({ ok: true, tz: TZ, days: openSlots_(client) });
    if (p.action === 'auth') return json_({ ok: true, name: client.name });
    if (p.action === 'resume') return json_(resumeLead_(client, String(p.t || '')));
    if (p.action === 'ics') {   // calendar subscription for owners on iPhone / Outlook (read-only, its own token)
      if (!p.t || !safeEq_(String(p.t), feedToken_(client))) return ContentService.createTextOutput('Not found').setMimeType(ContentService.MimeType.TEXT);
      return ContentService.createTextOutput(feed_(client)).setMimeType(ContentService.MimeType.ICAL);
    }
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) { console.error(err); return json_({ ok: false, error: 'server' }); }
}

const LOGIN_ACTIONS = { login_code: loginCode_, login_verify: loginVerify_, login_google: loginGoogle_, login_invite: loginInvite_ };
const OWNER_READS = ['inbox', 'photo', 'connectTicket', 'signout'];
const OWNER_WRITES = ['status', 'block', 'unblock', 'connect', 'disconnect', 'reschedule', 'add', 'outcome', 'lead', 'followup'];
const PUBLIC_ACTIONS = { track: track_, save_lead: saveLead_, forget_lead: forgetLead_ };

function doPost(e) {
  let d;
  try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  try {
    const a = String(d.action || 'book');
    if (LOGIN_ACTIONS[a]) return json_(LOGIN_ACTIONS[a](d));
    if (OWNER_READS.indexOf(a) >= 0 || OWNER_WRITES.indexOf(a) >= 0) return json_(ownerAction_(a, d));
    if (PUBLIC_ACTIONS[a]) {
      const pc = findClient_(d.client);
      if (!pc || !isOn_(pc.active)) return json_({ ok: false, error: 'unknown_client' });
      return json_(a === 'track' ? track_(pc, d) : locked_(() => PUBLIC_ACTIONS[a](findClient_(pc.id), d)));
    }
    if (a !== 'book') return json_({ ok: false, error: 'unknown_action' });
    return json_(locked_(() => {
      let client = findClient_(d.client);
      if (!client || !isOn_(client.active)) return { ok: false, error: 'unknown_client' };
      return book_(prepare_(client, false), d);
    }));
  } catch (err) { console.error(err); return json_({ ok: false, error: 'server' }); }
}

/** The one gate for owner actions: a valid session (or, for the Connect app only, a connect ticket) decides the business. */
function ownerAction_(a, d) {
  const auth = (a === 'connect' && d.ticket) ? ticketAuth_(d.ticket) : authOwner_(d.token);
  if (!auth) return { ok: false, error: 'auth' };
  if (d.client && String(d.client) !== auth.client) return { ok: false, error: 'auth' };   // never switch businesses on the browser's word
  let client = findClient_(auth.client);
  if (!client || !isOn_(client.active)) return { ok: false, error: 'auth' };
  client = prepare_(client, true);
  if (a === 'inbox') {
    const bookings = bookingsFor_(client.id);
    return { ok: true, name: client.name, me: auth.email || '', reviewUrl: String(client.reviewUrl || ''), site: String(client.site || ''), bookings: bookings, blocks: blocksFor_(client),
      synced: syncedSources_(client), sources: sources_(client), feed: feedToken_(client), leads: leadsFor_(client.id), followup: followupText_(client), stats: stats_(client.id, bookings) };
  }
  if (a === 'photo') return photo_(client, String(d.id || ''));
  if (a === 'connectTicket') return { ok: true, ticket: makeTicket_(client.id) };
  if (a === 'signout') return signout_(auth, !!d.others);
  return locked_(() => {
    const fresh = findClient_(client.id);   // re-read inside the lock
    if (a === 'status') return setStatus_(fresh, d);
    if (a === 'block') return block_(fresh, d);
    if (a === 'unblock') return unblock_(fresh, d);
    if (a === 'connect') return connect_(fresh, d);
    if (a === 'disconnect') return disconnect_(fresh, d);
    if (a === 'reschedule') return reschedule_(fresh, d);
    if (a === 'add') return addByOwner_(fresh, d);
    if (a === 'outcome') return outcome_(fresh, d);
    if (a === 'lead') return leadOp_(fresh, d);
    if (a === 'followup') { setClientField_(fresh.id, 'followupText', clean_(d.text, 600)); return { ok: true, followup: followupText_(findClient_(fresh.id)) }; }
    return { ok: false, error: 'unknown_action' };
  });
}
function locked_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { try { lock.releaseLock(); } catch (err) {} }
}

/* ------------------------------------------------------------------ owner sign-in */

/** Email a 6-digit code. Always answers the same way, so nobody can test which emails are on file. */
function loginCode_(d) {
  const email = normEmail_(d.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'bad_email' };
  const cache = CacheService.getScriptCache();
  if (!bump_(cache, 'otpN_' + sha_(email), 5, 1800)) return { ok: false, error: 'slow_down' };
  const client = loginClient_(d.client, email);
  if (!client) return { ok: true };
  if (!bump_(cache, 'otpC_' + client.id, 20, 1800)) return { ok: true };
  const code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16) % 1000000).padStart(6, '0');
  cache.put(otpKey_(client.id, email), JSON.stringify({ h: sha_(code + '|' + client.id + '|' + email), n: 0 }), CODE_MINUTES * 60);
  MailApp.sendEmail({
    to: email, name: 'PriceWink', subject: code + ' is your ' + client.name + ' sign-in code',
    htmlBody: '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#0E1B2E"><p>Your code to open the ' + esc_(client.name) + ' bookings inbox:</p>' +
      '<p style="font-size:32px;font-weight:800;letter-spacing:6px;margin:12px 0">' + code + '</p>' +
      '<p style="color:#5F6675">It works for ' + CODE_MINUTES + ' minutes. If you didn’t ask for it, ignore this email. Nobody can sign in without the code.</p></div>'
  });
  return { ok: true };
}
function loginVerify_(d) {
  const email = normEmail_(d.email), code = String(d.code || '').replace(/\D/g, '');
  const client = loginClient_(d.client, email);
  if (!client || code.length !== 6) return { ok: false, error: 'bad_code' };
  const cache = CacheService.getScriptCache(), key = otpKey_(client.id, email), raw = cache.get(key);
  if (!raw) return { ok: false, error: 'expired' };
  const o = JSON.parse(raw);
  if (!safeEq_(o.h, sha_(code + '|' + client.id + '|' + email))) {
    o.n++;
    if (o.n >= 5) { cache.remove(key); return { ok: false, error: 'too_many' }; }
    cache.put(key, JSON.stringify(o), CODE_MINUTES * 60);
    return { ok: false, error: 'bad_code' };
  }
  cache.remove(key);
  return { ok: true, token: createSession_(client.id, email, 'code', d.device), client: client.id, name: client.name };
}
function loginGoogle_(d) {
  const email = verifyGoogle_(String(d.credential || ''));
  if (!email) return { ok: false, error: 'google_failed' };
  const client = loginClient_(d.client, email);
  if (!client) return { ok: false, error: 'not_allowed' };
  return { ok: true, token: createSession_(client.id, email, 'google', d.device), client: client.id, name: client.name };
}
/** One-time setup link (for setting up an owner's phone in person). Used once, then it's dead. */
function loginInvite_(d) {
  const inv = String(d.invite || ''); if (inv.length < 40) return { ok: false, error: 'invite_bad' };
  const h = sha_(inv), sh = tab_('Sessions', SESSION_COLS), rows = sh.getDataRange().getValues(), H = rows[0], now = new Date();
  for (let r = 1; r < rows.length; r++) {
    const o = rowObj_(H, rows[r]);
    if (o.method !== 'invite' || !safeEq_(String(o.tokenHash), h)) continue;
    if (d.client && String(d.client) !== String(o.client)) return { ok: false, error: 'invite_bad' };
    if (o.revoked) return { ok: false, error: 'invite_used' };
    if (new Date(o.expires) < now) return { ok: false, error: 'invite_used' };
    sh.getRange(r + 1, H.indexOf('revoked') + 1).setValue('used ' + Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm'));
    const c = findClient_(o.client); if (!c || !isOn_(c.active)) return { ok: false, error: 'invite_bad' };
    return { ok: true, token: createSession_(c.id, String(o.email || c.ownerEmail || ''), 'setup-link', d.device), client: c.id, name: c.name };
  }
  return { ok: false, error: 'invite_bad' };
}

/** Which business this email may open: the one asked for (if the email is allowed there), or the first business it's allowed on. */
function loginClient_(clientId, email) {
  if (!email) return null;
  if (clientId) { const c = findClient_(clientId); return c && isOn_(c.active) && allowedEmails_(c).indexOf(email) >= 0 ? c : null; }
  const rows = sheet_().getSheetByName('Clients').getDataRange().getValues(), H = rows[0];
  for (let r = 1; r < rows.length; r++) { const c = rowObj_(H, rows[r]); if (isOn_(c.active) && allowedEmails_(c).indexOf(email) >= 0) return c; }
  return null;
}
/** ownerEmail, plus anyone in loginEmails (comma-separated), for example a spouse who answers the phone. */
function allowedEmails_(c) { return [c.ownerEmail].concat(String(c.loginEmails || '').split(',')).map(normEmail_).filter(String); }

function createSession_(clientId, email, method, device) {
  const token = randToken_(), now = new Date();
  const row = { tokenHash: sha_(token), client: clientId, email: email, method: method, device: clean_(device, 40), created: now, lastSeen: now, expires: new Date(now.getTime() + SESSION_DAYS * 86400000), revoked: '' };
  tab_('Sessions', SESSION_COLS).appendRow(SESSION_COLS.map(k => cell_(row[k])));
  return token;
}
/** Checks a device token. Returns { client, email, hash } or null. Cached for 5 minutes; lastSeen is written at most twice a day. */
function authOwner_(token) {
  token = String(token || ''); if (token.length < 40) return null;
  const h = sha_(token), cache = CacheService.getScriptCache(), hit = cache.get('sess_' + h), now = Date.now();
  if (hit) { const o = JSON.parse(hit); if (o.exp > now) return { client: o.c, email: o.e, hash: h }; }
  const sh = tab_('Sessions', SESSION_COLS), rows = sh.getDataRange().getValues(), H = rows[0];
  for (let r = 1; r < rows.length; r++) {
    const o = rowObj_(H, rows[r]);
    if (String(o.tokenHash) !== h || o.method === 'invite') continue;
    if (o.revoked || new Date(o.expires).getTime() < now) return null;
    let exp = new Date(o.expires).getTime();
    if (now - new Date(o.lastSeen).getTime() > 12 * 3600000) {   // rolling: each use pushes the expiry out again
      exp = now + SESSION_DAYS * 86400000;
      sh.getRange(r + 1, H.indexOf('lastSeen') + 1, 1, 2).setValues([[new Date(now), new Date(exp)]]);
    }
    cache.put('sess_' + h, JSON.stringify({ c: String(o.client), e: String(o.email || ''), exp: exp }), 300);
    return { client: String(o.client), email: String(o.email || ''), hash: h };
  }
  return null;
}
/** Sign out this device, or (others) every other device for this business. */
function signout_(auth, others) {
  const sh = tab_('Sessions', SESSION_COLS), rows = sh.getDataRange().getValues(), H = rows[0], cache = CacheService.getScriptCache();
  const iR = H.indexOf('revoked') + 1, stamp = 'signed out ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  let n = 0;
  for (let r = 1; r < rows.length; r++) {
    const o = rowObj_(H, rows[r]);
    if (String(o.client) !== auth.client || o.revoked || o.method === 'invite') continue;
    const mine = String(o.tokenHash) === auth.hash;
    if (others ? mine : !mine) continue;
    sh.getRange(r + 1, iR).setValue(stamp); cache.remove('sess_' + o.tokenHash); n++;
  }
  return { ok: true, signedOut: n };
}
/** Run from the editor: makes a one-time setup link for the client id below (for setting up an owner's phone in person). */
function inviteLink() {
  const id = 'abc-fence';   // <- client id
  Logger.log(makeInvite_(id));
}
function makeInvite_(clientId) {
  const c = findClient_(clientId); if (!c) throw new Error('No client with id ' + clientId);
  const token = randToken_(), now = new Date();
  const row = { tokenHash: sha_(token), client: c.id, email: normEmail_(c.ownerEmail), method: 'invite', device: '', created: now, lastSeen: '', expires: new Date(now.getTime() + INVITE_HOURS * 3600000), revoked: '' };
  tab_('Sessions', SESSION_COLS).appendRow(SESSION_COLS.map(k => cell_(row[k])));
  return INBOX_BASE + '?c=' + encodeURIComponent(c.id) + '#invite=' + token;
}
/** Short-lived ticket the inbox hands to the Connect app, so the owner's session token never goes in a link. */
function makeTicket_(clientId) {
  const t = randToken_(); CacheService.getScriptCache().put('tkt_' + sha_(t), clientId, 900); return t;
}
function ticketAuth_(t) {
  t = String(t || ''); if (t.length < 40) return null;
  const c = CacheService.getScriptCache().get('tkt_' + sha_(t)); return c ? { client: c, email: '', hash: '' } : null;
}
/** Verifies a Google Sign-In ID token (signature, audience, expiry) with Google, and returns the verified email. */
function verifyGoogle_(cred) {
  const cid = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
  if (!cid || cred.length < 100) return null;
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  const t = JSON.parse(r.getContentText());
  if (t.aud !== cid || ['accounts.google.com', 'https://accounts.google.com'].indexOf(t.iss) < 0) return null;
  if (String(t.email_verified) !== 'true' || Number(t.exp) * 1000 < Date.now()) return null;
  return normEmail_(t.email);
}
function ownerLink_(c) { return INBOX_BASE + '?c=' + encodeURIComponent(c.id) + '#start'; }
function otpKey_(clientId, email) { return 'otp_' + sha_(clientId + '|' + email); }
/** Counts an attempt; false once there have been max of them within the window. */
function bump_(cache, key, max, secs) { const n = Number(cache.get(key) || 0); if (n >= max) return false; cache.put(key, String(n + 1), secs); return true; }

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
    urgent: urgent ? 'Yes' : '', name: name, phone: phone, email: clean_(d.email, 120), address: address, notes: clean_(d.notes, 600), eventId: '',
    photos: '', outcome: '', jobValue: '', reminded: '', source: clean_(d.source, 40) || 'Website'
  };
  try { b.photos = savePhotos_(client, id, d.photos).join(','); } catch (err) { b.photos = ''; }   // a photo problem never blocks a booking
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
  appendBooking_(b);
  try { completeLeads_(client.id, b.phone, id, String(d.leadKey || '')); } catch (err) { console.error(err); }   // never blocks a booking
  notifyOwner_(client, b, range);
  if (b.email) notifyCustomer_(client, b);
  return { ok: true, id: id, slotLabel: slotLabel };
}

function notifyOwner_(client, b, range) {
  const inbox = ownerLink_(client);
  const subject = (b.urgent ? 'EMERGENCY request: ' : 'New booking: ') + b.service + ' - ' + b.slotLabel;
  const nPhotos = String(b.photos || '').split(',').filter(String).length;
  const rows = [['When', b.slotLabel], ['Job', b.service], ['Estimate', range], ['Details', b.details], ['Name', b.name], ['Phone', b.phone], ['Email', b.email], ['Address', b.address], ['Notes', b.notes], ['Photos', nPhotos ? nPhotos + ' attached. Open your inbox to see them.' : '']].filter(r => r[1]);
  const html = '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#121a14">' +
    '<h2 style="margin:0 0 12px">' + esc_(subject) + '</h2><table cellpadding="6" style="border-collapse:collapse">' +
    rows.map(r => '<tr><td style="color:#5d6459">' + esc_(r[0]) + '</td><td><b>' + esc_(String(r[1])) + '</b></td></tr>').join('') + '</table>' +
    '<p><a href="tel:' + b.phone.replace(/[^\d+]/g, '') + '">Call ' + esc_(b.name) + '</a> &nbsp;·&nbsp; <a href="https://maps.google.com/?q=' + encodeURIComponent(b.address) + '">Directions</a> &nbsp;·&nbsp; <a href="' + inbox + '">Open your inbox</a></p>' +
    '<p style="color:#8a8f86;font-size:12px">Booking ' + b.id + ' · sent by PriceWink</p></div>';
  if (client.ownerEmail) MailApp.sendEmail({ to: client.ownerEmail, subject: subject, htmlBody: html, replyTo: b.email || undefined, name: 'PriceWink bookings' });
  if (client.ownerSms) MailApp.sendEmail({ to: client.ownerSms, subject: '', body: (b.urgent ? 'EMERGENCY: ' : 'New booking: ') + b.service + ', ' + b.slotLabel + '. ' + b.name + ' ' + b.phone + ', ' + b.address });
}

function notifyCustomer_(client, b) {
  const byOwner = b.details === 'Added by you';
  const when = !b.slotStart ? 'We got your request and will reach out shortly to set a time.'
    : byOwner ? 'You’re on our schedule for <b>' + esc_(b.slotLabel) + '</b>.' : 'Your free estimate visit is booked for <b>' + esc_(b.slotLabel) + '</b>.';
  MailApp.sendEmail({
    to: b.email, name: client.name, replyTo: client.ownerEmail || undefined,
    subject: (b.slotStart ? 'You’re booked: ' + b.slotLabel : 'Request received') + ' - ' + client.name,
    htmlBody: '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#121a14"><p>Hi ' + esc_(b.name.split(' ')[0]) + ',</p><p>' + when + '</p>' +
      '<p>Job: ' + esc_(b.service) + '<br>Address: ' + esc_(b.address) + '</p>' +
      '<p>Need to change it? Call or text ' + esc_(client.phone || '') + '.</p><p>' + esc_(client.name) + '</p></div>'
  });
}

function setStatus_(client, d) {
  if (STATUSES.indexOf(d.status) < 0) return { ok: false, error: 'bad_status' };
  const sh = sheet_().getSheetByName('Bookings'), rows = sh.getDataRange().getValues(), H = rows[0];
  const iId = H.indexOf('id'), iC = H.indexOf('client'), iS = H.indexOf('status'), iE = H.indexOf('eventId');
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][iId] === d.id && rows[r][iC] === client.id) {
      const was = String(rows[r][iS]);
      sh.getRange(r + 1, iS + 1).setValue(d.status);
      let emailed = false;
      if (d.status === 'Canceled' && rows[r][iE] && client.calendarId) {        // free the slot
        const cal = CalendarApp.getCalendarById(client.calendarId), ev = cal && cal.getEventById(rows[r][iE]);
        if (ev) ev.deleteEvent();
      }
      if (d.status === 'Canceled' && was !== 'Canceled') {                      // tell the customer, if they left an email
        const b = {}; H.forEach((k, i) => b[k] = rows[r][i]);
        if (b.email) { try { notifyCanceled_(client, b); emailed = true; } catch (err) { emailed = false; } }
      }
      return { ok: true, emailed: emailed };
    }
  }
  return { ok: false, error: 'not_found' };
}

/** Sent when the owner cancels a booking in the inbox. Plain, apologetic, with a way to pick a new time. */
function notifyCanceled_(client, b) {
  const first = String(b.name || '').split(' ')[0] || 'there';
  const when = b.slotLabel ? 'your estimate visit on <b>' + esc_(String(b.slotLabel)) + '</b>' : 'your estimate visit';
  const rebook = client.site ? '<p><a href="' + esc_(String(client.site)) + '">Pick a new time here</a>' + (client.phone ? ', or call or text ' + esc_(String(client.phone)) + '.' : '.') + '</p>'
                             : (client.phone ? '<p>Call or text ' + esc_(String(client.phone)) + ' to pick a new time.</p>' : '');
  MailApp.sendEmail({
    to: String(b.email), name: client.name, replyTo: client.ownerEmail || undefined,
    subject: 'Your estimate visit was canceled - ' + client.name,
    htmlBody: '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#121a14"><p>Hi ' + esc_(first) + ',</p>' +
      '<p>We’re sorry, we had to cancel ' + when + (b.service ? ' for ' + esc_(String(b.service).toLowerCase()) : '') + '.</p>' + rebook +
      '<p>' + esc_(client.name) + '</p></div>'
  });
}


/* ------------------------------------------------------------------ owner actions from the inbox */

/** Finds one of this client's bookings. Returns { sh, r (0-based row in the data), H, b (the row as an object) } or null. */
function bookingRow_(client, id) {
  const sh = sheet_().getSheetByName('Bookings'), rows = sh.getDataRange().getValues(), H = rows[0];
  const iId = H.indexOf('id'), iC = H.indexOf('client');
  for (let r = 1; r < rows.length; r++) {
    if (rows[r][iId] === id && rows[r][iC] === client.id) { const b = {}; H.forEach((k, i) => b[k] = rows[r][i]); return { sh: sh, r: r, H: H, b: b }; }
  }
  return null;
}
function setCells_(row, values) {
  Object.keys(values).forEach(k => {
    let c = row.H.indexOf(k);
    if (c < 0) { c = row.H.length; row.H.push(k); row.sh.getRange(1, c + 1).setValue(k).setFontWeight('bold'); }
    row.sh.getRange(row.r + 1, c + 1).setValue(cell_(values[k]));
  });
}
/** A time the owner may put a booking on: one of their normal start times, in the future, with nothing else on it. No minimum notice (it is their own schedule). */
function ownerSlotOk_(client, start, ignoreEventId) {
  const now = new Date();
  if (isNaN(start) || start.getTime() <= now.getTime()) return false;
  if (!candidates_(client, now).some(s => s.getTime() === start.getTime())) return false;
  const a = start.getTime(), z = a + Number(client.slotMinutes || 60) * 60000, list = [];
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId);
  if (cal) cal.getEvents(new Date(a - 86400000), new Date(z + 86400000)).forEach(ev => { if (ev.getId() !== ignoreEventId) list.push([ev.getStartTime().getTime(), ev.getEndTime().getTime()]); });
  const ext = googleBusy_(client, new Date(a - 86400000), new Date(z + 86400000)).concat(icsBusy_(client, new Date(a - 86400000), new Date(z + 86400000)));
  return !list.concat(ext).some(x => x[0] < z && x[1] > a);
}
function eventText_(b) {
  const range = b.estimateLow ? '$' + fmt_(b.estimateLow) + ' to $' + fmt_(b.estimateHigh) : '';
  return [String(b.service || '') + (range ? ' (' + range + ')' : ''), b.details, 'Customer: ' + b.name + (b.phone ? ', ' + b.phone : '') + (b.email ? ', ' + b.email : ''), b.notes ? 'Notes: ' + b.notes : '', 'Booking ' + b.id + ' via PriceWink'].filter(String).join('\n');
}

/** Owner moves a booking to another open time. The calendar event moves with it and the customer is emailed the new time. */
function reschedule_(client, d) {
  const row = bookingRow_(client, d.id); if (!row) return { ok: false, error: 'not_found' };
  const b = row.b, start = new Date(d.slotStart);
  if (!ownerSlotOk_(client, start, String(b.eventId || ''))) return { ok: false, error: 'slot_taken' };
  const end = new Date(start.getTime() + Number(client.slotMinutes || 60) * 60000), was = String(b.slotLabel || '');
  let eventId = String(b.eventId || '');
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId);
  if (cal) {
    const ev = eventId && cal.getEventById(eventId);
    if (ev) ev.setTime(start, end);
    else eventId = cal.createEvent('Estimate: ' + (b.service || 'Visit') + ' - ' + b.name, start, end, { location: String(b.address || ''), description: eventText_(b) }).getId();
  }
  const status = (b.status === 'Canceled' || b.status === 'Done' || b.status === 'New') ? 'Confirmed' : String(b.status);
  setCells_(row, { slotStart: start.toISOString(), slotLabel: label_(start), eventId: eventId, status: status, urgent: '', reminded: '' });
  let emailed = false;
  if (b.email) {
    try {
      MailApp.sendEmail({
        to: String(b.email), name: client.name, replyTo: client.ownerEmail || undefined,
        subject: 'New time for your estimate visit: ' + label_(start) + ' - ' + client.name,
        htmlBody: '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#121a14"><p>Hi ' + esc_(String(b.name).split(' ')[0]) + ',</p>' +
          '<p>We moved your estimate visit' + (was ? ' from ' + esc_(was) : '') + ' to <b>' + esc_(label_(start)) + '</b>.</p>' +
          (client.phone ? '<p>If that doesn’t work, call or text ' + esc_(String(client.phone)) + ' and we’ll find another time.</p>' : '') +
          '<p>' + esc_(client.name) + '</p></div>'
      }); emailed = true;
    } catch (err) {}
  }
  return { ok: true, slotStart: start.toISOString(), slotLabel: label_(start), status: status, emailed: emailed };
}

const SOURCES = ['Phone call', 'Text', 'Referral', 'Facebook', 'Website', 'Repeat customer', 'Google', 'Other'];

/**
 * + New Job: the owner enters a job a customer called or texted about. It's a normal booking from then on
 * (call, text, directions, move, cancel, review request, won/lost). Confirmed right away, holds the time online.
 * d: name, phone, email?, address, job, slotStart, anyTime? (a time outside their usual hours), force? (book over
 *    something already on the calendar), price?, notes?, source, notify? (email the customer a confirmation)
 */
function addByOwner_(client, d) {
  const name = clean_(d.name, 80), phone = clean_(d.phone, 30), address = clean_(d.address, 160), job = clean_(d.job, 60);
  if (name.length < 2 || phone.replace(/\D/g, '').length < 10 || address.length < 3 || !job) return { ok: false, error: 'missing_fields' };
  const email = clean_(d.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'bad_email' };
  const start = new Date(d.slotStart);
  const why = ownerTimeProblem_(client, start, '', !!d.anyTime, !!d.force);
  if (why) return { ok: false, error: why };
  const price = Math.round(Number(String(d.price == null ? '' : d.price).replace(/[^\d.]/g, '')));
  const source = SOURCES.indexOf(String(d.source)) >= 0 ? String(d.source) : 'Phone call';
  const id = 'B' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const b = { id: id, created: new Date(), client: client.id, status: 'Confirmed', slotStart: start.toISOString(), slotLabel: label_(start),
    service: job, details: 'Added by you', estimateLow: price > 0 && price < 10000000 ? price : '', estimateHigh: price > 0 && price < 10000000 ? price : '',
    urgent: '', name: name, phone: phone, email: email, address: address, notes: clean_(d.notes, 600), eventId: '', photos: '', outcome: '', jobValue: '', reminded: '', source: source };
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId);
  if (cal) b.eventId = cal.createEvent(b.service + ' - ' + name, start, new Date(start.getTime() + Number(client.slotMinutes || 60) * 60000), { location: b.address, description: eventText_(b) }).getId();
  appendBooking_(b);
  let emailed = false;
  if (email && d.notify) { try { notifyCustomer_(client, b); emailed = true; } catch (err) {} }
  const out = {}; BOOKING_COLS.forEach(k => { if (k !== 'eventId') out[k] = b[k] instanceof Date ? b[k].toISOString() : b[k]; });
  return { ok: true, booking: out, emailed: emailed };
}
/** '' if the owner may put a job at this time, else why not: bad_time (past or invalid), slot_taken (not one of their usual times), busy (something's on the calendar). */
function ownerTimeProblem_(client, start, ignoreEventId, anyTime, force) {
  if (isNaN(start) || start.getTime() <= Date.now() - 5 * 60000 || start.getTime() > Date.now() + 400 * 86400000) return 'bad_time';
  if (!anyTime && !candidates_(client, new Date()).some(s => s.getTime() === start.getTime())) return 'slot_taken';
  if (force) return '';
  const a = start.getTime(), z = a + Number(client.slotMinutes || 60) * 60000, list = [];
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId);
  if (cal) cal.getEvents(new Date(a - 86400000), new Date(z + 86400000)).forEach(ev => { if (ev.getId() !== ignoreEventId) list.push([ev.getStartTime().getTime(), ev.getEndTime().getTime()]); });
  const ext = googleBusy_(client, new Date(a - 86400000), new Date(z + 86400000)).concat(icsBusy_(client, new Date(a - 86400000), new Date(z + 86400000)));
  return list.concat(ext).some(x => x[0] < z && x[1] > a) ? 'busy' : '';
}
/** Adds a booking row by column name, adding any missing column headers first (so older sheets never get misaligned). */
function appendBooking_(b) {
  const sh = sheet_().getSheetByName('Bookings'), H = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  BOOKING_COLS.forEach(k => { if (H.indexOf(k) < 0) { sh.getRange(1, H.length + 1).setValue(k).setFontWeight('bold'); H.push(k); } });
  sh.appendRow(H.map(k => b[k] === undefined || b[k] === null ? '' : cell_(b[k])));
}

/** Owner records how the estimate turned out: 'Won' (with what the job sold for, optional), 'Lost', or '' to clear it. */
function outcome_(client, d) {
  const o = String(d.outcome || ''); if (['Won', 'Lost', ''].indexOf(o) < 0) return { ok: false, error: 'bad_outcome' };
  const row = bookingRow_(client, d.id); if (!row) return { ok: false, error: 'not_found' };
  const v = Math.round(Number(String(d.jobValue == null ? '' : d.jobValue).replace(/[^\d.]/g, '')));
  setCells_(row, { outcome: o, jobValue: o === 'Won' && v > 0 && v < 10000000 ? v : '' });
  return { ok: true };
}

/* ------------------------------------------------------------------ incomplete leads + quote-tool counts */
/*
 * A lead is saved only after the customer has typed their name and phone into the quote tool, under a notice that says
 * the business may follow up about this quote. Visitors who never type their contact info are only counted (visit / start),
 * with no identifier of any kind. Leads are deleted after LEAD_DAYS without activity, or when the customer asks.
 */
const TRACK_EVENTS = ['visit', 'start', 'contact'];

function track_(client, d) {
  const ev = String(d.event || ''); if (TRACK_EVENTS.indexOf(ev) < 0) return { ok: false, error: 'bad_event' };
  if (!bump_(CacheService.getScriptCache(), 'trk_' + client.id + '_' + Math.floor(Date.now() / 60000), 300, 120)) return { ok: true };   // flood guard
  tab_('Events', EVENT_COLS).appendRow([Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), client.id, ev, cell_(cleanSource_(d.source))]);
  return { ok: true };
}
function cleanSource_(s) { s = clean_(s, 40); return s || 'Website'; }

/** Customer side: create or update their unfinished quote. Returns { id, key } (the key is their private resume token). */
function saveLead_(client, d) {
  if (d.website) return { ok: true, id: 'ignored', key: '' };                               // honeypot = bot
  const name = clean_(d.name, 80), phone = clean_(d.phone, 30), digits = phone.replace(/\D/g, '');
  if (name.length < 2 || digits.length < 10) return { ok: false, error: 'missing_fields' };
  const cache = CacheService.getScriptCache();
  if (!bump_(cache, 'lead_' + client.id, 60, 600) || !bump_(cache, 'leadp_' + client.id + digits, 30, 600)) return { ok: false, error: 'slow_down' };
  const email = clean_(d.email, 120), now = new Date();
  const fields = { updated: now, status: 'Open', step: clean_(d.step, 40), name: name, phone: phone, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    address: clean_(d.address, 160), service: clean_(d.service, 60), details: clean_(d.details, 600), estimateLow: Number(d.estimateLow) || '', estimateHigh: Number(d.estimateHigh) || '',
    slotLabel: clean_(d.slotLabel, 60), source: cleanSource_(d.source), state: d.state ? clean_(typeof d.state === 'string' ? d.state : JSON.stringify(d.state), 2000) : '' };
  const sh = tab_('Leads', LEAD_COLS), rows = sh.getDataRange().getValues(), H = rows[0];
  let found = -1, keyOk = false;
  const kh = d.key ? sha_(String(d.key)) : '';
  for (let r = rows.length - 1; r >= 1; r--) {
    const o = rowObj_(H, rows[r]); if (String(o.client) !== client.id || o.status !== 'Open') continue;
    if (kh && safeEq_(String(o.resumeHash), kh) && String(o.id) === String(d.id || '')) { found = r; keyOk = true; break; }
    if (found < 0 && String(o.phone).replace(/\D/g, '') === digits && now - new Date(o.updated) < 14 * 86400000) found = r;
  }
  let key = keyOk ? String(d.key) : randToken_(), id;
  const hashCols = { resumeHash: sha_(key), resumeExpires: new Date(now.getTime() + RESUME_DAYS * 86400000) };
  if (found > 0) {
    const o = rowObj_(H, rows[found]); id = String(o.id);
    if (String(o.optOut) === 'Yes') return { ok: true, id: id, key: '' };   // asked not to be contacted: keep it that way, store nothing new
    // Without the key, this is someone typing the same phone number: replace everything (never merge someone else's saved info) and issue a new key.
    if (keyOk) Object.keys(fields).forEach(k => { if (fields[k] === '') delete fields[k]; });   // their own later save: only fill in what's new
    const row = Object.assign(keyOk ? o : { id: id, client: client.id, created: o.created, bookingId: '', contactedAt: '', optOut: '' }, fields, keyOk ? {} : hashCols);
    sh.getRange(found + 1, 1, 1, H.length).setValues([H.map(h => cell_(row[h] === undefined ? '' : row[h]))]);
  } else {
    id = 'L' + Utilities.formatDate(now, TZ, 'yyMMdd') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const row = Object.assign({ id: id, client: client.id, created: now, bookingId: '', contactedAt: '', optOut: '' }, fields, hashCols);
    appendRowByHeader_(sh, LEAD_COLS, row);
  }
  if (d.emailMe && fields.email && client.site && !keyOk) {   // "Save this price": email them their own link back (once per key)
    try {
      MailApp.sendEmail({ to: fields.email, name: client.name, replyTo: client.ownerEmail || undefined,
        subject: 'Your ' + (fields.service || 'quote') + ' price from ' + client.name,
        htmlBody: '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#121a14"><p>Hi ' + esc_(name.split(' ')[0]) + ',</p>' +
          '<p>Here’s the ' + esc_((fields.service || 'quote').toLowerCase()) + ' price you saved' + (fields.estimateLow ? ': <b>$' + fmt_(fields.estimateLow) + (fields.estimateHigh && fields.estimateHigh !== fields.estimateLow ? ' to $' + fmt_(fields.estimateHigh) : '') + '</b>' : '') + '.</p>' +
          '<p><a href="' + esc_(resumeUrl_(client, key)) + '">Pick a time when you’re ready</a> (this link works for ' + RESUME_DAYS + ' days).</p>' +
          '<p>' + esc_(client.name) + (client.phone ? ' · ' + esc_(String(client.phone)) : '') + '</p>' +
          '<p style="color:#8a8f86;font-size:12px">You got this because you saved a quote on our website. Don’t want us to follow up? <a href="' + esc_(resumeUrl_(client, key) + '&forget=1') + '">Delete my info</a>.</p></div>' });
    } catch (err) { console.error(err); }
  }
  return { ok: true, id: id, key: key };
}
function resumeUrl_(client, key) { const s = String(client.site || ''); return s + (s.indexOf('?') < 0 ? '?' : '&') + 'resume=' + key; }

/** Customer side: their own saved quote, by their private link. */
function resumeLead_(client, t) {
  if (t.length < 40) return { ok: false, error: 'not_found' };
  const row = leadByKey_(client, t); if (!row) return { ok: false, error: 'not_found' };
  const o = row.o;
  return { ok: true, lead: { id: o.id, name: o.name, phone: o.phone, email: o.email, address: o.address, service: o.service, details: o.details, step: o.step, state: String(o.state || '') } };
}
/** Customer side: "Delete my info". Wipes their contact details and marks them as not to be contacted. */
function forgetLead_(client, d) {
  const row = leadByKey_(client, String(d.t || '')); if (!row) return { ok: true };
  wipeLead_(row.sh, row.r, row.H, 'Deleted'); return { ok: true };
}
function leadByKey_(client, t) {
  if (!t || t.length < 40) return null;
  const h = sha_(t), sh = tab_('Leads', LEAD_COLS), rows = sh.getDataRange().getValues(), H = rows[0], now = new Date();
  for (let r = 1; r < rows.length; r++) {
    const o = rowObj_(H, rows[r]);
    if (String(o.client) === client.id && o.status === 'Open' && safeEq_(String(o.resumeHash), h) && new Date(o.resumeExpires) > now) return { sh: sh, r: r, H: H, o: o };
  }
  return null;
}
function wipeLead_(sh, r, H, status) {
  const keep = { id: 1, client: 1, created: 1, source: 1, bookingId: 1 }, row = sh.getRange(r + 1, 1, 1, H.length).getValues()[0];
  sh.getRange(r + 1, 1, 1, H.length).setValues([H.map((h, i) => keep[h] ? row[i] : h === 'status' ? status : h === 'updated' ? new Date() : h === 'optOut' && status === 'Deleted' ? 'Yes' : '')]);
}
/** A booking finishes any open lead with the same phone (and the one whose key came with the booking). */
function completeLeads_(clientId, phone, bookingId, key) {
  const digits = String(phone || '').replace(/\D/g, ''), kh = key ? sha_(key) : '';
  const sh = tab_('Leads', LEAD_COLS), rows = sh.getDataRange().getValues(), H = rows[0];
  for (let r = 1; r < rows.length; r++) {
    const o = rowObj_(H, rows[r]);
    if (String(o.client) !== clientId || o.status !== 'Open') continue;
    if ((digits && String(o.phone).replace(/\D/g, '') === digits) || (kh && safeEq_(String(o.resumeHash), kh))) {
      const set = { status: 'Completed', bookingId: bookingId, updated: new Date(), resumeHash: '' };
      Object.keys(set).forEach(k => sh.getRange(r + 1, H.indexOf(k) + 1).setValue(set[k]));
    }
  }
}
/** Owner side: open leads that have gone quiet for ABANDON_MINUTES. */
function leadsFor_(clientId) {
  const rows = tab_('Leads', LEAD_COLS).getDataRange().getValues(), H = rows[0], cut = Date.now() - ABANDON_MINUTES * 60000, out = [];
  for (let r = 1; r < rows.length; r++) {
    const o = rowObj_(H, rows[r]);
    if (String(o.client) !== clientId || o.status !== 'Open' || new Date(o.updated).getTime() > cut) continue;
    out.push({ id: o.id, created: iso_(o.created), updated: iso_(o.updated), step: o.step, name: o.name, phone: String(o.optOut) === 'Yes' ? '' : o.phone, email: String(o.optOut) === 'Yes' ? '' : o.email,
      address: o.address, service: o.service, details: o.details, estimateLow: o.estimateLow, estimateHigh: o.estimateHigh, slotLabel: o.slotLabel, source: o.source,
      contactedAt: iso_(o.contactedAt), optOut: String(o.optOut) === 'Yes' });
  }
  return out.sort((a, b) => new Date(b.updated) - new Date(a.updated));
}
/** Owner side: contacted | dnc (don't contact) | delete | link (fresh "pick up where you left off" link for a follow-up message). */
function leadOp_(client, d) {
  const sh = tab_('Leads', LEAD_COLS), rows = sh.getDataRange().getValues(), H = rows[0];
  for (let r = 1; r < rows.length; r++) {
    const o = rowObj_(H, rows[r]);
    if (String(o.id) !== String(d.id) || String(o.client) !== client.id || o.status !== 'Open') continue;
    const put = (k, v) => sh.getRange(r + 1, H.indexOf(k) + 1).setValue(v);
    if (d.op === 'contacted') { put('contactedAt', new Date()); return { ok: true }; }
    if (d.op === 'dnc') { put('optOut', 'Yes'); put('resumeHash', ''); return { ok: true }; }
    if (d.op === 'delete') { wipeLead_(sh, r, H, 'Deleted'); return { ok: true }; }
    if (d.op === 'link') {
      if (String(o.optOut) === 'Yes') return { ok: false, error: 'opted_out' };
      if (!client.site) return { ok: true, url: '' };
      const key = randToken_(); put('resumeHash', sha_(key)); put('resumeExpires', new Date(Date.now() + RESUME_DAYS * 86400000));
      return { ok: true, url: resumeUrl_(client, key) };
    }
    return { ok: false, error: 'bad_op' };
  }
  return { ok: false, error: 'not_found' };
}
function followupText_(client) {
  return String(client.followupText || '') || 'Hi {first}, this is {business}. I saw you started a quote for {service} on our website. Want me to get you on the schedule? You can pick up where you left off here: {link}  (Reply STOP and we won’t text again.)';
}
/** Last 30 days: quote-tool funnel and where bookings came from. Counts only, no personal info. */
function stats_(clientId, bookings) {
  const since = Utilities.formatDate(new Date(Date.now() - 29 * 86400000), TZ, 'yyyy-MM-dd'), sinceT = zoned_(since, 0).getTime();
  const c = { visit: 0, start: 0, contact: 0 }, rows = tab_('Events', EVENT_COLS).getDataRange().getValues(), H = rows[0];
  const iD = H.indexOf('date'), iC = H.indexOf('client'), iE = H.indexOf('event');
  for (let r = 1; r < rows.length; r++) {
    const dt = rows[r][iD] instanceof Date ? Utilities.formatDate(rows[r][iD], TZ, 'yyyy-MM-dd') : String(rows[r][iD]);
    if (rows[r][iC] === clientId && dt >= since && c[rows[r][iE]] !== undefined) c[rows[r][iE]]++;
  }
  const recent = bookings.filter(b => new Date(b.created).getTime() >= sinceT && b.status !== 'Canceled');
  const by = {};
  recent.forEach(b => { const s = String(b.source || (b.details === 'Added by you' ? 'Phone call' : 'Website')); by[s] = by[s] || { source: s, bookings: 0, won: 0, wonValue: 0 }; by[s].bookings++;
    if (b.outcome === 'Won') { by[s].won++; by[s].wonValue += Number(b.jobValue) || 0; } });
  const online = recent.filter(b => b.details !== 'Added by you').length;
  return { days: 30, visits: c.visit, started: c.start, contact: c.contact, bookedOnline: online, bySource: Object.keys(by).map(k => by[k]).sort((a, b) => b.bookings - a.bookings) };
}
/** Nightly: delete incomplete leads after LEAD_DAYS quiet, and wipe contact info off finished ones after 7 days (it lives on the booking). */
function purgeLeads_() {
  const sh = tab_('Leads', LEAD_COLS); if (!sh) return;
  const rows = sh.getDataRange().getValues(), H = rows[0], now = Date.now();
  for (let r = 1; r < rows.length; r++) {
    const o = rowObj_(H, rows[r]), age = now - new Date(o.updated).getTime();
    if (o.status === 'Open' && age > LEAD_DAYS * 86400000) wipeLead_(sh, r, H, 'Expired');
    else if (o.status === 'Completed' && o.name && age > 7 * 86400000) wipeLead_(sh, r, H, 'Completed');
  }
}
function purgeEvents_() {
  const sh = tab_('Events', EVENT_COLS); if (!sh) return;
  const rows = sh.getDataRange().getValues(), cut = Utilities.formatDate(new Date(Date.now() - EVENT_DAYS * 86400000), TZ, 'yyyy-MM-dd');
  let n = 0; for (let r = 1; r < rows.length; r++) { const dt = rows[r][0] instanceof Date ? Utilities.formatDate(rows[r][0], TZ, 'yyyy-MM-dd') : String(rows[r][0]); if (dt < cut) n = r; else break; }
  if (n > 0) sh.deleteRows(2, n);   // rows are in date order, so the old ones are all at the top
}
/** A tab by name, created with its headers if it doesn't exist yet (so forgetting to re-run setup() never breaks anything). */
function tab_(name, cols) {
  const ss = sheet_(); let sh = ss.getSheetByName(name);
  if (!sh) {   // take the script lock unless this run already holds it (releasing it here would free the caller's lock too)
    const l = LockService.getScriptLock(), mine = !l.hasLock();
    if (mine) { try { l.waitLock(10000); } catch (e) {} }
    try { sh = ss.getSheetByName(name) || ensureSheet_(ss, name, cols); } finally { if (mine) { try { l.releaseLock(); } catch (e) {} } }
  }
  return sh;
}
function appendRowByHeader_(sh, cols, obj) {
  const H = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  cols.forEach(k => { if (H.indexOf(k) < 0) { sh.getRange(1, H.length + 1).setValue(k).setFontWeight('bold'); H.push(k); } });
  sh.appendRow(H.map(k => obj[k] === undefined || obj[k] === null ? '' : cell_(obj[k])));
}
function iso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }

/* ------------------------------------------------------------------ job photos from the customer */

/** Saves up to 3 photos sent with a booking (data URLs, already shrunk in the browser) to a private Drive folder. Returns their file ids. */
function savePhotos_(client, bookingId, photos) {
  if (!photos || !photos.length) return [];
  const root = DriveApp.getFoldersByName('PriceWink job photos'), folder = root.hasNext() ? root.next() : DriveApp.createFolder('PriceWink job photos');
  const ids = [];
  photos.slice(0, 3).forEach((p, i) => {
    const m = String(p || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m || m[2].length > 1400000) return;   // about 1 MB each at most
    const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], client.id + '-' + bookingId + '-' + (i + 1) + '.' + m[1].split('/')[1].replace('jpeg', 'jpg'));
    ids.push(folder.createFile(blob).getId());
  });
  return ids;
}
/** Only photos listed on one of this client's own bookings can be read, so a file id alone opens nothing. */
function photo_(client, id) {
  if (!id || !bookingsFor_(client.id).some(b => String(b.photos || '').split(',').indexOf(id) >= 0)) return { ok: false, error: 'not_found' };
  const blob = DriveApp.getFileById(id).getBlob();
  return { ok: true, data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
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

/* ------------------------------------------------------------------ bookings in the owner's own calendar app */

/** Read-only token for the calendar feed, derived from the client's internal inboxKey (no longer a login). Changing inboxKey changes the feed link. */
function feedToken_(client) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'feed:' + client.inboxKey);
  return d.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('').slice(0, 24);
}
/** Everything on the client's bookings calendar (bookings, blocked time, jobs they added) from a week ago to 60 days out, as an .ics feed. */
function feed_(client) {
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId), now = new Date();
  const evs = cal ? cal.getEvents(new Date(now.getTime() - 7 * 86400000), new Date(now.getTime() + 60 * 86400000)) : [];
  const t = d => Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PriceWink//Bookings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsText_(client.name + ' bookings'), 'X-WR-TIMEZONE:' + TZ, 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M'];
  evs.forEach(ev => {
    const title = ev.getTitle(), loc = ev.getLocation ? ev.getLocation() : '', desc = ev.getDescription ? ev.getDescription() : '';
    L.push('BEGIN:VEVENT', 'UID:' + icsText_(ev.getId()), 'DTSTAMP:' + t(now), 'DTSTART:' + t(ev.getStartTime()), 'DTEND:' + t(ev.getEndTime()),
      'SUMMARY:' + icsText_(title));
    if (loc) L.push('LOCATION:' + icsText_(loc));
    if (desc) L.push('DESCRIPTION:' + icsText_(desc));
    if (title.indexOf(BLOCK_PREFIX) !== 0) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText_(title), 'TRIGGER:-PT60M', 'END:VALARM');
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.map(icsFold_).join('\r\n') + '\r\n';
}
function icsText_(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold_(line) { let out = '', n = 0; for (const ch of line) { const w = encodeURIComponent(ch).replace(/%[0-9A-F]{2}/g, '.').length; if (n + w > 74) { out += '\r\n '; n = 1; } out += ch; n += w; } return out; }

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
  for (let r = 1; r < rows.length; r++) if (String(rows[r][0]) === String(id)) { sh.getRange(r + 1, c + 1).setValue(cell_(value)); break; }
  const p = PropertiesService.getScriptProperties();   // new version number = the 5-minute busy cache starts fresh
  p.setProperty('sync_' + id, String(Number(p.getProperty('sync_' + id) || 0) + 1));
}
function syncVer_(client) { return PropertiesService.getScriptProperties().getProperty('sync_' + client.id) || '0'; }

/* ------------------------------------------------------------------ owner blocks (phone jobs, days off) */

function block_(client, d) {
  const start = new Date(d.start), end = new Date(d.end);
  if (isNaN(start) || isNaN(end) || end <= start || end - start > 14 * 86400000) return { ok: false, error: 'bad_time' };
  const cal = client.calendarId && CalendarApp.getCalendarById(client.calendarId); if (!cal) return { ok: false, error: 'no_calendar' };
  const ev = cal.createEvent(BLOCK_PREFIX + (clean_(d.label, 80) || 'Busy'), start, end, { description: 'Blocked from the PriceWink inbox' });
  return { ok: true, id: ev.getId() };
}
function unblock_(client, d) {
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

/** Run once from the editor. Every evening at 7pm Eastern: customers with a visit tomorrow get a reminder, and each owner gets tomorrow's schedule. */
function installTriggers() {
  ScriptApp.getProjectTriggers().filter(t => ['sendDigests', 'setupNewClients'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('setupNewClients').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('sendDigests').timeBased().atHour(19).everyDays(1).inTimezone(TZ).create();
}
function sendDigests() {
  try { purgeLeads_(); purgeEvents_(); } catch (err) { console.error(err); }
  const rows = sheet_().getSheetByName('Clients').getDataRange().getValues(), H = rows[0];
  for (let r = 1; r < rows.length; r++) {
    const c = {}; H.forEach((h, i) => c[h] = rows[r][i]); if (!isOn_(c.active)) continue;
    try { remind_(c); } catch (err) {}
    if (c.ownerEmail && c.digest !== false && !/^(FALSE|NO|OFF)$/i.test(String(c.digest).trim())) { try { digest_(c); } catch (err) {} }
  }
}
/** Day-before reminder to each customer with a visit tomorrow who left an email. Sent once per booking time. */
function remind_(client) {
  const now = new Date(), tomorrow = Utilities.formatDate(new Date(now.getTime() + 86400000), TZ, 'yyyy-MM-dd');
  const dayStart = zoned_(tomorrow, 0), dayEnd = new Date(dayStart.getTime() + 86400000);
  bookingsFor_(client.id).forEach(b => {
    if (!b.email || b.reminded || b.status === 'Canceled' || b.status === 'Done' || !b.slotStart) return;
    const t = new Date(b.slotStart); if (t < dayStart || t >= dayEnd) return;
    MailApp.sendEmail({
      to: String(b.email), name: client.name, replyTo: client.ownerEmail || undefined,
      subject: 'Reminder: your estimate visit is tomorrow at ' + Utilities.formatDate(t, TZ, 'h:mm a') + ' - ' + client.name,
      htmlBody: '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#121a14"><p>Hi ' + esc_(String(b.name).split(' ')[0]) + ',</p>' +
        '<p>Just a reminder that we’ll be out <b>' + esc_(label_(t)) + '</b> for your free ' + esc_(String(b.service || 'estimate').toLowerCase()) + ' estimate' + (b.address ? ' at ' + esc_(String(b.address)) : '') + '.</p>' +
        (client.phone ? '<p>Need to change it? Call or text ' + esc_(String(client.phone)) + '.</p>' : '') + '<p>' + esc_(client.name) + '</p></div>'
    });
    const row = bookingRow_(client, b.id); if (row) setCells_(row, { reminded: tomorrow });
  });
}
function digest_(client) {
  const now = new Date(), tomorrow = Utilities.formatDate(new Date(now.getTime() + 86400000), TZ, 'yyyy-MM-dd');
  const dayStart = zoned_(tomorrow, 0), dayEnd = new Date(dayStart.getTime() + 86400000);
  const booked = bookingsFor_(client.id).filter(b => b.status !== 'Canceled' && b.slotStart && new Date(b.slotStart) >= dayStart && new Date(b.slotStart) < dayEnd)
    .sort((x, y) => new Date(x.slotStart) - new Date(y.slotStart));
  const blocks = blocksFor_(client).filter(b => new Date(b.start) < dayEnd && new Date(b.end) > dayStart);
  const open = (openSlots_(client).filter(d => d.date === tomorrow)[0] || { times: [] }).times.map(t => t.label);
  const label = Utilities.formatDate(dayStart, TZ, 'EEEE, MMM d'), inbox = ownerLink_(client);
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
  if (sh.getLastRow() === 0) { sh.appendRow(cols); sh.setFrozenRows(1); sh.getRange(1, 1, 1, cols.length).setFontWeight('bold'); return sh; }
  const H = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];   // an existing sheet: add any missing columns at the end
  cols.filter(c => H.indexOf(c) < 0).forEach(c => sh.getRange(1, sh.getLastColumn() + 1).setValue(c).setFontWeight('bold'));
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
function hm_(s) {
  if (s instanceof Date) return Number(Utilities.formatDate(s, TZ, 'H')) * 60 + Number(Utilities.formatDate(s, TZ, 'm'));   // a cell Sheets turned into a time
  const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : 480; }
function label_(d) { return Utilities.formatDate(d, TZ, "EEE, MMM d 'at' h:mm a"); }
function isOn_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || v === 1; }
function clean_(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
function fmt_(n) { return Number(n).toLocaleString('en-US'); }
function esc_(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
/** Text a customer typed can't become a spreadsheet formula (e.g. a "name" starting with =). */
function cell_(v) { return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v; }
function sha_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join(''); }
/** 64 hex characters from two random UUIDs (about 244 random bits). */
function randToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function safeEq_(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
function normEmail_(e) { return String(e == null ? '' : e).trim().toLowerCase(); }
function rowObj_(H, row) { const o = {}; H.forEach((h, i) => o[h] = row[i]); return o; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
