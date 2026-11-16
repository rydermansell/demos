**Start here:** upload `pricewink-bookings.xlsx` to Google Drive, open it with Google Sheets (File > Save as Google Sheets), then open **Extensions > Apps Script** from inside it and follow the setup below there. `setup` uses that spreadsheet (it only creates a new one if the script isn't attached to a sheet).

# PriceWink booking backend

One Google Apps Script web app runs bookings for **every** PriceWink client. It lives in your Google account (free) and:

- serves each client's open estimate times: their hours, minus PriceWink bookings, minus anything on the owner's **own** calendar (Google, iPhone or Outlook, connected by the owner from their inbox), so jobs booked by phone are blocked automatically
- re-checks a time is still free before booking it (no double bookings)
- saves the booking to a Google Sheet, puts it on the client's Google Calendar, and emails the owner (plus an optional text)
- emails the customer a confirmation if they gave an email
- powers the owner inbox (`/demos/inbox/`), where owners call, text, get directions, mark jobs Confirmed / Done / Canceled (canceling frees the time again) and tap **Block time** for anything not on a calendar
- signs owners in securely (email code or Google), one revocable session per phone, and only ever shows a business its own data
- emails each owner a 7 PM "tomorrow" summary (booked jobs, blocked time, open times) with a one-tap link to block anything they forgot

## One-time setup (about 10 minutes)

1. Go to [script.google.com](https://script.google.com) signed in as the PriceWink Google account, click **New project**, name it `PriceWink bookings`.
2. Delete the sample code, paste in all of `Code.gs` from this folder, and save. Then open **Project Settings**, tick **Show "appsscript.json" manifest file in editor**, and replace that file's contents with `appsscript.json` from this folder (it turns on the Calendar API used for free/busy checks and sets the web-app access).
3. In **Project Settings** (gear icon), set the time zone to `(GMT-05:00) Eastern Time`.
4. Pick `setup` in the function menu at the top and click **Run**. Approve the permissions (Sheets, Calendar, Gmail). It creates a spreadsheet called "PriceWink bookings" and schedules the nightly summary emails and new-client setup.
5. Click **Deploy > New deployment**, type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
6. Paste that URL into:
   - each client site: `const BOOKING_ENDPOINT='...'` near the top of the quote tool script
   - `inbox/index.html`: `const API='...'`
7. Owner sign-in is on by default (email codes). For the **Sign in with Google** button, see *Owner sign-in* below.

## Adding a client (no script editor needed)

Add one row to the **Clients** tab (by hand, or Claude does it through the Google Sheets connector):

| column | example | notes |
|---|---|---|
| id | `acme-roof` | lowercase, used in the site and inbox links |
| name | Acme Roofing | |
| ownerEmail | owner@gmail.com | booking alerts; the bookings calendar is shared here |
| ownerSms | 8655551234@vtext.com | optional text alerts |
| days / start / end | `Mon,Tue,Wed,Thu,Fri` / `08:00` / `16:00` | estimate hours (first and last start time) |
| slotMinutes / leadHours | 60 / 12 | |
| active | TRUE | |
| digest | TRUE | 7 PM summary email |
| phone / site | | shown in emails |

Optional column `loginEmails`: other emails that may sign in to this inbox (comma-separated), e.g. a spouse who handles the phone.

Leave `calendarId` and `inboxKey` blank. Within 10 minutes, or the first time the site loads, the backend:
- creates "[name] bookings" calendar and shares it with the owner (they can add jobs to it, which block times too)
- creates the internal key behind the calendar-feed link (it is not a login)
- emails **you** the owner's inbox link (`https://getpricewink.com/inbox/?c=<id>#start`) and a one-time setup link

Then set `CLIENT_ID` (= id) and `BOOKING_ENDPOINT` in the client's site. Hours, emails and calendars can be changed on the row any time, no redeploy.

(`addClient` in the editor still works if you prefer it.)

## Owner sign-in

The inbox link by itself opens nothing. Each phone signs in once and stays signed in (180 days, renewed every time it's used).

- **Email code (always on):** the owner types their email and gets a 6-digit code (10 minutes, 5 tries). Only `ownerEmail` and `loginEmails` on their row can get one. The page gives the same answer for any email, so nobody can test which emails are on file.
- **Sign in with Google (optional):** owners tap the Google button. The backend checks the Google token with Google and that the email is on their row.
- **One-time setup link (for setting up a phone in person):** sent to you when a client is set up, or run `inviteLink()` in the editor (set the id inside it). It works once, for 72 hours. On an iPhone it first shows how to add Bookings to the Home Screen, then signs in from the Home Screen icon, because iPhones keep Home Screen apps signed in separately from Safari.
- **Sign out:** at the bottom of the inbox (this phone, or every other phone).
- **Cut off a device yourself:** on the **Sessions** tab, type anything in its `revoked` cell. It stops working within 5 minutes. To lock out every phone for a business, revoke all its rows.
- No passwords are stored anywhere. The Sessions tab stores only a scrambled fingerprint of each phone's token, so the sheet itself can't be used to sign in.
- Every owner request is checked on the server, and the business is taken from the sign-in, never from the link or the request.

### Turning on the Google button (one time, about 10 minutes)

1. [console.cloud.google.com](https://console.cloud.google.com), signed in as the PriceWink Google account. Create a project (or use the one Apps Script made), then **APIs & Services > OAuth consent screen**: External, app name **PriceWink**, support email, and `getpricewink.com` as an authorized domain. Only the basic scopes (email, profile, openid) are used, so no Google review is needed.
2. **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**. Under **Authorized JavaScript origins** add `https://getpricewink.com`. Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).
3. Apps Script editor > **Project Settings > Script properties > Add**: `GOOGLE_CLIENT_ID` = that Client ID.
4. `inbox/index.html`: paste the same Client ID into `const GOOGLE_ID='...'`.

Google sign-in inside an iPhone Home Screen app can be fussy (it opens a pop-up). If it ever fails for an owner, the email code right below it always works.

### Tests

`node backend/test/auth.test.js` runs the backend in a fake Apps Script environment and checks the security rules (wrong codes, other businesses, forged and expired tokens, setup links, sign-out, formula-safe cells). Run it after any change to `Code.gs`.

## Bookings in the owner's calendar app (iPhone, Outlook, anything)

Gmail owners see the "[name] bookings" Google Calendar automatically (it's shared with them). Everyone else opens **Connect your calendar** in their inbox and taps **iPhone** or **Outlook** under "See bookings in your phone's calendar" (or **Copy link** for any other app). That subscribes their calendar app to a private, read-only feed (`?action=ics&client=<id>&t=<token>`) with every booking and blocked time, plus a 1-hour reminder before each estimate. iPhone checks for changes about every 15 minutes (owners can set this under Settings > Calendar > Accounts > Fetch); Outlook every few hours. The feed link can't open the inbox. Changing a client's `inboxKey` gives them a new feed link (the old one stops working).

## Connecting the owner's calendar (auto-blocking)

Anything on the owner's own calendar becomes unavailable on their booking page within about 5 minutes. Only busy/free is read, never event titles.

**Owners do this themselves, optionally, from their inbox.** The inbox shows a "Connect your calendar" card. Tapping it offers:

- **Google Calendar:** one button. They sign in, tap Allow, and land back in the inbox with "Synced with Google Calendar". (This uses the Connect app below.)
- **iPhone calendar** and **Outlook:** 3 short steps shown right there, then they tap Paste and Connect. The backend checks the link is a real calendar before saving it.

They can see what's connected and tap **Disconnect** any time under **Manage**. Owners who skip it still have **Block time** and the 7 PM summary email.

You can also fill the columns by hand on the Clients tab: `busyCalendars` (Google calendar addresses shared with the PriceWink account as "See only free/busy") and `busyIcs` (calendar links), comma-separated.

### One-time setup: the Connect app (for the Google button)

The Google button needs a second small Apps Script project, because it has to run as the *owner* (to share their calendar) instead of as you.

1. [script.google.com](https://script.google.com) > **New project**, name it `PriceWink Connect`.
2. Paste in `connect/Code.gs`. Show the manifest (Project Settings > Show "appsscript.json") and replace it with `connect/appsscript.json`.
3. Set `MAIN` at the top of the code to the booking backend's `/exec` URL.
4. **Deploy > New deployment > Web app**: Execute as **User accessing the web app**, Who has access **Anyone with a Google account**. Copy the `/exec` URL.
5. In `inbox/index.html`, paste it into `const CONNECT='...'`. (Empty = the Google button is hidden; the iPhone/Outlook options still work.)
6. Optional: in Google Cloud's **OAuth consent screen** for this project, set the app name to "PriceWink Connect" and add a support email and logo, so the sign-in screen looks right.

What owners see: Google sign-in, then possibly **"Google hasn't verified this app"** (normal until you apply for verification; the inbox tells them to tap **Advanced > Go to PriceWink Connect**), then an Allow screen asking to manage calendar sharing. Unverified apps are limited to 100 users; before that, apply for verification in the Google Cloud console (free; needs a privacy policy page on getpricewink.com and takes a few weeks).

The Connect app only adds one sharing rule ("PriceWink can see when I'm busy") on their main calendar. Opening it with `&undo=1` added to the link removes that rule. Owners can also remove it in Google Calendar under Settings > Share with specific people.

If Google ever rejects the `calendar.acls` scope in the manifest, replace it with `https://www.googleapis.com/auth/calendar`.

## Updating the code

After editing `Code.gs`: **Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy**. The URL stays the same.

## Notes

- Free Gmail accounts can send about 100 emails a day through Apps Script; Google Workspace accounts get 1,500. Each booking sends 1 to 3 emails.
- Text alerts use the carrier's email-to-text address (for example `8655551234@vtext.com` for Verizon). Some carriers have been phasing these out; email always works.
- Preview mode: when `BOOKING_ENDPOINT` is empty, the site uses sample times and saves bookings only on that device, and `/demos/inbox/?c=<client>&demo` shows them. That's for showing prospects the full loop before they sign up.

## Google review link (Nov 15, 2026)

"Ask for a review" and the after-the-job text include a link that opens the business's Google listing with the review box already open. Put it in the client's `reviewUrl` column: either their own review link from Google Business Profile (Home > "Ask for reviews" > copy link, looks like `g.page/r/.../review`), or just their Google **Place ID** (`ChIJ...`). The Place ID becomes `https://search.google.com/local/writereview?placeid=...`. With nothing set, the text links to a Google search for the business, where "Write a review" is one tap away. Demo inboxes use the Place IDs in the inbox's `CLIENTS` list.

## Emails come from rj@getpricewink.com (Nov 15, 2026)

All emails (sign-in codes, booking alerts, customer confirmations, reminders) are sent from `MAIL_FROM` (top of `Code.gs`) using Gmail's "Send mail as". The address must be listed in this Gmail account under Settings > Accounts > Send mail as. If it isn't, emails still go out from the Gmail address. After pasting, run `setup` once and click **Allow** (Gmail asks for send-as permission), then publish a new version.

## Hosting (Nov 15, 2026)

- **app.getpricewink.com** = this repo on **Cloudflare Pages** (project `pricewink-app`, free: unlimited bandwidth and requests, commercial use OK). Every push to `main` publishes automatically. Owner inboxes live at `app.getpricewink.com/inbox/?c=<id>#start`; live client sites go here too (each client's own domain gets added to the `pricewink-app` project's Custom domains, with a CNAME at their DNS).
- **rydermansell.github.io/demos** = the same repo on GitHub Pages, for prospect demos only (GitHub Pages doesn't allow running a business on it).
- **www.getpricewink.com** = the marketing site on **Cloudflare Pages** (project `pricewink`, repo `PriceWink`; moved off Netlify Nov 15, 2026). Every push to `main` publishes, free. The plain `getpricewink.com` forwards to www (Porkbun URL forwarding, 301, keeps the path). Its `/demos/*` and `/inbox` links redirect to app.getpricewink.com. The demo request form posts to this backend (`demo_request`, Demo requests tab). Netlify is no longer used.
- DNS for getpricewink.com is at **Porkbun** (`app` is a CNAME to `pricewink-app.pages.dev`, `www` to `pricewink.pages.dev`; email MX/Brevo records untouched).

## Fix: "Page Not Found" from the backend (Nov 15, 2026)

Apps Script reserves the URL parameter names `c` and `sid`; using them makes Google answer "Sorry, unable to open the file at this time" (Page Not Found). Every request now uses `?client=` instead (the backend still accepts old `?c=` links as a fallback). After pasting the new `Code.gs` (and `connect/Code.gs`), publish a new version. Rule for future code: never name a web-app parameter `c` or `sid`.

## What's new: share link, results, incomplete leads (Nov 15, 2026)

Paste the new `Code.gs`, then **Deploy > Manage deployments > edit > New version > Deploy**. The **Leads** and **Events** tabs create themselves. Tests: `node backend/test/leads.test.js`.

**In the owner inbox**
- **Share your booking link** (header): Share / Text / Email / Facebook / Google profile / Copy. Each adds `?src=` to the client's `site` link, so bookings show where they came from. The `site` column on the Clients tab must hold the client's live quote page.
- **Results** (header, or tap the month line): last 30 days of quote-tool visits, quotes started, contact info given and online bookings, plus bookings and won dollars by source.
- **Incomplete leads** (yellow banner): people who typed their name and phone, then went 30 minutes without booking. Shows what they picked, the price, when they started and the step where they stopped. Call / Text / Email with the owner's own follow-up message (editable; `{first} {service} {price} {link} {business}`), where `{link}` is a fresh "pick up where you left off" link. Plus Mark contacted / Don't contact / Delete. Booking removes them automatically. Saved per client in the `followupText` column.

**On the client's site** (`pw-leads.js`, shared by every site)
- Records where each visit came from (`?src=`, `utm_source`, or the site that sent them) and counts visit / start / contact. Counts have no personal info: no cookies, no IDs.
- Saves the unfinished quote once the customer types a name and a 10-digit phone, under a notice next to the fields. Updates are deduplicated by phone number. Someone typing a phone number that's already saved replaces that saved info instead of seeing it.
- **Not ready? Save this price** under the time picker: name, phone and optional email. If they give an email, they're emailed their own link back, with a "Delete my info" link.
- `?resume=<key>` links bring their answers back and drop them on "pick a time". Links expire after 7 days. The key never goes in the sheet (only its fingerprint), and it's removed from the address bar on arrival.
- Retention (nightly, with the 7 PM run): incomplete leads are deleted after 30 quiet days, contact info is cleared off finished leads after 7 days, and visit counts are deleted after 35 days. Privacy page: `getpricewink.com/privacy`.

**Adding it to another client site** (ABC Fence is done; copy its pattern):
1. `<script src="../pw-leads.js"></script>` before the site script (on a client's own domain, copy `pw-leads.js` next to the page and use `pw-leads.js`).
2. After `BOOKING_ENDPOINT`/`CLIENT_ID`: `const L=window.PWL||null; if(L) L.init({endpoint:BOOKING_ENDPOINT,client:CLIENT_ID});`
3. `L.track('start')` when a service is picked, `L.save({...})` on contact-field input, `Object.assign(data, PWL.bookingExtras())` in the booking request, `PWL.done(phone)` after it succeeds, and `L.resume()` on load. Add the notice under the contact fields and the "Save this price" box (see `abc-fence/index.html`).

## What's new: + New Job (Nov 15, 2026)

The inbox's main button is now **+ New Job**, for customers who call or text instead of booking online. Owners enter the name, phone, address, job, a time (one of their open times, or any other day and time), an optional price, how the customer found them, and optionally an email (with a confirmation email) and notes. It's saved like an online booking, so call, text, directions, move, cancel, won/lost and review requests all work. If something's already on the calendar at that time, the owner is warned and can add it anyway. Every booking now records a `source` (online bookings say Website), which the lead tracking will build on.

Paste the new `Code.gs`, then **Deploy > Manage deployments > edit > New version > Deploy**. The Bookings tab gets its `source` column automatically. Tests: `node backend/test/newjob.test.js`.

## What's new: secure sign-in (Nov 15, 2026)

After pasting the new `Code.gs` (and the new `connect/Code.gs` into the Connect project):
1. Run `setup` once (adds the **Sessions** tab and the `loginEmails` column).
2. **Deploy > Manage deployments > edit > Version: New version > Deploy**, for both projects. The URLs stay the same.
3. Optional: turn on the Google button (above).

What changed: old `#key` inbox links no longer sign anyone in (they now show the sign-in screen), owner emails link to `getpricewink.com/inbox/?c=<id>#start` with no secret in them, error replies no longer include internal details, and anything a customer types is stored so Sheets can't run it as a formula.

## What's new (Nov 2026)

After pasting the new `Code.gs`, run `setup` once more and click **Allow**. Google asks again because the backend now saves customers' job photos to a private Drive folder ("PriceWink job photos"). Then **Deploy > Manage deployments > edit > Version: New version > Deploy** (the URL stays the same).

- **New columns** on the Bookings tab (`photos`, `outcome`, `jobValue`, `reminded`) and the Clients tab (`reviewUrl`) are added automatically by `setup`.
- **reviewUrl**: paste the client's Google "write a review" link here. The inbox's **Ask for a review** text uses it.
- **Reminders**: the 7 PM run now also emails customers with a visit the next day (only those who left an email, once per booking time).
- **Cancel / move**: the customer is emailed when the owner cancels or moves their visit from the inbox.
- **Owner-added bookings** (taken by phone) are confirmed right away and hold the time online. (Now the + New Job button; see above.)
- **Photos**: up to 3 per booking, shrunk on the customer's phone first. Only the owner's inbox link can open them.

## What's new: automatic texts through Twilio (Nov 15, 2026)

Five texting features, all **off** until Twilio is set up and approved. Nothing changes for any client until you turn it on for them. Tests: `node backend/test/texting.test.js`.

| feature (`autoTexts` value) | what happens |
|---|---|
| `alerts` | The owner gets a text for every new booking, voicemail and customer reply (to `ownerCell`). This replaces the old `ownerSms` email-to-text for that client. |
| `confirm` | The customer gets a text when they book online ("You're booked with ABC Fence for Tue, Nov 18 at 2:00 PM…"), when the owner moves or cancels the visit, and a reminder the evening before. Jobs added with **+ New Job** get it when the owner ticks **OK to text them** (which also allows the review text). |
| `missed` | Unanswered calls forward from the owner's phone to the client's Twilio number. The caller immediately gets a text with the quote link (at most once per 12 hours per caller), hears a short greeting, and can leave a voicemail. The voicemail is emailed to the owner as an audio file. |
| `incomplete` | A customer who checked **"Text me about my quote"** and stopped before booking gets the owner's follow-up message (`followupText`) once, 30+ minutes later, with a fresh "pick up where you left off" link. The inbox shows "Auto-texted". |
| `review` | A customer who checked the box gets a review request 2 hours after the owner marks the job **Done** (`reviewText`, or the default; uses `reviewUrl`). |

Customer texts (incomplete, review) only go out 9 AM to 8 PM Eastern. Replies to the business number are forwarded to the owner (email, plus a text if `alerts` is on). Twilio handles STOP / HELP itself. If Twilio reports a customer unsubscribed, their lead is marked Don't contact. Every text is logged on the **Texts** tab (last 4 digits of the number only).

**Consent:** the checkbox is unchecked by default and optional, as carriers require. Missed-call texts reply to someone who just called, so they need no checkbox. ABC Fence has the checkbox. Copy it to other sites (`#fSms` and `#sSms`, sent as `smsOk`).

### Turning it on

1. Paste the new `Code.gs`, run `setup` once (adds the Texts tab, new columns and the 15-minute text trigger), then **Deploy > Manage deployments > edit > New version > Deploy**. With no Twilio settings, everything still works exactly as before.
2. Twilio (paid account, PriceWink's business profile approved, the client's brand and campaign approved, a number bought for the client).
3. Apps Script > Project Settings > **Script properties**: `TWILIO_SID` = the Account SID, `TWILIO_TOKEN` = the Auth Token. Optional while testing: `TEXT_TEST_TO` = your own cell (every text goes to you instead, labeled with who it was for).
4. Run `textingSetup`. It creates the webhook key and logs two links per client. In Twilio > the client's number > **Voice: A call comes in** and **Messaging: A message comes in**, choose Webhook / HTTP POST and paste them.
5. On the client's row: `smsNumber` (their Twilio number), `ownerCell`, `autoTexts` (e.g. `alerts, confirm, missed, incomplete, review`). Optional: `missedText`, `reviewText` (same `{first} {business} {service} {price} {link}` fill-ins).
6. Script property `TEXTING` = `on`. Run `testText` to send one test text. Delete `TEXT_TEST_TO` when you're ready for real customers.
7. Set up call forwarding on the owner's phone: unanswered calls go to the client's Twilio number (Verizon `*71` + number, AT&T/T-Mobile `**61*` + number `#`; test with one call).

To pause everything at once: `TEXTING` = `off`. To pause one client: clear their `autoTexts`.
