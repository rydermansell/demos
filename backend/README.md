# PriceWink booking backend

One Google Apps Script web app runs bookings for **every** PriceWink client. It lives in your Google account (free) and:

- serves each client's open estimate times: their hours, minus PriceWink bookings, minus anything on the owner's **own** calendar (Google, iCloud or Outlook), so jobs booked by phone are blocked automatically
- re-checks a time is still free before booking it (no double bookings)
- saves the booking to a Google Sheet, puts it on the client's Google Calendar, and emails the owner (plus an optional text)
- emails the customer a confirmation if they gave an email
- powers the owner inbox (`/demos/inbox/`), where owners call, text, get directions, mark jobs Confirmed / Done / Canceled (canceling frees the time again) and tap **Block time** for anything not on a calendar
- emails each owner a 7 PM "tomorrow" summary (booked jobs, blocked time, open times) with a one-tap link to block anything they forgot

## One-time setup (about 10 minutes)

1. Go to [script.google.com](https://script.google.com) signed in as the PriceWink Google account, click **New project**, name it `PriceWink bookings`.
2. Delete the sample code, paste in all of `Code.gs` from this folder, and save. Then open **Project Settings**, tick **Show "appsscript.json" manifest file in editor**, and replace that file's contents with `appsscript.json` from this folder (it turns on the Calendar API used for free/busy checks and sets the web-app access).
3. In **Project Settings** (gear icon), set the time zone to `(GMT-05:00) Eastern Time`.
4. Pick `setup` in the function menu at the top and click **Run**. Approve the permissions (Sheets, Calendar, Gmail). It creates a spreadsheet called "PriceWink bookings".
5. Click **Deploy > New deployment**, type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
6. Paste that URL into:
   - each client site: `const BOOKING_ENDPOINT='...'` near the top of the quote tool script
   - `inbox/index.html`: `const API='...'`
7. Pick `installTriggers` and **Run** it once. This schedules the nightly summary emails.

## Adding a client

1. In the script editor, open `addClient`, fill in the client's details (id, name, owner email, days, hours, phone, site) and **Run** it.
2. The log (View > Logs) prints:
   - their new bookings calendar
   - their private **owner inbox link**. Send this to the owner; they can add it to their home screen.
3. In Google Calendar, open **Settings > [Client] bookings > Share with specific people** and add the owner's email, so bookings show up on their phone. They can also block off time there, and the booking page stops offering it.
4. In the client's site, set `CLIENT_ID` to the same id and paste the web-app URL into `BOOKING_ENDPOINT`.
5. Connect the owner's own calendar (below) so phone bookings block time automatically.

## Connecting the owner's calendar (auto-blocking)

Anything on the owner's own calendar becomes unavailable on their booking page within about 5 minutes. Only busy/free is read, never event titles.

- **Google Calendar:** the owner opens Google Calendar on a computer > **Settings** > their calendar > **Share with specific people** > add the PriceWink Google address with **See only free/busy**. Then put their calendar's email address in the `busyCalendars` column of the Clients tab (separate several with commas).
- **iPhone / iCloud:** Calendar app > tap **Calendars** > the (i) next to their calendar > turn on **Public Calendar** > **Share Link**. Paste that link into `busyIcs`.
- **Outlook / Microsoft 365:** Outlook on the web > **Settings > Calendar > Shared calendars > Publish a calendar** > pick the calendar, **Can view when I'm busy** > copy the **ICS** link into `busyIcs`.

Several links can go in `busyIcs`, separated by commas. Events marked "free" or canceled are ignored; all-day events block the whole day. The inbox shows "Synced with your calendar" once at least one source is connected.

Owners who keep no calendar at all use **Block time** in the inbox, and the 7 PM summary email reminds them. Set the `digest` column to `no` to turn that email off for a client.

To change hours, calendars or the digest later, edit that client's row on the **Clients** tab of the spreadsheet. No redeploy needed.

## Updating the code

After editing `Code.gs`: **Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy**. The URL stays the same.

## Notes

- Free Gmail accounts can send about 100 emails a day through Apps Script; Google Workspace accounts get 1,500. Each booking sends 1 to 3 emails.
- Text alerts use the carrier's email-to-text address (for example `8655551234@vtext.com` for Verizon). Some carriers have been phasing these out; email always works.
- Preview mode: when `BOOKING_ENDPOINT` is empty, the site uses sample times and saves bookings only on that device, and `/demos/inbox/?c=<client>&demo` shows them. That's for showing prospects the full loop before they sign up.
