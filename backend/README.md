**Start here:** upload `pricewink-bookings.xlsx` to Google Drive, open it with Google Sheets (File > Save as Google Sheets), then open **Extensions > Apps Script** from inside it and follow the setup below there. `setup` uses that spreadsheet (it only creates a new one if the script isn't attached to a sheet).

# PriceWink booking backend

One Google Apps Script web app runs bookings for **every** PriceWink client. It lives in your Google account (free) and:

- serves each client's open estimate times: their hours, minus PriceWink bookings, minus anything on the owner's **own** calendar (Google, iPhone or Outlook, connected by the owner from their inbox), so jobs booked by phone are blocked automatically
- re-checks a time is still free before booking it (no double bookings)
- saves the booking to a Google Sheet, puts it on the client's Google Calendar, and emails the owner (plus an optional text)
- emails the customer a confirmation if they gave an email
- powers the owner inbox (`/demos/inbox/`), where owners call, text, get directions, mark jobs Confirmed / Done / Canceled (canceling frees the time again) and tap **Block time** for anything not on a calendar
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

Leave `calendarId` and `inboxKey` blank (or pre-fill a 20-character key). Within 10 minutes, or the first time the site loads, the backend:
- creates "[name] bookings" calendar and shares it with the owner (they can add jobs to it, which block times too)
- creates the inbox key
- emails **you** the owner's inbox link

Then set `CLIENT_ID` (= id) and `BOOKING_ENDPOINT` in the client's site. Hours, emails and calendars can be changed on the row any time, no redeploy.

(`addClient` in the editor still works if you prefer it.)

## Bookings in the owner's calendar app (iPhone, Outlook, anything)

Gmail owners see the "[name] bookings" Google Calendar automatically (it's shared with them). Everyone else opens **Connect your calendar** in their inbox and taps **iPhone** or **Outlook** under "See bookings in your phone's calendar" (or **Copy link** for any other app). That subscribes their calendar app to a private, read-only feed (`?action=ics&c=<id>&t=<token>`) with every booking and blocked time, plus a 1-hour reminder before each estimate. iPhone checks for changes about every 15 minutes (owners can set this under Settings > Calendar > Accounts > Fetch); Outlook every few hours. The feed token is separate from the inbox key, so a leaked calendar link can't open the inbox. Changing a client's `inboxKey` resets both.

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
