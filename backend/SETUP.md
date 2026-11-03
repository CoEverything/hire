# Intake endpoint setup (about 10 minutes)

What this gives you: a Google Sheet that gets one row per submission, a Drive folder for uploads, and an email to hello@ each time. The form on GitHub Pages posts to this script; nothing else runs anywhere.

## 1. Make the Sheet
1. In the CoEverything shared drive, create a new Google Sheet. Suggested name: `Hire CoEverything responses`.
2. Rename the first tab to `Responses` (the script will create it if you skip this).

## 2. Add the script
1. In that Sheet: Extensions > Apps Script.
2. Delete the placeholder code, paste in `Code.gs`, save.
3. At the top of the file, set:
   - `NOTIFY_TO` to the address(es) that should get the email.
   - `SHARED_SECRET` to any random string. Keep it; it goes into the form's config too. It stops random POSTs from landing in the sheet.
4. Run the function `testAppend` once from the toolbar. Approve the permission prompts (Sheets, Drive, Mail). A test row should appear in `Responses`. Delete it after.

## 3. Deploy
1. Deploy > New deployment.
2. Type: Web app. Description: anything. Execute as: **Me**. Who has access: **Anyone**.
3. Deploy, then copy the Web app URL (ends in `/exec`). Open it in a browser; you should see `{"ok":true,...}`.
4. Paste that URL into the form's `config.json` as `endpoint`, with the same `secret`.

## 4. Changing things later
- Wording or choices: edit the form's JSON. The sheet adds a column for any new key automatically.
- Script changes: Deploy > Manage deployments > edit > Version: New. The URL stays the same.
- Uploads land in Drive under `Hire CoEverything uploads / <date> <org or name>` in the account that deployed the script. Move the folder into the shared drive after the first run if you want it there; the script finds it by name.

## Notes
- Apps Script web apps can't answer CORS preflight requests, so the form sends `Content-Type: text/plain` with a JSON string in the body. That's expected, not a bug.
- Uploads are base64 in the POST body. Apps Script accepts about 50 MB per request, so the form caps uploads at 5 files and 8 MB each.
- If the email ever stops, check Apps Script's daily mail quota (100/day on a Workspace account). The sheet row still lands either way.
