/**
 * PriceWink Connect: the "Connect Google Calendar" button in the owner inbox opens this.
 *
 * It runs AS THE OWNER (they sign in with Google and tap Allow), and does exactly one thing:
 * shares their main calendar's free/busy (not event details) with the PriceWink account,
 * then tells the booking backend to start reading it. Their jobs then block booking times automatically.
 *
 * Setup: separate Apps Script project, this file + appsscript.json, set MAIN below,
 * Deploy > Web app (Execute as: User accessing the web app, Who has access: Anyone with a Google account).
 * Paste the /exec URL into inbox/index.html as CONNECT.
 */
const MAIN = 'PASTE_BOOKING_BACKEND_EXEC_URL';
const INBOX_BASE = 'https://rydermansell.github.io/demos/inbox/';

function doGet(e) {
  const p = (e && e.parameter) || {}, c = String(p.c || ''), k = String(p.k || '');
  const back = INBOX_BASE + '?c=' + encodeURIComponent(c);
  if (!c || !k) return page_('This link is missing a piece', 'Open Connect from your PriceWink bookings page instead.', back, false);
  try {
    const info = JSON.parse(UrlFetchApp.fetch(MAIN + '?action=connectInfo&c=' + encodeURIComponent(c) + '&key=' + encodeURIComponent(k), { muteHttpExceptions: true }).getContentText());
    if (!info.ok) return page_('This link has expired', 'Open Connect from your PriceWink bookings page instead.', back, false);
    const me = Session.getActiveUser().getEmail();   // a Google account's main calendar id is its email address
    if (!me) return page_('Couldn’t read your Google account', 'Try again, and tap Allow when Google asks.', back + '#' + k, false);
    if (p.undo) {
      try { Calendar.Acl.remove('primary', 'user:' + info.shareWith); } catch (err) {}
      return page_('Sharing turned off', 'PriceWink no longer sees when you’re busy.', back + '#' + k, true);
    }
    try {
      Calendar.Acl.insert({ role: 'freeBusyReader', scope: { type: 'user', value: info.shareWith } }, 'primary', { sendNotifications: false });
    } catch (err) { /* already shared is fine; the backend check below is the real test */ }
    const res = JSON.parse(UrlFetchApp.fetch(MAIN, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
      payload: JSON.stringify({ action: 'connect', client: c, key: k, calendarId: me }) }).getContentText());
    if (!res.ok) return page_('Almost there', 'Google is still setting up the share. Wait a minute, then tap Connect again.', back + '#' + k, false);
    return page_('Calendar connected', 'Anything on ' + me + ' now blocks that time on your booking page. PriceWink only sees when you’re busy, never what the event is.', back + '&connected=1#' + k, true);
  } catch (err) {
    return page_('Something went wrong', 'Try again in a minute. If it keeps happening, text Ryder.', back + '#' + k, false);
  }
}

function page_(title, body, link, good) {
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const html = '' +
    '<style>body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#F4F1EA;color:#0E1B2E;display:grid;place-items:center;min-height:100vh}' +
    '.c{max-width:380px;margin:24px;padding:28px;background:#FFFDF8;border-radius:22px;box-shadow:0 20px 50px -20px rgba(14,27,46,.35);text-align:center}' +
    '.i{width:64px;height:64px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;font-size:30px;color:#fff;background:' + (good ? '#1F9D6B' : '#C2410C') + '}' +
    'h1{margin:0 0 8px;font-size:24px}p{margin:0 0 22px;color:#5B6576}a{display:block;padding:15px;border-radius:14px;background:#0E1B2E;color:#fff;text-decoration:none;font-weight:700}</style>' +
    '<div class="c"><div class="i">' + (good ? '&#10003;' : '!') + '</div><h1>' + esc(title) + '</h1><p>' + esc(body) + '</p>' +
    '<a href="' + esc(link) + '" target="_top">Back to my bookings</a></div>';
  return HtmlService.createHtmlOutput(html).setTitle('PriceWink Connect').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
