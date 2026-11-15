/*
 * PriceWink quote-tool kit: lead source, quote-tool counts, unfinished-quote saving and "pick up where you left off".
 * Load it before the site's own script: <script src="../pw-leads.js"></script>, then PWL.init({endpoint, client}).
 *
 * Privacy rules this file keeps:
 *  - Visitors who never type their contact info are only counted (visit / start). No cookies, no IDs, no fingerprinting.
 *  - A quote is saved only after the customer types a name and a 10-digit phone, under a notice the site shows next to the fields.
 *  - The customer's private resume key lives in this browser tab only (sessionStorage), or in the link they were sent.
 * Preview mode (no endpoint): everything stays on this device, so the demo inbox can show it.
 */
(function () {
  'use strict';
  var cfg = { endpoint: '', client: '' }, timer = 0, last = null, inflight = null;
  var SRC_NAMES = { sms: 'Text', text: 'Text', fb: 'Facebook', facebook: 'Facebook', ig: 'Instagram', instagram: 'Instagram', email: 'Email',
    gbp: 'Google', google: 'Google', share: 'Shared link', qr: 'QR code', nextdoor: 'Nextdoor', yelp: 'Yelp', flyer: 'Flyer', truck: 'Truck sign' };

  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function ls(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function digits(v) { return String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function k(name) { return 'pwl_' + cfg.client + '_' + name; }

  /* Where this visit came from: ?src= on a shared link, an ad's utm_source, or the site that sent them. First one wins for the visit. */
  function detectSource() {
    var q = new URLSearchParams(location.search), s = q.get('src') || q.get('utm_source') || '';
    if (s) return SRC_NAMES[s.toLowerCase()] || s.slice(0, 30);
    var h = ''; try { h = new URL(document.referrer).hostname; } catch (e) {}
    if (!h || h === location.hostname) return '';
    return /facebook|fb\.|messenger/.test(h) ? 'Facebook' : /instagram/.test(h) ? 'Instagram' : /google\./.test(h) ? 'Google'
      : /bing|yahoo|duckduckgo/.test(h) ? 'Search' : /nextdoor/.test(h) ? 'Nextdoor' : /yelp/.test(h) ? 'Yelp' : 'Website';
  }
  function source() { return ss(k('src')) || 'Website'; }

  function post(body, beacon) {
    var json = JSON.stringify(Object.assign({ client: cfg.client }, body));
    if (beacon && navigator.sendBeacon) { try { if (navigator.sendBeacon(cfg.endpoint, new Blob([json], { type: 'text/plain;charset=utf-8' }))) return Promise.resolve({ ok: true }); } catch (e) {} }
    return fetch(cfg.endpoint, { method: 'POST', keepalive: !!beacon, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: json }).then(function (r) { return r.json(); });
  }

  /* ---------- counts (no personal info) ---------- */
  function track(ev) {
    if (['visit', 'start', 'contact'].indexOf(ev) < 0 || ss(k('t_' + ev))) return;   // once per visit
    ss(k('t_' + ev), '1');
    if (!cfg.endpoint) { var c = ls('pw_demo_counts_' + cfg.client) || {}; c[ev] = (c[ev] || 0) + 1; ls('pw_demo_counts_' + cfg.client, c); return; }
    post({ action: 'track', event: ev, source: source() }, true).catch(function () {});
  }

  /* ---------- unfinished quotes ---------- */
  function ready(d) { return d && String(d.name || '').trim().length > 1 && digits(d.phone).length === 10; }
  function send(d) {
    var body = Object.assign({ action: 'save_lead', id: ss(k('id')) || '', key: ss(k('key')) || '', source: source() }, d);
    if (!cfg.endpoint) return Promise.resolve(saveDemo(body));
    return post(body).then(function (j) {
      if (j && j.ok && j.id && j.id !== 'ignored') { ss(k('id'), j.id); if (j.key) ss(k('key'), j.key); track('contact'); }
      return j;
    });
  }
  function saveDemo(b) {
    var all = ls('pw_demo_leads') || [], now = new Date().toISOString(), id = b.id || ('DL-' + Date.now().toString(36)), i = -1;
    all.forEach(function (x, n) { if (x.client === cfg.client && (x.id === id || digits(x.phone) === digits(b.phone))) i = n; });
    var row = { id: i >= 0 ? all[i].id : id, client: cfg.client, created: i >= 0 ? all[i].created : now, updated: now, step: b.step || '', name: b.name, phone: b.phone, email: b.email || '',
      address: b.address || '', service: b.service || '', details: b.details || '', estimateLow: b.estimateLow || '', estimateHigh: b.estimateHigh || '', slotLabel: b.slotLabel || '',
      source: b.source, state: typeof b.state === 'string' ? b.state : JSON.stringify(b.state || {}), key: i >= 0 ? all[i].key : 'demo' + Date.now().toString(36) + Math.random().toString(36).slice(2) };
    if (i >= 0) all[i] = row; else all.push(row);
    ls('pw_demo_leads', all.slice(-30)); ss(k('id'), row.id); ss(k('key'), row.key); track('contact');
    return { ok: true, id: row.id, key: row.key };
  }
  /* Saves (debounced) once name + phone are filled in. Call on every input in the contact fields. */
  function save(d) { if (!ready(d)) return; last = d; clearTimeout(timer); timer = setTimeout(flush, 1200); }
  function flush() { if (!last) return inflight || Promise.resolve(null); var d = last; last = null; clearTimeout(timer); inflight = send(d).catch(function () { return null; }); return inflight; }
  /* Saves right away (for a "Save this price" button). Resolves with { ok, id, key } or { ok:false, error }. */
  function saveNow(d) { if (!ready(d)) return Promise.resolve({ ok: false, error: 'missing_fields' }); clearTimeout(timer); last = null; return send(d).catch(function () { return { ok: false, error: 'network' }; }); }
  /* Leaving the page with unsaved typing: send it. */
  addEventListener('pagehide', function () { if (last && cfg.endpoint) { var body = Object.assign({ action: 'save_lead', id: ss(k('id')) || '', key: ss(k('key')) || '', source: source() }, last); last = null; post(body, true); } });

  /* Extra fields for the booking request, so the backend can mark this quote finished and credit the right source. */
  function bookingExtras() { return { source: source(), leadKey: ss(k('key')) || '' }; }
  /* After a booking: forget the saved quote on this device. */
  function done(phone) {
    clearTimeout(timer); last = null;
    if (!cfg.endpoint) { var id = ss(k('id')); ls('pw_demo_leads', (ls('pw_demo_leads') || []).filter(function (x) { return !(x.client === cfg.client && (x.id === id || (phone && digits(x.phone) === digits(phone)))); })); }
    ss(k('id'), null); ss(k('key'), null);
  }

  /* ---------- "pick up where you left off" (?resume=<key>) ---------- */
  function resume() {
    var q = new URLSearchParams(location.search), t = q.get('resume'), forget = q.has('forget');
    if (!t) return Promise.resolve(null);
    q.delete('resume'); q.delete('forget');
    try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); } catch (e) {}
    if (!ss(k('src'))) ss(k('src'), 'Follow-up');
    if (forget) return forgetKey(t).then(function () { return { forgotten: true }; });
    if (!cfg.endpoint) {
      var x = (ls('pw_demo_leads') || []).filter(function (l) { return l.client === cfg.client && l.key === t; })[0];
      if (!x) return Promise.resolve({ expired: true });
      ss(k('id'), x.id); ss(k('key'), x.key); return Promise.resolve({ lead: x });
    }
    return fetch(cfg.endpoint + '?action=resume&c=' + encodeURIComponent(cfg.client) + '&t=' + encodeURIComponent(t)).then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) return { expired: true }; ss(k('id'), j.lead.id); ss(k('key'), t); return { lead: j.lead }; })
      .catch(function () { return null; });
  }
  function forgetKey(t) {
    ss(k('id'), null); ss(k('key'), null);
    if (!cfg.endpoint) { ls('pw_demo_leads', (ls('pw_demo_leads') || []).filter(function (l) { return l.key !== t; })); return Promise.resolve({ ok: true }); }
    return post({ action: 'forget_lead', t: t }).catch(function () { return { ok: false }; });
  }
  /* "Delete my info" for the quote saved in this tab. */
  function forget() { var t = ss(k('key')); return t ? forgetKey(t) : Promise.resolve({ ok: true }); }

  function init(o) {
    cfg.endpoint = o.endpoint || ''; cfg.client = o.client || '';
    var s = detectSource(); if (s && !ss(k('src'))) ss(k('src'), s);
    track('visit');
  }

  window.PWL = { init: init, track: track, save: save, saveNow: saveNow, flush: flush, bookingExtras: bookingExtras, done: done, resume: resume, forget: forget, source: source, hasLead: function () { return !!ss(k('id')); } };
})();
