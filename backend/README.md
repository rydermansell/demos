# PriceWink booking backend

One Google Apps Script web app runs bookings for **every** PriceWink client. It lives in your Google account (free) and:

- serves each client's open estimate times (their hours, minus anything already on their calendar)
- re-checks a time is still free before booking it (no double bookings)
- saves the booking to a Google Sheet, puts it on the client's Google Calendar, and emails the owner (plus an optional text)
- emails the customer a confirmation if they gave an email
- powers the owner inbox (`/demos/inbox/`), where owners call, text, get directions and mark jobs Confirmed / Done / Canceled (canceling frees the time again)

## One-time setup (about 10 minutes)

1. Go to [script.google.com](https://script.google.com) signed in as the PriceWink Google account, click **New project**, name it `PriceWink bookings`.
2. Delete the sample code, paste in all of `Code.gs` from this folder, and save.
3. In **Project Settings** (gear icon), set the time zone to `(GMT-05:00) Eastern Time`.
4. Pick `setup` in the function menu at the top and click **Run**. Approve the permissions (Sheets, Calendar, Gmail). It creates a spreadsheet called "PriceWink bookings".
5. Click **Deploy > New deployment**, type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
6. Paste that URL into:
   - each client site: `const BOOKING_ENDPOINT='...'` near the top of the quote tool script
   - `inbox/index.html`: `const API='...'`

## Adding a client

1. In the script editor, open `addClient`, fill in the client's details (id, name, owner email, days, hours, phone, site) and **Run** it.
2. The log (View > Logs) prints:
   - their new bookings calendar
   - their private **owner inbox link**. Send this to the owner; they can add it to their home screen.
3. In Google Calendar, open **Settings > [Client] bookings > Share with specific people** and add the owner's email, so bookings show up on their phone. They can also block off time there, and the booking page stops offering it.
4. In the client's site, set `CLIENT_ID` to the same id and paste the web-app URL into `BOOKING_ENDPOINT`.

To change hours later, edit that client's row on the **Clients** tab of the spreadsheet. No redeploy needed.

## Updating the code

After editing `Code.gs`: **Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy**. The URL stays the same.

## Notes

- Free Gmail accounts can send about 100 emails a day through Apps Script; Google Workspace accounts get 1,500. Each booking sends 1 to 3 emails.
- Text alerts use the carrier's email-to-text address (for example `8655551234@vtext.com` for Verizon). Some carriers have been phasing these out; email always works.
- Preview mode: when `BOOKING_ENDPOINT` is empty, the site uses sample times and saves bookings only on that device, and `/demos/inbox/?c=<client>&demo` shows them. That's for showing prospects the full loop before they sign up.
