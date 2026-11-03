/* Hire CoEverything intake form engine.
   Reads form.json (screens, routing, copy) and config.json (endpoint, secret),
   renders one screen at a time, keeps a summary rail, and posts to the
   Apps Script endpoint which appends a row to the Google Sheet. */

(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };
  const KEYS = 'ABCDEFGHIJKLMNOP';
  const ROTS = [-1, 0.6, -0.5, 0.9, -0.8, 0.5, -0.6, 0.7, -0.4];
  const STORE = 'hire-coeverything-v2';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let form, config, byId;
  let answers = {};
  let files = [];           // File objects for the upload screen
  let history = [];         // screen ids visited, in order
  let future = [];          // screens ahead when the visitor went back to edit; kept so later answers survive
  let silentPop = false;    // true while we move browser history ourselves
  let current = null;
  let busy = false;
  let submitted = false;
  let session = '';         // one id per visitor, so in-progress saves update one row in the Sheet
  let lastSaved = '';
  let preService = false;   // service came from the link, so its screen is skipped

  // ---------- boot ----------
  async function boot() {
    const [f, c] = await Promise.all([
      fetch('form.json', { cache: 'no-cache' }).then(r => r.json()),
      fetch('config.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => ({}))
    ]);
    form = f; config = c;
    byId = Object.fromEntries(form.screens.map(s => [s.id, s]));

    // Pre-answer the service from the link (?service=arch or full name)
    const params = new URLSearchParams(location.search);
    const pre = params.get('service');
    if (pre) {
      const hit = form.services.find(s => s.value.toLowerCase().startsWith(pre.toLowerCase()) || s.branch.toLowerCase() === pre.toLowerCase());
      if (hit) { answers.service = hit.value; preService = true; }
    }

    // Resume a saved draft if there is one
    if (!params.has('fresh')) restore();

    $('#credit-link').textContent = form.meta.credit;
    $('#credit-link').href = form.meta.creditUrl;
    document.title = form.meta.title;

    document.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', persist);
    window.addEventListener('popstate', onPop);
    window.addEventListener('pagehide', savePartial);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePartial(); });
    if (!session) session = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    const resumed = history.length > 1;

    const start = history.length ? history[history.length - 1] : 'welcome';
    history = history.length ? history : ['welcome'];
    window.history.replaceState({ n: history.length }, '');
    show(start, 'none');
    if (resumed) toast(`Welcome back. We kept your answers. <a href="?fresh">Start over</a>`);
  }

  // ---------- persistence ----------
  function persist() {
    if (submitted) { try { localStorage.removeItem(STORE); } catch (_) {} return; }
    try { localStorage.setItem(STORE, JSON.stringify({ answers, history, future, session, t: Date.now() })); } catch (_) {}
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!d || Date.now() - d.t > 7 * 864e5) return;
      if (Array.isArray(d.history) && d.history.every(id => byId[id])) {
        answers = { ...d.answers, ...answers }; history = d.history;
        future = Array.isArray(d.future) ? d.future.filter(id => byId[id]) : [];
        session = d.session || '';
      }
    } catch (_) {}
  }

  // ---------- routing ----------
  function nextOf(screen) {
    const n = screen.next;
    if (!n) return null;
    if (typeof n === 'string') return n;
    if (n.branch) {
      const svc = form.services.find(s => s.value === answers[n.branch]);
      return svc ? svc.branch + '0' : 'T0';
    }
    if (n.if) {
      for (const rule of n.if) {
        if (rule.answerIn && rule.answerIn.includes(answers[rule.key || screen.key])) return rule.go;
        if (rule.answered && answers[rule.answered] !== undefined && answers[rule.answered] !== '') return rule.go;
      }
      return n.else;
    }
    return null;
  }

  // Estimated path from the current screen, following "else"/typical routes, for the step counter.
  function estimateRemaining(fromId, questionsOnly) {
    const seen = new Set();
    let id = fromId, count = 0, hops = 0;
    while (id && !seen.has(id) && hops < 80) {
      seen.add(id); hops++;
      const s = byId[id];
      if (s && (!questionsOnly || s.key || s.fields)) count++;
      if (!s || !s.next) break;
      const n = s.next;
      if (typeof n === 'string') id = n;
      else if (n.branch) { const svc = form.services.find(x => x.value === answers[n.branch]); id = svc ? svc.branch + '0' : 'A0'; }
      else if (n.if) {
        let go = null;
        for (const rule of n.if) {
          if (rule.answerIn && rule.answerIn.includes(answers[rule.key || s.key])) go = rule.go;
          else if (rule.answered && answers[rule.answered]) go = rule.go;
          if (go) break;
        }
        id = go || n.else;
      } else id = null;
    }
    return count;
  }

  // ---------- rendering ----------
  function show(id, dir) {
    const s = byId[id];
    if (!s) return;
    current = s;
    document.body.dataset.look = s.look || 'proposal';
    document.body.dataset.pattern = s.pattern;

    // top bar
    const isQ = x => x && (x.key || x.fields);
    const stepNo = history.filter(h => isQ(byId[h])).length;           // questions answered or on screen
    const total = stepNo + estimateRemaining(id, true) - (isQ(s) ? 1 : 0);        // plus the likely questions ahead
    $('#crumb').innerHTML = `CoEverything · <b>${esc(s.section)}</b>`;
    const isEnd = !s.next;
    $('#step').textContent = isEnd ? '' : (id === 'welcome' ? `about ${form.meta.typicalScreens} screens, ten minutes` : `${stepNo} of ~${Math.max(total, stepNo)}`);
    $('#bar').style.width = isEnd ? '100%' : `${Math.round((stepNo / Math.max(total, stepNo + 1)) * 100)}%`;

    // rail or side figure
    const railPatterns = ['write', 'short', 'fields', 'upload', 'pick'];
    const hasRail = railPatterns.includes(s.pattern) && s.id !== 'thanks';
    renderRail(hasRail, s);
    renderSide(!hasRail, s);

    // screen
    const node = renderScreen(s);
    const wrap = $('#screens');
    const old = wrap.querySelector('.screen:not(.leave)');
    if (old) {
      old.classList.add('leave');
      if (dir === 'back') old.classList.add('back-dir');
      old.addEventListener('animationend', () => old.remove(), { once: true });
      setTimeout(() => old.remove(), 600);
    }
    node.classList.add('enter');
    if (dir === 'back') node.classList.add('back-dir');
    wrap.append(node);
    node.addEventListener('animationend', () => node.classList.remove('enter', 'back-dir'), { once: true });

    // focus
    requestAnimationFrame(() => {
      const first = node.querySelector('textarea, input[type="text"], input[type="email"], input[type="tel"]');
      if (first && window.innerWidth > 860) first.focus({ preventScroll: true });
      else if (s.pattern === 'statement') node.querySelector('.btn')?.focus({ preventScroll: true });
      node.scrollTop = 0;
      window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    });
    persist();
  }

  function renderRail(visible, s) {
    const rail = $('#rail');
    rail.hidden = !visible;
    if (!visible) return;
    const list = $('#rail-list');
    list.innerHTML = '';
    for (const hid of history) {
      const h = byId[hid];
      if (!h || !h.railLabel || hid === s.id) continue;
      const v = railValue(h);
      if (v === null) continue;
      list.append(el('div', { class: 'rail-row' },
        el('button', { type: 'button', title: 'Go back to this question', onclick: () => jumpBack(hid) },
          el('small', {}, h.railLabel), v)));
    }
    if (s.railLabel) list.append(el('div', { class: 'rail-row pending' }, el('small', {}, s.railLabel), '…'));
    list.querySelectorAll('.rail-row').forEach((r, i) => r.style.setProperty('--i', i));
    setFig($('#rail-img'), s.fig);
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  function railValue(h) {
    if (h.railFrom) {
      const v = h.railFrom.map(k => answers[k]).filter(Boolean).join(' ');
      return v || null;
    }
    const v = answers[h.key];
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return h.pattern === 'upload' ? null : null;
    if (h.pattern === 'upload') return `${files.length} file${files.length === 1 ? '' : 's'}`;
    const str = Array.isArray(v) ? v.join('; ') : String(v);
    return str.length > 70 ? str.slice(0, 68).trimEnd() + '…' : str;
  }

  function renderSide(visible, s) {
    const side = $('#side');
    side.hidden = !visible;
    if (s.pattern === 'statement') side.dataset.keep = ''; else delete side.dataset.keep;
    if (visible) setFig($('#side-img'), s.fig);
  }

  function setFig(img, fig) {
    const src = `assets/figures/${fig}.png`;
    if (img.getAttribute('src') === src) return;
    img.classList.remove('swap');
    void img.offsetWidth;
    img.src = src;
    img.classList.add('swap');
    img.onload = () => { img.style.setProperty('--fig-scale', Math.min(1, img.naturalHeight / 1100).toFixed(3)); };
  }

  function renderScreen(s) {
    const node = el('section', { class: 'screen', 'data-pattern': s.pattern, 'aria-labelledby': 'q-title' });
    const body = el('div', { class: 'screen-body' });
    node.append(body);

    if (history.length > 1 && s.id !== 'thanks') body.append(el('button', { type: 'button', class: 'back', onclick: () => back() }, '← Back'));

    if (s.pattern === 'statement') {
      if (s.kicker) body.append(el('div', { class: 'kicker' }, s.kicker));
      body.append(el('h1', { id: 'q-title' }, fill(s.title)));
      if (s.helper) body.append(el('p', { class: 'helper' }, fill(s.helper)));
    } else {
      if (['write', 'short', 'fields', 'upload'].includes(s.pattern)) body.append(el('div', { class: 'bar' }));
      body.append(el('h1', { id: 'q-title' }, fill(s.title)));
      if (s.helper) body.append(el('p', { class: 'helper' }, fill(s.helper)));
      body.append(renderInput(s));
    }
    body.append(el('div', { class: 'field-error', id: 'err', role: 'alert' }));

    // actions
    const actions = el('div', { class: 'actions' });
    const label = s.button || 'Continue';
    if (s.link) actions.append(el('a', { class: 'btn', href: s.link }, label));
    else actions.append(el('button', { type: 'button', class: 'btn', id: 'go', onclick: () => advance() }, label));
    if (s.pattern !== 'statement' && s.id !== 'thanks') actions.append(el('span', { class: 'enter-hint', html: 'or press <kbd>Enter</kbd>' }));
    if (!s.required && s.pattern !== 'statement' && s.id !== 'thanks' && !s.submit) {
      actions.append(el('button', { type: 'button', class: 'skip', onclick: () => skip() }, 'Skip for now'));
    }
    const ahead = (future.length && s.id !== 'thanks') ? validFuture() : [];
    if (ahead.length) {
      const dest = byId[ahead[ahead.length - 1]];
      actions.append(el('button', { type: 'button', class: 'skip ahead', onclick: () => returnAhead() }, `Return to "${(dest.title || '').replace(/[.?]$/, '')}" →`));
    }
    body.append(actions);
    return node;
  }

  function fill(str) {
    return String(str || '').replace(/\{(\w+)\}/g, (_, k) => answers[k] || (k === 'contact_first' ? 'friend' : ''));
  }

  function optionsFor(s) {
    let opts = [];
    if (s.optionsFrom === 'services') {
      if (s.excludeAnswer && Array.isArray(answers[s.key])) answers[s.key] = answers[s.key].filter(v => v !== answers[s.excludeAnswer]);
      opts = form.services.map(x => ({ v: x.value, hint: x.hint, locked: !!(s.excludeAnswer && answers[s.excludeAnswer] === x.value) }));
    } else opts = (s.options || []).map(v => ({ v }));
    for (const x of s.extraOptions || []) opts.push({ v: x });
    if (s.other) opts.push({ v: 'Other', other: true });
    return opts;
  }

  function renderInput(s) {
    const wrap = el('div', { class: 'input' });
    const key = s.key;

    if (s.pattern === 'write' || s.pattern === 'short') {
      const isLong = s.pattern === 'write';
      const inp = isLong
        ? el('textarea', { rows: 6, placeholder: s.placeholder || '', 'aria-label': s.title, oninput: e => { answers[key] = e.target.value; } })
        : el('input', { type: 'text', placeholder: s.placeholder || '', 'aria-label': s.title, oninput: e => { answers[key] = e.target.value; } });
      inp.value = answers[key] || '';
      wrap.append(inp);
      if (isLong) wrap.append(el('div', { class: 'hint' }, 'Shift + Enter for a new line'));
      return wrap;
    }

    if (s.pattern === 'fields') {
      const grid = el('div', { class: 'fields stagger' });
      const stored = s.joinFields ? (answers['_' + key] || {}) : answers;
      s.fields.forEach((f, i) => {
        const id = `f-${f.key}`;
        const inp = el('input', {
          id, type: f.type || 'text', autocomplete: f.autocomplete || 'off', required: !!f.required,
          'aria-required': f.required ? 'true' : null,
          oninput: e => {
            if (s.joinFields) { answers['_' + key] = answers['_' + key] || {}; answers['_' + key][f.key] = e.target.value; answers[key] = joinAddress(answers['_' + key]); }
            else answers[f.key] = e.target.value;
          }
        });
        inp.value = (s.joinFields ? stored[f.key] : answers[f.key]) || '';
        const cell = el('div', { class: 'field' + (f.wide ? ' wide' : ''), style: { '--i': i } }, el('label', { for: id }, f.label + (f.required ? ' *' : '')), inp);
        grid.append(cell);
      });
      wrap.append(grid);
      return wrap;
    }

    if (s.pattern === 'pick' || s.pattern === 'cards' || s.pattern === 'scrub') {
      const opts = optionsFor(s);
      const multi = !!s.multi;
      const cur = answers[key];
      const isSel = v => multi ? (Array.isArray(cur) && cur.includes(v)) : cur === v;
      const otherVal = () => { const v = multi ? (cur || []).find(x => String(x).startsWith('Other')) : (typeof cur === 'string' && cur.startsWith('Other') ? cur : null); return v; };
      const otherSel = !!otherVal();

      let list;
      if (s.pattern === 'cards') list = el('div', { class: 'cards', role: multi ? 'group' : 'radiogroup', style: { gridTemplateColumns: `repeat(${s.cols || 3}, minmax(0,1fr))` } });
      else if (s.pattern === 'scrub') list = el('div', { class: 'chips stagger', role: 'radiogroup' });
      else list = el('div', { class: 'options stagger', role: multi ? 'group' : 'radiogroup', style: { gridTemplateColumns: `repeat(${s.cols || 2}, minmax(0,1fr))` } });

      let readout = null;
      if (s.pattern === 'scrub') { readout = el('div', { class: 'readout', 'aria-live': 'polite' }, cur || 'Pick a range'); wrap.append(readout); }

      const otherWrap = el('div', { class: 'other-wrap', hidden: !otherSel });
      const otherInp = el('input', { type: 'text', placeholder: 'Tell us', 'aria-label': 'Other', oninput: e => setOther(e.target.value) });
      otherInp.value = otherSel ? String(otherVal()).replace(/^Other:?\s*/, '') : '';
      otherWrap.append(otherInp);

      const buttons = [];
      let keyNo = 0;
      opts.forEach((o, i) => {
        if (o.locked) {   // the main topic picked on the previous screen: shown, not selectable
          const b = el('button', { type: 'button', class: 'opt locked', disabled: true, 'aria-disabled': 'true', title: 'This is your main topic' },
            el('span', { class: 'key' }, '✓'),
            el('span', { class: 'txt' }, o.v, el('span', { class: 'sub' }, 'Your main topic, already covered')));
          buttons.push(b); list.append(b);
          return;
        }
        const K = KEYS[keyNo++];
        const role = multi ? 'checkbox' : 'radio';
        const checked = o.other ? otherSel : isSel(o.v);
        let b;
        if (s.pattern === 'cards') {
          b = el('button', { type: 'button', class: 'card', role, 'aria-checked': String(checked), style: { '--rot': `${ROTS[i % ROTS.length]}deg`, '--i': i } },
            el('span', { class: 'key' }, K), el('span', {}, o.v));
        } else if (s.pattern === 'scrub') {
          b = el('button', { type: 'button', class: 'chip', role, 'aria-checked': String(checked), style: { '--i': i } }, el('span', { class: 'key' }, K), o.v);
        } else {
          b = el('button', { type: 'button', class: 'opt' + (multi ? ' multi' : ''), role, 'aria-checked': String(checked), style: { '--i': i } },
            el('span', { class: 'key' }, K),
            el('span', { class: 'txt' }, o.v, o.hint ? el('span', { class: 'sub' }, o.hint) : null));
        }
        b.addEventListener('click', () => choose(i));
        buttons.push(b); list.append(b);
      });

      function paint() {
        const c = answers[key];
        opts.forEach((o, i) => {
          if (o.locked) return;
          const on = o.other ? !!(multi ? (c || []).find(x => String(x).startsWith('Other')) : (typeof c === 'string' && c.startsWith('Other'))) : (multi ? (Array.isArray(c) && c.includes(o.v)) : c === o.v);
          buttons[i].setAttribute('aria-checked', String(on));
        });
        otherWrap.hidden = !(multi ? (c || []).some(x => String(x).startsWith('Other')) : (typeof c === 'string' && c.startsWith('Other')));
        if (readout) { readout.textContent = c || 'Pick a range'; readout.classList.remove('tick'); void readout.offsetWidth; readout.classList.add('tick'); }
      }
      function setOther(text) {
        const val = text.trim() ? `Other: ${text.trim()}` : 'Other';
        if (multi) { const arr = (answers[key] || []).filter(x => !String(x).startsWith('Other')); arr.push(val); answers[key] = arr; }
        else answers[key] = val;
      }
      function choose(i) {
        const o = opts[i];
        const v = o.other ? (otherInp.value.trim() ? `Other: ${otherInp.value.trim()}` : 'Other') : o.v;
        if (multi) {
          let arr = Array.isArray(answers[key]) ? [...answers[key]] : [];
          const has = o.other ? arr.some(x => String(x).startsWith('Other')) : arr.includes(v);
          if (has) arr = arr.filter(x => o.other ? !String(x).startsWith('Other') : x !== v);
          else {
            const excl = s.exclusive || [];
            if (excl.includes(v)) arr = [v]; else { arr = arr.filter(x => !excl.includes(x)); arr.push(v); }
          }
          answers[key] = arr;
          paint();
          if (o.other && !has) setTimeout(() => otherInp.focus(), 50);
        } else {
          answers[key] = v;
          paint();
          if (o.other) { setTimeout(() => otherInp.focus(), 50); return; }
          // single choice: settle, then advance
          if (!reduced) setTimeout(() => advance(), 260); else advance();
        }
      }
      wrap.append(list, otherWrap);
      if (multi) wrap.append(el('div', { class: 'hint' }, 'Pick as many as apply.'));
      return wrap;
    }

    if (s.pattern === 'upload') {
      const input = el('input', { type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.zip', onchange: e => addFiles(e.target.files) });
      const drop = el('div', { class: 'drop', role: 'button', tabindex: 0, onclick: () => input.click(), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
        el('strong', { html: 'Drag files here, or <u>browse</u>' }),
        el('small', {}, `Up to ${form.meta.maxUploads} files, ${Math.round(form.meta.maxUploadBytes / 1048576)} MB each. PDF, images, docs, spreadsheets.`),
        input);
      const icon = document.createElement('div');
      icon.innerHTML = '<svg aria-hidden="true" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2e7268" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
      drop.prepend(icon.firstChild);
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
      const list = el('div', { class: 'files' });
      function addFiles(fl) {
        for (const f of Array.from(fl)) {
          if (files.length >= form.meta.maxUploads) { toast(`Up to ${form.meta.maxUploads} files. Drop the rest in an email after.`); break; }
          if (f.size > form.meta.maxUploadBytes) { toast(`${f.name} is over ${Math.round(form.meta.maxUploadBytes / 1048576)} MB. Send it by email after, or compress it.`); continue; }
          if (files.some(x => x.name === f.name && x.size === f.size)) continue;
          files.push(f);
        }
        answers[key] = files.map(f => f.name).join('; ');
        paintFiles();
      }
      function paintFiles() {
        list.innerHTML = '';
        files.forEach((f, i) => list.append(el('div', { class: 'file' }, el('span', {}, f.name), el('em', {}, fmtSize(f.size)),
          el('button', { type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { files.splice(i, 1); answers[key] = files.map(x => x.name).join('; '); paintFiles(); } }, '×'))));
      }
      paintFiles();
      wrap.append(drop, list);
      return wrap;
    }
    return wrap;
  }

  function joinAddress(a) {
    const line = [a.street, a.line2].filter(Boolean).join(', ');
    const place = [a.city, a.state].filter(Boolean).join(', ') + (a.zip ? ' ' + a.zip : '');
    return [line, place.trim()].filter(Boolean).join(', ');
  }
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  // ---------- navigation ----------
  function validate(s) {
    const err = $('#err'); err.textContent = '';
    if (s.pattern === 'fields') {
      for (const f of s.fields) {
        const v = s.joinFields ? '' : (answers[f.key] || '').trim();
        if (f.required && !v) { return fail(`${f.label} is the one thing we can't skip.`, `#f-${f.key}`); }
        if (f.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return fail('That email looks a little off. Mind checking it?', `#f-${f.key}`);
      }
      return true;
    }
    if (!s.required) return true;
    const v = answers[s.key];
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'string' && !v.trim())) {
      return fail(s.pattern === 'pick' || s.pattern === 'cards' ? 'Pick one to keep going.' : 'A line or two here helps us a lot.');
    }
    return true;
  }
  function fail(msg, focusSel) {
    const err = $('#err'); err.textContent = msg;
    const node = $('#screens .screen:not(.leave)');
    node.classList.remove('shake'); void node.offsetWidth; node.classList.add('shake');
    if (focusSel) $(focusSel)?.focus();
    return false;
  }

  function advance() {
    if (busy || !current) return;
    if (current.pattern !== 'statement' && !validate(current)) return;
    if (current.submit) return submit();
    let nid = nextOf(current);
    if (!nid) return;
    if (nid === 'service' && preService && answers.service) nid = 'also_interested';
    goForward(nid);
  }
  function skip() {
    if (busy || !current) return;
    if (current.key) delete answers[current.key];
    if (current.pattern === 'upload') { files = []; }
    const nid = nextOf(current);
    if (!nid) return;
    goForward(nid);
  }
  function goForward(nid) {
    // If the visitor came back to edit and the route from here is unchanged, keep the trail ahead.
    if (future.length && future[0] === nid) future.shift(); else future = [];
    history.push(nid);
    window.history.pushState({ n: history.length }, '');
    show(nid, 'forward');
    savePartial();
  }
  function back() {
    if (busy || history.length < 2) return;
    stepBack(history.length - 2);
    window.history.pushState({ n: history.length }, '');
  }
  function jumpBack(id) {
    const i = history.indexOf(id);
    if (i < 0) return;
    stepBack(i);
    window.history.pushState({ n: history.length }, '');
  }
  function stepBack(i) {
    future = history.slice(i + 1).concat(future);
    history = history.slice(0, i + 1);
    show(history[i], 'back');
  }
  // How far the saved trail is still valid given the current answers.
  function validFuture() {
    const out = [];
    let from = current;
    for (const id of future) {
      let nid = nextOf(from);
      if (nid === 'service' && preService && answers.service) nid = 'also_interested';
      if (nid !== id) break;
      out.push(id); from = byId[id];
    }
    return out;
  }
  function returnAhead() {
    if (busy || !current) return;
    if (current.pattern !== 'statement' && !validate(current)) return;
    const trail = validFuture();
    if (!trail.length) return;
    future = [];
    history = history.concat(trail);
    window.history.pushState({ n: history.length }, '');
    show(history[history.length - 1], 'forward');
  }
  function onPop(e) {
    if (busy || submitted) return;
    const n = e.state && e.state.n;
    if (!n) return;
    if (n < history.length) { stepBack(n - 1); }
    else if (n > history.length) {
      const trail = validFuture().slice(0, n - history.length);
      if (!trail.length) { window.history.replaceState({ n: history.length }, ''); return; }
      future = future.slice(trail.length);
      history = history.concat(trail);
      show(history[history.length - 1], 'forward');
    }
  }

  function onKey(e) {
    if (!current || busy) return;
    const t = e.target;
    const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');
    if (e.key === 'Enter') {
      if (t && t.tagName === 'TEXTAREA' && e.shiftKey) return;        // newline
      if (t && t.tagName === 'A') return;
      if (current.pattern === 'upload' && t && t.classList.contains('drop')) return;
      e.preventDefault();
      advance();
      return;
    }
    if (typing) return;
    if (/^[a-pA-P]$/.test(e.key) && ['pick', 'cards', 'scrub'].includes(current.pattern) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const i = KEYS.indexOf(e.key.toUpperCase());
      const btns = document.querySelectorAll('#screens .screen:not(.leave) [role="radio"], #screens .screen:not(.leave) [role="checkbox"]');
      if (btns[i]) { e.preventDefault(); btns[i].click(); }
    }
    if ((e.key === 'Backspace' || e.key === 'ArrowLeft') && !e.metaKey && !e.altKey) { e.preventDefault(); back(); }
    if (e.key === 'ArrowRight' && !e.metaKey && !e.altKey) { e.preventDefault(); advance(); }
  }

  // ---------- saving ----------
  function cleanAnswers() {
    const clean = {};
    for (const [k, v] of Object.entries(answers)) { if (k.startsWith('_')) continue; clean[k] = Array.isArray(v) ? v : (typeof v === 'string' ? v.trim() : v); }
    clean.also_interested = Array.isArray(clean.also_interested) ? clean.also_interested : (clean.also_interested ? [clean.also_interested] : []);
    clean.also_interested = clean.also_interested.filter(v => v !== clean.service);
    delete clean.t6_uploads;   // files only go with the final send
    return clean;
  }
  // Saves what someone has entered so far as an "in progress" row, once we have an email to tie it to.
  function savePartial() {
    if (!config.endpoint || submitted || busy || !answers.contact_email || ($('#hp')?.value)) return;
    const body = JSON.stringify({ secret: config.secret || '', status: 'partial', session, last_step: current ? current.id : '', answers: cleanAnswers(), source_url: location.href.split('?')[0], user_agent: navigator.userAgent });
    const sig = body.replace(/"last_step":"[^"]*",/, '');
    if (sig === lastSaved) return;
    lastSaved = sig;
    try {
      const sent = navigator.sendBeacon && navigator.sendBeacon(config.endpoint, new Blob([body], { type: 'text/plain;charset=utf-8' }));
      if (!sent) fetch(config.endpoint, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
    } catch (_) {}
  }

  // ---------- submit ----------
  async function submit() {
    if (busy) return;
    const btn = $('#go');
    if (!config.endpoint) { toast(`This form isn't wired up yet. Email us at <a href="mailto:${form.meta.contactEmail}">${form.meta.contactEmail}</a>.`); return; }
    busy = true; btn.disabled = true; btn.textContent = 'Sending…';

    const clean = cleanAnswers();

    const uploads = [];
    try { for (const f of files) uploads.push({ name: f.name, type: f.type, data: await toBase64(f) }); }
    catch (_) { toast('One of the files would not read. Send it by email after and we will attach it.'); }

    const payload = { secret: config.secret || '', status: 'complete', session, last_step: current.id, answers: clean, uploads, source_url: location.href.split('?')[0], user_agent: navigator.userAgent, hp: $('#hp')?.value || '' };
    if (payload.hp) { finish(); return; } // bot filled the honeypot: pretend

    try {
      const res = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
      let ok = res.ok;
      try { const j = await res.json(); ok = ok && j.ok !== false; if (j.ok === false) throw new Error(j.error || 'rejected'); } catch (e) { if (e.message && e.message !== 'rejected' && !ok) throw e; }
      if (!ok) throw new Error('bad response');
      finish();
    } catch (err) {
      // CORS or network hiccup: fire once more without reading the response, then treat as sent.
      try { await fetch(config.endpoint, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }); finish(true); }
      catch (_) {
        busy = false; btn.disabled = false; btn.textContent = current.button || 'Send it';
        toast(`That didn't send. Try again in a moment, or email us at <a href="mailto:${form.meta.contactEmail}">${form.meta.contactEmail}</a> and we'll take it from there.`);
      }
    }
  }
  function finish(uncertain) {
    submitted = true; busy = false;
    try { localStorage.removeItem(STORE); } catch (_) {}
    session = '';
    history.push('thanks');
    show('thanks', 'forward');
    if (uncertain) toast(`Sent. If you don't hear from us in a few days, nudge <a href="mailto:${form.meta.contactEmail}">${form.meta.contactEmail}</a>.`);
  }
  const toBase64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });

  // ---------- misc ----------
  let toastTimer;
  function toast(html) {
    const t = $('#toast'); t.innerHTML = html; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 7000);
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  boot().catch(err => { console.error(err); document.body.innerHTML = `<p style="padding:40px;font-family:sans-serif">Something didn't load. Email us at hello@coeverything.co and we'll sort it out.</p>`; });
})();
