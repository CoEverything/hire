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
    'b1_type','b2_scale','b3_site','b4_address','b4b_location','b5_support','b6_have','b7_cost',
    'c1_purpose','c2_support','c3_raise','c4_in_place',
    'd1_goal','d2_audience','d3_size','d4_format','d5_access',
    'e1_looking','e2_group','e3_prompt','e4_helpers',
    'f1_looking','f2_create','f3_have','f4_refs',
    'g1_build','g2_users','g3_connect','g4_compliance','g5_maintain',
    't1_custom_tool','t2_funding','t3_budget','t4_team','t5_process','t6_uploads','t7_success','t8_else',
    'source_url','user_agent'
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
    answers.submitted_at = new Date().toISOString();
    answers.source_url = body.source_url || '';
    answers.user_agent = body.user_agent || '';

    // Uploads arrive as [{name, type, data(base64)}]
    if (Array.isArray(body.uploads) && body.uploads.length) {
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

    appendRow(answers);
    notify(answers);
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
    sheet.appendRow(CONFIG.FIELD_ORDER);
    sheet.setFrozenRows(1);
  }
  const lastCol = sheet.getLastColumn();
  let headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (!headers.length) { headers = CONFIG.FIELD_ORDER.slice(); sheet.getRange(1, 1, 1, headers.length).setValues([headers]); }

  // Add any new keys as new columns at the end
  Object.keys(answers).forEach(k => {
    if (headers.indexOf(k) === -1) { headers.push(k); sheet.getRange(1, headers.length).setValue(k); }
  });

  const row = headers.map(h => {
    const v = answers[h];
    if (v === undefined || v === null) return '';
    return Array.isArray(v) ? v.join('; ') : String(v);
  });
  sheet.appendRow(row);
}

function notify(a) {
  if (!CONFIG.NOTIFY_TO) return;
  const name = [a.contact_first, a.contact_last].filter(Boolean).join(' ');
  const subject = 'Intake: ' + (a.contact_org || name || 'new response') + ' (' + (a.service || 'no service') + ')';
  const lines = CONFIG.FIELD_ORDER
    .filter(k => a[k] !== undefined && a[k] !== '' && k !== 'user_agent')
    .map(k => k + ': ' + (Array.isArray(a[k]) ? a[k].join('; ') : a[k]));
  MailApp.sendEmail({
    to: CONFIG.NOTIFY_TO,
    subject: subject,
    body: lines.join('\n') + '\n\nSheet: ' + SpreadsheetApp.openById(CONFIG.SHEET_ID).getUrl()
  });
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
