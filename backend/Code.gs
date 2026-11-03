/**
 * Hire CoEverything intake — Apps Script endpoint
 *
 * Receives a JSON POST from the GitHub Pages form, appends one row to the
 * "Responses" sheet, stores any uploads in a Drive folder, and emails a
 * summary. Columns are created from the field keys the first time they
 * appear, so adding a question to the form never breaks the sheet.
 *
 * Standalone script (not container-bound): it opens the Sheet by SHEET_ID.
 * Deploy as a Web App: Execute as "Me", access "Anyone". The form posts
 * with Content-Type text/plain so the browser skips the CORS preflight,
 * which Apps Script web apps cannot answer.
 */

const CONFIG = {
  SHEET_ID: '1GRjooHAHI2_r13gtow_XPGAPzmuT_CsnEi_hWdi7IB8',  // Hire CoEverything responses
  SHEET_NAME: 'Responses',
  NOTIFY_TO: 'hello@coeverything.co',   // comma-separate for more than one
  UPLOAD_FOLDER_NAME: 'Hire CoEverything uploads',
  SHARED_SECRET: 'change-me',           // same value goes in the form's config.json
  FIELD_ORDER: [                        // keeps columns in form order
    'submitted_at','contact_first','contact_last','contact_email','contact_phone','contact_org',
    'org_type','project_description','service','also_interested','decision_makers','timing','deadline',
    'a1_type','a2_size','a3_site','a4_address','a4b_location','a5_have','a6_constraints','a7_develop',
    'b1_type','b2_scale','b3_site','b4_address','b4b_location','b5_support','b6_have',
    'c1_purpose','c2_support','c3_raise','c4_in_place',
    'd1_goal','d2_audience','d3_size','d4_format','d5_access',
    'e1_looking','e2_group','e3_prompt','e4_helpers',
    'f1_looking','f2_create','f3_have','f4_refs',
    'g1_build','g2_users','g3_connect','g4_compliance','g5_maintain',
    't1_custom_tool','project_cost','t2_funding','t2b_sources','t3_budget','t4_team','t5_process','t6_uploads','t7_success','t8_else',
    'source_url','user_agent','status','last_step','session_id'
  ]
};

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (CONFIG.SHARED_SECRET && body.secret !== CONFIG.SHARED_SECRET) {
      return respond({ ok: false, error: 'bad secret' });
    }
    delete body.secret;

    const answers = body.answers || {};
    const partial = body.status === 'partial';
    answers.submitted_at = new Date().toISOString();
    answers.source_url = body.source_url || '';
    answers.user_agent = body.user_agent || '';
    answers.status = partial ? 'in progress' : 'complete';
    answers.last_step = body.last_step || '';
    answers.session_id = body.session || '';

    // Uploads arrive as [{name, type, data(base64)}]
    if (!partial && Array.isArray(body.uploads) && body.uploads.length) {
      const folder = getOrCreateFolder(CONFIG.UPLOAD_FOLDER_NAME);
      const stamp = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd HHmm');
      const who = [answers.contact_org, answers.contact_last].filter(Boolean).join(' ') || 'unknown';
      const sub = folder.createFolder(stamp + ' ' + who);
      const links = body.uploads.slice(0, 5).map(u => {
        const blob = Utilities.newBlob(Utilities.base64Decode(u.data), u.type || 'application/octet-stream', u.name || 'upload');
        return sub.createFile(blob).getUrl();
      });
      answers.t6_uploads = links.join('\n');
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { appendRow(answers); } finally { lock.releaseLock(); }
    if (!partial) notify(answers);
    return respond({ ok: true });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  }
}

// Lets you open the web app URL in a browser to check it is alive.
function doGet() {
  return respond({ ok: true, message: 'Hire CoEverything intake endpoint is up.' });
}

function appendRow(answers) {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    const n = CONFIG.FIELD_ORDER.length;
    sheet.getRange(1, 1, 1, n).setValues([CONFIG.FIELD_ORDER]);
    sheet.getRange(2, 1, 1, n).setValues([CONFIG.FIELD_ORDER]);
    sheet.setFrozenRows(2);
  }
  // Row 1 = the question people saw, row 2 = "key · answer type", answers from row 3.
  // Older layout (keys in row 1) still works.
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const keyRow = String(sheet.getRange(1, 1).getValue()).split(' · ')[0].trim() === 'submitted_at' ? 1 : 2;
  const headers = sheet.getRange(keyRow, 1, 1, lastCol).getValues()[0]
    .map(v => String(v).split(' · ')[0].trim()).filter((v, i, a) => v || i < a.length - 1);

  // Add any new keys as new columns at the end (both header rows)
  Object.keys(answers).forEach(k => {
    if (headers.indexOf(k) === -1) {
      headers.push(k);
      sheet.getRange(keyRow, headers.length).setValue(k);
      if (keyRow === 2) sheet.getRange(1, headers.length).setValue(k);
    }
  });

  const row = headers.map(h => {
    const v = answers[h];
    if (v === undefined || v === null) return '';
    return Array.isArray(v) ? v.join('; ') : String(v);
  });
  // One row per form session: in-progress saves update the same row, and the final send completes it.
  const sid = answers.session_id;
  const sidCol = headers.indexOf('session_id') + 1;
  if (sid && sidCol > 0 && sheet.getLastRow() > keyRow) {
    const hit = sheet.getRange(keyRow + 1, sidCol, sheet.getLastRow() - keyRow, 1)
      .createTextFinder(sid).matchEntireCell(true).findNext();
    if (hit) {
      const r = hit.getRow();
      const old = sheet.getRange(r, 1, 1, headers.length).getValues()[0];
      // keep earlier answers the visitor did not resend (for example upload links)
      const merged = row.map((v, i) => (v === '' && old[i] !== '' && !(headers[i] in answers)) ? old[i] : v);
      sheet.getRange(r, 1, 1, merged.length).setValues([merged]);
      return;
    }
  }
  sheet.appendRow(row);
}

// Emails a readable summary: each answer under the question the person saw
// (taken from row 1 of the Responses tab), grouped by section, empty answers left out.
function notify(a) {
  if (!CONFIG.NOTIFY_TO) return;
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  const lastCol = sheet.getLastColumn();
  const top = sheet.getRange(1, 1, 2, lastCol).getValues();
  const labels = {}, order = [];
  for (let c = 0; c < lastCol; c++) {
    const key = String(top[1][c]).split(' · ')[0].trim();
    if (!key) continue;
    labels[key] = String(top[0][c] || key);
    order.push(key);
  }
  Object.keys(a).forEach(k => { if (order.indexOf(k) === -1) { order.push(k); labels[k] = labels[k] || k; } });

  const skip = ['submitted_at', 'status', 'last_step', 'session_id', 'user_agent', 'source_url',
                'contact_first', 'contact_last', 'contact_email', 'contact_phone', 'contact_org'];
  const val = v => Array.isArray(v) ? v.join(', ') : String(v).replace(/; /g, ', ');
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');

  const name = [a.contact_first, a.contact_last].filter(Boolean).join(' ');
  const who = a.contact_org ? name + ', ' + a.contact_org : name;
  const subject = 'New inquiry: ' + (who || 'someone') + (a.service ? ' (' + a.service + ')' : '');

  // Group by the "Section: question" prefix used in row 1; un-prefixed questions are "About the project".
  const groups = [], byGroup = {};
  order.forEach(k => {
    if (skip.indexOf(k) !== -1) return;
    const v = a[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    let label = labels[k], group = 'About the project';
    const m = label.match(/^([A-Za-z -]+): ([\s\S]*)$/);
    if (m) { group = m[1]; label = m[2]; }
    if (!byGroup[group]) { byGroup[group] = []; groups.push(group); }
    byGroup[group].push([label, val(v)]);
  });

  let text = (who || 'Someone') + ' filled in the Hire CoEverything form.\n\n';
  text += 'Email: ' + (a.contact_email || '') + (a.contact_phone ? '\nPhone: ' + a.contact_phone : '') + '\n';
  let html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#231f20;max-width:680px">';
  html += '<p style="font-size:16px;margin:0 0 4px"><b>' + esc(who || 'Someone') + '</b> filled in the Hire CoEverything form.</p>';
  html += '<p style="margin:0 0 16px">' + (a.contact_email ? '<a href="mailto:' + esc(a.contact_email) + '">' + esc(a.contact_email) + '</a>' : '') +
          (a.contact_phone ? ' &middot; ' + esc(a.contact_phone) : '') + '</p>';
  groups.forEach(g => {
    text += '\n' + g.toUpperCase() + '\n';
    html += '<h3 style="margin:20px 0 8px;padding:6px 10px;background:#333a83;color:#fff;font-size:13px;letter-spacing:.04em;text-transform:uppercase">' + esc(g) + '</h3>';
    byGroup[g].forEach(([q, v]) => {
      text += q + '\n  ' + v.replace(/\n/g, '\n  ') + '\n';
      html += '<p style="margin:0 0 12px"><span style="color:#6d6e71;font-size:12px">' + esc(q) + '</span><br>' + linkify(v) + '</p>';
    });
  });
  const url = ss.getUrl() + '#gid=' + sheet.getSheetId();
  text += '\nAll responses: ' + url + '\n';
  html += '<p style="margin-top:24px;font-size:12px;color:#6d6e71"><a href="' + url + '">Open the Responses sheet</a></p></div>';

  const mail = { to: CONFIG.NOTIFY_TO, subject: subject, body: text, htmlBody: html };
  if (a.contact_email) mail.replyTo = a.contact_email;   // hitting Reply goes to the person
  MailApp.sendEmail(mail);
}

function getOrCreateFolder(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor to confirm permissions and see a test row land.
function testAppend() {
  appendRow({
    submitted_at: new Date().toISOString(),
    contact_first: 'Test', contact_last: 'Row', contact_email: 'test@example.com',
    service: 'Architecture and design', also_interested: ['Financing strategy', 'Software and custom tools'],
    project_description: 'Delete this row.'
  });
}
