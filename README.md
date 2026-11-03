# Hire CoEverything

The intake form at hire.coeverything.co. A static site on GitHub Pages; submissions go to a Google Sheet through a small Apps Script endpoint. No build step, no framework.

## Files

- `index.html`, `styles.css`, `app.js`: the form engine. One screen at a time, keyboard shortcuts (A to J pick an option, Enter continues, Shift+Enter is a newline, Backspace goes back), a summary rail of answers so far, drafts saved in the browser for a week.
- `form.json`: every screen, in order, with its copy, options, routing and which figure appears. **Edit this to change wording or questions.** No code changes needed.
- `config.json`: the endpoint URL and the shared secret the endpoint expects. The secret is visible to anyone who reads the source; it filters casual spam, nothing more.
- `assets/figures/`: cutoutmix Archifunky figures (CC BY 4.0). Credit line is on every screen. `assets/figures/LICENSE.txt` has the details.
- `backend/Code.gs`: the Apps Script that receives submissions. The live copy runs under hello@coeverything.co; this is a reference copy (secret redacted).

## Editing copy

Open `form.json`. Each screen has:

- `title`, `helper`: the question and the line under it.
- `pattern`: `statement`, `fields`, `write` (long text), `short`, `pick` (list with letter keys), `cards`, `scrub` (ranges), `upload`.
- `look`: `deck` (indigo), `proposal` (white), `collage` (cream with shapes).
- `options`, `multi`, `other`, `exclusive`: choices; `exclusive` options clear the others when picked (for "None yet").
- `required`: no skip link.
- `next`: a screen id, `{ "branch": "service" }`, or `{ "if": [ { "answerIn": [...], "go": "id" } ], "else": "id" }`.
- `key`: the column name in the Sheet. Adding a new key adds a column automatically on the first submission.
- `fig`: which figure (number from the contact sheet, `c` skin-tone variant). To add one, drop the PNG in `assets/figures/`.

Commit to `main` and GitHub Pages redeploys in about a minute.

## Links

- Pre-answer the service and skip that screen: `?service=arch`, `?service=real`, `?service=fin`, `?service=work`, `?service=org`, `?service=design`, `?service=soft` (any prefix of the service name works).
- Start fresh, ignoring a saved draft: `?fresh`.

## Backend

Responses Sheet (hello@ account): https://docs.google.com/spreadsheets/d/1GRjooHAHI2_r13gtow_XPGAPzmuT_CsnEi_hWdi7IB8/edit

Each submission appends a row, emails hello@coeverything.co, and puts any uploads in the Drive folder "Hire CoEverything uploads" with a link in the `t6_uploads` column. To change the endpoint code, edit it in the Apps Script editor and publish a new version of the existing deployment so the URL stays the same.
