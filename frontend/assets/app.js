/* Shell: session, routing, fetching, events, and the interactive layer
   (peek drawer, command search, tour, tooltips, modals). */

const App = (() => {
  let user = null, csrf = null, filters = {}, kpis = {};
  let wlRows = [], govCache = null;
  const state = { sort: 'priority_score', dir: -1, band: '', site: '', department: '', search: '',
                  segBy: 'Site', shown: 200, peek: '', fairBy: 'Site', wfBand: '' };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const el = id => document.getElementById(id);
  const view = () => el('view');
  const I = (n, s = 18) => Icons.get(n, s);
  const esc = s => Chart.esc(s);
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } }
  };

  const ROUTES = [
    { path: '/', icon: 'overview', label: 'Overview', title: 'Overview', sub: 'Where the workforce stands this week',
      help: 'This week in one sentence, everyone on one strip, and who to call first.' },
    { path: '/watchlist', icon: 'watchlist', label: 'Watchlist', title: 'Watchlist', sub: 'Everyone, ranked by who needs a conversation first',
      help: 'Filter, search, sort any column and take a quick look at anyone.' },
    { path: '/early', icon: 'newjoiner', label: 'New joiners', title: 'New joiners', sub: 'The first 30 days and the hiring channels behind them',
      help: 'Where new hires are lost, and which hiring channels keep people.' },
    { path: '/segments', icon: 'segments', label: 'Compare groups', title: 'Compare groups', sub: 'Risk by site, department, channel and tenure',
      help: 'Compare sites, departments, roles and tenure groups side by side.' },
    { path: '/anomalies', icon: 'anomaly', label: 'Unusual change', title: 'Unusual change', sub: 'Sudden behaviour change and fast-rising risk',
      help: 'People whose behaviour suddenly changed or whose risk jumped.' },
    { path: '/interventions', icon: 'actions', label: 'Actions', title: 'Retention actions', sub: 'What was tried, and what followed',
      help: 'Every logged conversation, its outcome, and which actions work.' },
    { path: '/governance', icon: 'shield', label: 'Model health', title: 'Model health', sub: 'How far to trust the scores, and where not to',
      help: 'Lead time, accuracy with intervals, honesty of the percentages, fairness and drift.' },
    { path: '/copilot', icon: 'chat', label: 'Ask', title: 'Ask', sub: 'Questions answered from the scored data',
      help: 'Ask in plain English and get answers built from live data.' },
    { path: '/help', icon: 'book', label: 'Guide', title: 'Guide', sub: 'How to use this in ten minutes a week',
      help: 'The weekly routine, what every page is for, and the words used.' },
  ];
  const GROUPS = [
    { name: 'Monitor', items: ['/', '/watchlist', '/early'] },
    { name: 'Analyse', items: ['/segments', '/anomalies'] },
    { name: 'Act', items: ['/interventions', '/copilot'] },
    { name: 'Trust', items: ['/governance', '/help'] },
  ];

  /* ------------------------------------------------------------- fetching */
  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...options };
    if (csrf && opts.method && opts.method !== 'GET') opts.headers['x-csrf-token'] = csrf;
    const res = await fetch(path, opts);
    if (res.status === 401 && !path.startsWith('/api/auth/')) { showGate(); throw new Error('Your session ended. Sign in again to continue.'); }
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (e) { }
      throw new Error(detail);
    }
    return res.status === 204 ? null : res.json();
  }

  function toast(message, kind = 'ok') {
    const t = el('toast');
    t.className = 'toast' + (kind === 'err' ? ' err' : '');
    t.innerHTML = `<span class="t-ic">${I(kind === 'err' ? 'alert' : 'check', 16)}</span><span>${esc(message)}</span>`;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  /* ----------------------------------------------------------------- theme */
  const isDark = () => {
    const a = document.documentElement.getAttribute('data-theme');
    return a ? a === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  function setTheme(mode, persist = true) {
    if (mode) document.documentElement.setAttribute('data-theme', mode);
    if (persist && mode) store.set('ri-theme', mode);
    const dark = isDark(), btn = el('theme');
    btn.innerHTML = I(dark ? 'sun' : 'moon');
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.title = dark ? 'Switch to light' : 'Switch to dark';
    Chart.syncPalette();
  }

  /* ------------------------------------------------------------------ gate */
  function showGate() {
    el('gate').hidden = false; el('app').hidden = true;
    closeDrawer(); endTour();
    buildGateStrip();
  }

  function buildGateStrip() {
    const box = el('gate-strip');
    if (!box || box.children.length) return;
    // a stylised workforce: mostly low risk, a thin tail of high risk, sorted
    const n = innerWidth < 760 ? 168 : 280, cells = [];
    for (let i = 0; i < n; i++) {
      const q = i / n;
      cells.push(`<i class="${q < 0.05 ? 'Critical' : q < 0.15 ? 'High' : q < 0.4 ? 'Medium' : ''}" style="--k:${i}"></i>`);
    }
    box.innerHTML = cells.join('');
  }

  async function boot() {
    Icons.hydrate();
    setTheme(document.documentElement.getAttribute('data-theme'), false);
    if (store.get('ri-rail') === 'collapsed') el('app').classList.add('collapsed');
    try {
      user = await api('/api/auth/me');
      csrf = user.csrf;
      await enter();
    } catch (e) {
      showGate();
    }
  }

  async function signIn(username, password) {
    const err = el('login-error'), btn = el('login-btn');
    err.hidden = true; btn.disabled = true;
    try {
      user = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      csrf = user.csrf;
      await enter();
      toast(`Signed in as ${user.full_name}`);
    } catch (e) {
      err.textContent = e.message === 'Username or password is incorrect' ? 'That username and password do not match. Try again or pick a demo account.' : e.message;
      err.hidden = false;
    }
    btn.disabled = false;
  }

  async function enter() {
    el('gate').hidden = true; el('app').hidden = false;
    const initials = (user.full_name || user.username).split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    el('avatar').textContent = initials;
    el('rail-user').innerHTML = `<b>${esc(user.full_name)}</b><span class="role-tag">${esc(user.role.replace('_', ' '))}</span>`;
    el('rescore').hidden = user.role !== 'admin';
    renderNav();
    const [f] = await Promise.allSettled([api('/api/filters')]);
    filters = f.status === 'fulfilled' ? f.value : {};
    await route();
  }

  function renderNav() {
    el('nav').innerHTML = GROUPS.map(g => `<div class="nav-group"><span>${g.name}</span>${g.items.map(p => {
      const r = ROUTES.find(x => x.path === p);
      return `<a href="#${r.path}" data-path="${r.path}" title="${esc(r.label)}">${I(r.icon, 17)}<span>${esc(r.label)}</span>
        <span class="count" data-count="${r.path}"></span></a>`;
    }).join('')}</div>`).join('');
  }

  function setChrome(r) {
    document.querySelectorAll('#nav a').forEach(a => {
      const on = a.dataset.path === r.path;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    el('crumb').innerHTML = `<h1>${esc(r.title)}</h1><p>${esc(r.sub)}</p>`;
    document.title = `${r.title} | Retention Intelligence`;
    el('app').classList.remove('menu-open');
  }

  /* Insert a page, then draw its charts at their real width. */
  function render(html) {
    view().innerHTML = html;
    Chart.mount(view());
  }

  function loading() {
    Chart.reset();
    view().innerHTML = `<div class="skeleton" aria-busy="true" aria-label="Loading">
      <div class="sk" style="height:96px"></div><div class="sk" style="height:110px"></div><div class="sk" style="height:300px"></div></div>`;
  }

  function updateCounts() {
    const map = { '/watchlist': kpis.critical, '/anomalies': kpis.anomalies, '/early': kpis.in_first_30_days };
    document.querySelectorAll('#nav .count').forEach(s => {
      const v = map[s.dataset.count];
      s.textContent = v ? v : '';
      s.classList.toggle('hot', s.dataset.count === '/watchlist' && !!v);
      s.title = s.dataset.count === '/watchlist' ? 'people in the Critical band' : '';
    });
    el('meta-asof').innerHTML = kpis.as_of ? `Scored <b>${esc(kpis.as_of)}</b>` : '';
    el('meta-asof').title = kpis.as_of ? `Latest scoring run ${kpis.as_of}, model ${kpis.model_version || ''}` : '';
  }

  /* --------------------------------------------------------------- routing */
  async function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const empMatch = hash.match(/^\/employee\/(.+)$/);
    const def = ROUTES.find(r => r.path === hash) || ROUTES[0];
    hideTip(); closeDrawer();

    if (empMatch) {
      setChrome({ path: '/watchlist', title: 'Employee', sub: 'Risk, reasons, history and actions' });
      return showEmployee(decodeURIComponent(empMatch[1]));
    }
    setChrome(def);
    loading();
    try {
      switch (def.path) {
        case '/': {
          const [d, wf] = await Promise.all([api('/api/overview'), api('/api/workforce').catch(() => null)]);
          kpis = d.kpis || {};
          render(hintBar() + Views.overview(d, user, wf));
          if (state.wfBand) highlightBand(state.wfBand);
          break;
        }
        case '/watchlist': await showWatchlist(true); break;
        case '/early': render(Views.early(await api('/api/early-attrition'))); break;
        case '/segments': await showSegments(state.segBy); break;
        case '/anomalies': render(Views.anomalies(await api('/api/anomalies'))); break;
        case '/interventions': render(Views.interventions(await api('/api/interventions'), canAct())); break;
        case '/governance': govCache = await api('/api/governance'); render(Views.governance(govCache, state)); break;
        case '/copilot': render(Views.copilot()); break;
        case '/help': render(Views.help(ROUTES, GROUPS)); break;
      }
      if (!kpis.as_of) { try { kpis = (await api('/api/overview')).kpis || {}; } catch (e) { } }
      updateCounts();
    } catch (e) {
      view().innerHTML = `<div class="panel"><div class="empty-state"><span class="e-ic">${I('alert', 20)}</span>
        <b>This page did not load</b><p>${esc(e.message)}</p>
        <button class="btn btn-sm" onclick="App.route()">${I('refresh', 15)} Try again</button></div></div>`;
    }
    view().focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  function hintBar() {
    if (store.get('ri-hint-done')) return '';
    return `<div class="hintbar" id="hintbar" style="margin-bottom:20px">${I('compass', 18)}
      <span>New here? A one-minute tour shows where everything is.</span><span class="spacer"></span>
      <button class="btn btn-sm btn-primary" id="hint-tour">Take the tour</button>
      <button class="btn btn-sm btn-ghost" id="hint-dismiss">Not now</button></div>`;
  }

  async function showWatchlist(fresh = false) {
    if (fresh) {
      loading();
      const q = new URLSearchParams({ limit: 5000, sort: 'priority_score' });
      ['band', 'site', 'department', 'search'].forEach(k => { if (state[k]) q.set(k, state[k]); });
      wlRows = await api('/api/watchlist?' + q);
      if (!kpis.as_of) { try { kpis = (await api('/api/overview')).kpis || {}; } catch (e) { } }
    }
    render(Views.watchlist(wlRows, filters, state, kpis));
  }

  async function refilter() {
    state.shown = 200;
    const box = el('wl-search'), focused = document.activeElement === box, caret = box ? box.selectionStart : 0;
    const q = new URLSearchParams({ limit: 5000, sort: 'priority_score' });
    ['band', 'site', 'department', 'search'].forEach(k => { if (state[k]) q.set(k, state[k]); });
    wlRows = await api('/api/watchlist?' + q);
    render(Views.watchlist(wlRows, filters, state, kpis));
    if (focused) { const b = el('wl-search'); b.focus(); b.setSelectionRange(caret, caret); }
  }

  async function showSegments(by) {
    state.segBy = by;
    render(Views.segments(await api('/api/segments?by=' + encodeURIComponent(by)), by));
  }

  async function showEmployee(id) {
    loading();
    try {
      const d = await api('/api/employees/' + encodeURIComponent(id));
      render(Views.employee(d, canAct()));
      view()._employee = id;
    } catch (e) {
      view().innerHTML = `<div class="panel"><div class="empty-state"><span class="e-ic">${I('search', 20)}</span>
        <b>No employee called ${esc(id)}</b><p>Check the ID, or search for them by role or site.</p>
        <a class="btn btn-sm" href="#/watchlist">Go to the watchlist</a></div></div>`;
    }
    window.scrollTo({ top: 0 });
  }

  const canAct = () => user && (user.role === 'admin' || user.role === 'hr_manager');

  /* ---------------------------------------------------------- peek drawer */
  let drawerReturn = null;
  async function openDrawer(id) {
    drawerReturn = document.activeElement;
    state.peek = id;
    document.querySelectorAll('tr[data-peek]').forEach(r => r.classList.toggle('sel', r.dataset.peek === id));
    const root = el('drawer-root');
    const fresh = !root.querySelector('.drawer');
    if (fresh) {
      root.innerHTML = `<div class="drawer-back" data-drawer-close></div>
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="Employee summary"><div class="drawer-body">
          <div class="sk" style="height:60px"></div><div class="sk" style="height:200px"></div></div></aside>`;
    }
    try {
      const d = await api('/api/employees/' + encodeURIComponent(id));
      if (state.peek !== id) return;
      const box = root.querySelector('.drawer');
      if (box) { box.innerHTML = Views.drawer(d, canAct()); Chart.mount(box); box.querySelector('[data-drawer-close]').focus(); }
    } catch (e) { toast(e.message, 'err'); closeDrawer(); }
  }
  function closeDrawer() {
    const root = el('drawer-root');
    if (!root || !root.innerHTML) return;
    root.innerHTML = '';
    state.peek = '';
    document.querySelectorAll('tr.sel').forEach(r => r.classList.remove('sel'));
    if (drawerReturn && document.contains(drawerReturn)) drawerReturn.focus({ preventScroll: true });
  }
  function stepDrawer(dir) {
    const rows = [...document.querySelectorAll('tr[data-peek]')];
    const i = rows.findIndex(r => r.dataset.peek === state.peek);
    const next = rows[i + dir];
    if (next) { next.scrollIntoView({ block: 'nearest' }); openDrawer(next.dataset.peek); }
  }

  /* -------------------------------------------------------- workforce strip */
  function highlightBand(b) {
    const wf = el('wf');
    if (!wf) return;
    state.wfBand = b;
    wf.classList.remove('reveal');
    wf.classList.toggle('dim', !!b);
    wf.querySelectorAll('i').forEach(c => c.classList.toggle('hl', !!b && c.classList.contains(b)));
    document.querySelectorAll('[data-wf-band]').forEach(x => x.classList.toggle('on', x.dataset.wfBand === b));
  }

  /* ---------------------------------------------------------------- copilot */
  async function ask(question) {
    const chat = el('chat');
    if (!chat) return;
    chat.insertAdjacentHTML('beforeend', `<div class="msg you"><pre>${esc(question)}</pre></div>`);
    chat.insertAdjacentHTML('beforeend', `<div class="msg bot" id="pending"><span class="who">${I('spark', 15)}</span>
      <div><span class="typing" aria-label="Working on it"><i></i><i></i><i></i></span></div></div>`);
    chat.scrollTop = chat.scrollHeight;
    try {
      const d = await api('/api/copilot/ask', { method: 'POST', body: JSON.stringify({ question }) });
      el('pending').outerHTML = `<div class="msg bot"><span class="who">${I('spark', 15)}</span><div>
        <pre>${esc(d.answer)}</pre><div class="src">Answered from ${esc(d.source)} data</div></div></div>`;
    } catch (e) {
      el('pending').outerHTML = `<div class="msg bot"><span class="who">${I('alert', 15)}</span><div><pre>${esc(e.message)}</pre></div></div>`;
    }
    chat.scrollTop = chat.scrollHeight;
  }

  /* ----------------------------------------------------------------- modals */
  function modal(html, onClick) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.addEventListener('click', ev => {
      if (ev.target === back || ev.target.closest('[data-close]')) return close();
      onClick && onClick(ev, close, back);
    });
    back._close = close;
    setTimeout(() => { const f = back.querySelector('select, input, textarea, button.choice'); f && f.focus(); }, 30);
    return back;
  }

  function actionModal(employeeId) {
    const actions = ['Manager conversation', 'Workload and roster review', 'Career discussion', 'Onboarding catch-up',
      'Pay or benchmark review', 'Site or shift change', 'Training assignment', 'Skip-level meeting'];
    const due = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    modal(`
      <h2>Log a retention action</h2>
      <p class="sub">For ${esc(employeeId)}. Record the outcome later under Actions.</p>
      <label for="m-action">What are you doing?</label>
      <select id="m-action">${actions.map(a => `<option>${a}</option>`).join('')}</select>
      <label for="m-owner">Who owns it?</label>
      <input id="m-owner" value="${esc(user.full_name)}">
      <label for="m-due">Follow up by</label>
      <input id="m-due" type="date" value="${due}">
      <label for="m-notes">Notes (optional)</label>
      <textarea id="m-notes" rows="3" placeholder="What is being addressed"></textarea>
      <div class="row" style="margin-top:18px;justify-content:flex-end">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" data-save>Log action</button>
      </div>`, async (ev, close) => {
      if (!ev.target.closest('[data-save]')) return;
      try {
        await api('/api/interventions', { method: 'POST', body: JSON.stringify({
          EmployeeID: employeeId, action: el('m-action').value, owner: el('m-owner').value,
          due_date: el('m-due').value || null, notes: el('m-notes').value }) });
        close(); toast('Action logged');
        if (state.peek === employeeId) openDrawer(employeeId);
        else if (location.hash.startsWith('#/employee/')) showEmployee(employeeId);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function outcomeModal(id, emp) {
    const opts = [['Retained', 'They stayed'], ['In Progress', 'Still working on it'], ['No Change', 'Nothing changed yet'], ['Exited', 'They left']];
    let pick = 'Retained';
    modal(`
      <h2>Record the outcome</h2>
      <p class="sub">Action ${esc(id)} for ${esc(emp || '')}. What happened after the action?</p>
      <div class="choices">${opts.map(([v, t], i) => `<button class="choice ${i === 0 ? 'on' : ''}" data-v="${v}">
        <span><b>${v}</b><br><span class="sub">${t}</span></span></button>`).join('')}</div>
      <label for="o-notes">Notes (optional)</label>
      <textarea id="o-notes" rows="2" placeholder="Anything worth remembering"></textarea>
      <div class="row" style="margin-top:18px;justify-content:flex-end">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" data-save>Record outcome</button>
      </div>`, async (ev, close, back) => {
      const c = ev.target.closest('.choice');
      if (c) { pick = c.dataset.v; back.querySelectorAll('.choice').forEach(b => b.classList.toggle('on', b === c)); return; }
      if (!ev.target.closest('[data-save]')) return;
      try {
        await api('/api/interventions/' + id, { method: 'PATCH', body: JSON.stringify({ outcome: pick, notes: el('o-notes').value || null }) });
        close(); toast(`Outcome recorded: ${pick}`); route();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  /* --------------------------------------------------------- command search */
  let palTimer, palItems = [], palSel = 0;
  function openPalette(seed = '') {
    if (document.querySelector('.palette')) return;
    const back = modal(`<div></div>`);
    back.classList.add('palette-back');
    const box = back.querySelector('.modal');
    box.className = 'palette';
    box.innerHTML = `<div class="p-in">${I('search')}<input id="p-q" placeholder="Type an employee ID, role, site or page" autocomplete="off" aria-label="Search"></div>
      <div class="p-list" id="p-list" role="listbox"></div>
      <div class="p-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>`;
    const input = box.querySelector('#p-q');
    input.value = seed; input.focus();
    const render = emps => {
      const q = input.value.trim().toLowerCase();
      const pages = ROUTES.filter(r => !q || (r.label + ' ' + r.title + ' ' + r.help).toLowerCase().includes(q)).slice(0, q ? 5 : 9);
      palItems = [...pages.map(r => ({ href: '#' + r.path })), ...(emps || []).map(e => ({ href: '#/employee/' + encodeURIComponent(e.EmployeeID) }))];
      palSel = Math.min(palSel, Math.max(palItems.length - 1, 0));
      let i = 0;
      box.querySelector('#p-list').innerHTML =
        (pages.length ? `<div class="p-sec">Pages</div>` + pages.map(r => `<div class="p-item" data-i="${i++}" role="option">
          <span class="p-ic">${I(r.icon, 15)}</span><div><b>${esc(r.label)}</b><small>${esc(r.help)}</small></div></div>`).join('') : '') +
        ((emps || []).length ? `<div class="p-sec">People</div>` + emps.map(e => `<div class="p-item" data-i="${i++}" role="option">
          <span class="p-ic">${I('user', 15)}</span><div><b>${esc(e.EmployeeID)}, ${esc(e.Position)}</b>
          <small>${esc(e.Department)}, ${esc(e.Site)}</small></div>${e.risk_band ? `<span class="band b-${esc(e.risk_band)}">${esc(e.risk_band)}</span>` : ''}</div>`).join('') : '') +
        (!palItems.length ? `<div class="empty-state"><b>No matches</b><p>Try an ID such as EMP11691, a role or a site.</p></div>` : '');
      highlight();
    };
    const highlight = () => box.querySelectorAll('.p-item').forEach(n => {
      const on = +n.dataset.i === palSel; n.classList.toggle('sel', on);
      if (on) n.scrollIntoView({ block: 'nearest' });
    });
    const go = () => { const it = palItems[palSel]; if (!it) return; back._close(); location.hash = it.href.slice(1); };
    const lookup = () => {
      clearTimeout(palTimer);
      const q = input.value.trim();
      render([]);
      if (q.length < 2) return;
      palTimer = setTimeout(async () => {
        try { render(await api('/api/watchlist?' + new URLSearchParams({ search: q, limit: 6 }))); } catch (e) { }
      }, 160);
    };
    input.addEventListener('input', () => { palSel = 0; lookup(); });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown') { palSel = Math.min(palSel + 1, palItems.length - 1); highlight(); ev.preventDefault(); }
      if (ev.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); highlight(); ev.preventDefault(); }
      if (ev.key === 'Enter') { go(); ev.preventDefault(); }
    });
    box.addEventListener('click', ev => { const it = ev.target.closest('.p-item'); if (it) { palSel = +it.dataset.i; go(); } });
    box.addEventListener('mousemove', ev => { const it = ev.target.closest('.p-item'); if (it && +it.dataset.i !== palSel) { palSel = +it.dataset.i; highlight(); } });
    lookup();
  }

  /* -------------------------------------------------------------------- tour */
  const TOUR = [
    { sel: '#briefing', title: 'This week in one sentence', text: 'Each underlined number opens the people behind it.' },
    { sel: '#stats', title: 'The numbers that matter', text: 'Hover the (i) icons for a plain explanation. Most tiles open the page behind them.' },
    { sel: '#workforce-panel', title: 'Everyone, one square each', text: 'Darker squares are more likely to resign. Hover to identify, click for a quick look.' },
    { sel: '#call-first', title: 'Who to call first', text: 'Risk weighted by how hard the role is to replace. Click a row for the reasons and next steps.' },
    { sel: '#trust-panel', title: 'How much to trust it', text: 'Checked on a period the model never saw, including where it reads low.' },
    { sel: '#search-open', title: 'Find anyone fast', text: 'Type an ID, role, site or page. Shortcut: Ctrl K.' },
  ];
  let tourIdx = -1, tourEls = null, tourSteps = [];
  const visible = n => { if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  async function startTour() {
    if (el('app').hidden) return;
    store.set('ri-hint-done', '1');
    const hb = el('hintbar'); if (hb) hb.remove();
    if (location.hash !== '' && location.hash !== '#/') { location.hash = '/'; await new Promise(r => setTimeout(r, 800)); }
    endTour();
    tourSteps = TOUR.filter(s => visible(document.querySelector(s.sel)));
    if (!tourSteps.length) return;
    const hole = document.createElement('div'); hole.className = 'tour-hole';
    const pop = document.createElement('div'); pop.className = 'tour-pop'; pop.setAttribute('role', 'dialog');
    const catcher = document.createElement('div'); catcher.style.cssText = 'position:fixed;inset:0;z-index:79';
    document.body.append(catcher, hole, pop);
    tourEls = { hole, pop, catcher };
    catcher.addEventListener('click', () => tourStep(tourIdx + 1));
    pop.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.t === 'next') tourStep(tourIdx + 1);
      if (b.dataset.t === 'prev') tourStep(tourIdx - 1);
      if (b.dataset.t === 'skip') endTour();
    });
    tourStep(0);
  }
  function tourStep(i) {
    if (!tourEls) return;
    if (i >= tourSteps.length) return endTour();
    tourIdx = Math.max(0, i);
    const s = tourSteps[tourIdx], target = document.querySelector(s.sel);
    if (!target) return endTour();
    target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    const last = tourIdx === tourSteps.length - 1;
    tourEls.pop.innerHTML = `<div class="t-step">${tourIdx + 1} of ${tourSteps.length}</div>
      <h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>
      <div class="row">${last ? '' : '<button class="btn btn-sm btn-ghost" data-t="skip">Skip</button>'}<span class="spacer"></span>
      ${tourIdx ? `<button class="btn btn-sm" data-t="prev">Back</button>` : ''}
      <button class="btn btn-sm btn-primary" data-t="next">${last ? 'Done' : 'Next'}</button></div>`;
    setTimeout(placeTour, reduced ? 0 : 350);
    placeTour();
  }
  function placeTour() {
    if (!tourEls || tourIdx < 0) return;
    const target = document.querySelector(tourSteps[tourIdx].sel);
    if (!target) return;
    const r = target.getBoundingClientRect(), pad = 6;
    const top = Math.max(r.top - pad, 4), bottom = Math.min(r.bottom + pad, innerHeight - 4);
    Object.assign(tourEls.hole.style, { left: `${r.left - pad}px`, top: `${top}px`, width: `${r.width + pad * 2}px`, height: `${bottom - top}px` });
    const pop = tourEls.pop, pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 12;
    let x, y;
    if (bottom + gap + ph < innerHeight) { y = bottom + gap; x = r.left; }
    else if (top - gap - ph > 0) { y = top - gap - ph; x = r.left; }
    else { y = innerHeight - ph - 16; x = r.left + 16; }
    pop.style.left = Math.min(Math.max(x, 16), innerWidth - pw - 16) + 'px';
    pop.style.top = Math.min(Math.max(y, 16), innerHeight - ph - 16) + 'px';
  }
  function endTour() {
    if (tourEls) { Object.values(tourEls).forEach(n => n.remove()); tourEls = null; }
    tourIdx = -1;
  }

  /* ---------------------------------------------------------------- tooltips
     data-tip: plain text, anchored to the element (the (i) icons).
     data-tip-h: trusted HTML built by Chart/Views with esc(), follows the pointer. */
  function showTip(target, ev) {
    const box = el('tipbox');
    if (target.dataset.tipH) box.innerHTML = target.dataset.tipH; else box.textContent = target.dataset.tip;
    box.hidden = false;
    const bw = box.offsetWidth, bh = box.offsetHeight;
    let x, y;
    if (ev && target.dataset.tipH) { x = ev.clientX + 14; y = ev.clientY + 14; if (x + bw > innerWidth - 8) x = ev.clientX - bw - 14; if (y + bh > innerHeight - 8) y = ev.clientY - bh - 14; }
    else { const r = target.getBoundingClientRect(); x = r.left + r.width / 2 - bw / 2; y = r.top - bh - 8; if (y < 8) y = r.bottom + 8; }
    box.style.left = Math.min(Math.max(x, 8), innerWidth - bw - 8) + 'px';
    box.style.top = Math.max(y, 8) + 'px';
    box._for = target;
  }
  function hideTip() { const b = el('tipbox'); if (b) { b.hidden = true; b._for = null; } }

  /* ------------------------------------------------------------------ events */
  function wire() {
    el('login-form').addEventListener('submit', ev => { ev.preventDefault(); signIn(el('username').value, el('password').value); });
    el('pw-toggle').addEventListener('click', () => {
      const p = el('password'), show = p.type === 'password';
      p.type = show ? 'text' : 'password';
      el('pw-toggle').innerHTML = I(show ? 'eyeOff' : 'eye', 16);
      el('pw-toggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    document.querySelectorAll('.gate-accounts .acct').forEach(c => c.addEventListener('click', () => {
      el('username').value = c.dataset.user; el('password').value = c.dataset.pass;
      signIn(c.dataset.user, c.dataset.pass);
    }));
    // Public deployments lock some accounts with private passwords: only offer the
    // demo accounts the server says still use their demo password.
    fetch('/api/health').then(r => r.json()).then(h => {
      if (Array.isArray(h.demo_accounts)) {
        const open = new Set(h.demo_accounts);
        document.querySelectorAll('.gate-accounts .acct').forEach(c => { if (!open.has(c.dataset.user)) c.hidden = true; });
      }
      if (h.lead_time_4w != null) {
        const f = el('gate-facts').firstElementChild;
        f.innerHTML = `<b>${Math.round(h.lead_time_4w * 100)}%</b><span>of leavers flagged four weeks before resigning (random: ${Math.round((h.random_baseline || .15) * 100)}%)</span>`;
      }
    }).catch(() => {});

    el('theme').addEventListener('click', () => { setTheme(isDark() ? 'light' : 'dark'); route(); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!document.documentElement.getAttribute('data-theme')) { setTheme(null, false); if (!el('app').hidden) route(); }
    });
    el('logout').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { }
      user = null; csrf = null; location.hash = '/'; showGate(); toast('Signed out');
    });
    el('rescore').addEventListener('click', async () => {
      const b = el('rescore');
      b.disabled = true; b.classList.add('busy'); b.querySelector('span').textContent = 'Scoring';
      try {
        const r = await api('/api/score/run', { method: 'POST' });
        toast(`Scored ${r.n} employees as of ${r.as_of}`);
        kpis = {}; await route();
      } catch (e) { toast(e.message, 'err'); }
      b.disabled = false; b.classList.remove('busy'); b.querySelector('span').textContent = 'Re-score';
    });
    el('collapse').addEventListener('click', () => {
      const c = el('app').classList.toggle('collapsed');
      store.set('ri-rail', c ? 'collapsed' : 'open');
      el('collapse').title = c ? 'Expand menu' : 'Collapse menu';
    });
    el('menu').addEventListener('click', () => el('app').classList.add('menu-open'));
    el('rail-scrim').addEventListener('click', () => el('app').classList.remove('menu-open'));
    el('search-open').addEventListener('click', () => openPalette());
    el('help').addEventListener('click', () => startTour());
    window.addEventListener('hashchange', route);
    let resizeTimer;
    window.addEventListener('resize', () => {
      placeTour(); hideTip();
      clearTimeout(resizeTimer); resizeTimer = setTimeout(() => Chart.mount(document), 120);
    });
    window.addEventListener('scroll', hideTip, { passive: true });

    document.addEventListener('mouseover', ev => {
      const t = ev.target.closest('[data-tip], [data-tip-h]');
      if (t) showTip(t, ev);
    });
    document.addEventListener('mousemove', ev => {
      const b = el('tipbox');
      if (!b.hidden && b._for && b._for.dataset.tipH && b._for.contains(ev.target)) showTip(b._for, ev);
    });
    document.addEventListener('mouseout', ev => {
      const t = ev.target.closest('[data-tip], [data-tip-h]');
      if (t && !t.contains(ev.relatedTarget)) hideTip();
    });
    document.addEventListener('focusin', ev => { const t = ev.target.closest('[data-tip]'); if (t) showTip(t); });
    document.addEventListener('focusout', ev => { if (ev.target.closest('[data-tip]')) hideTip(); });

    document.addEventListener('click', ev => {
      const tipBtn = ev.target.closest('.tip');
      if (tipBtn) {                       // tap toggles on touch; never triggers the card underneath
        ev.preventDefault(); ev.stopPropagation();
        const b = el('tipbox'); b._for === tipBtn && !b.hidden ? hideTip() : showTip(tipBtn);
        return;
      }
      hideTip();
      const t = ev.target;

      if (t.closest('[data-drawer-close]')) { closeDrawer(); return; }
      const logBtn = t.closest('[data-log-action]');
      if (logBtn) { actionModal(logBtn.dataset.logAction); return; }

      const peek = t.closest('[data-peek]');
      if (peek && !t.closest('a, button')) { openDrawer(peek.dataset.peek); return; }
      const cell = t.closest('.wf i[data-emp]');
      if (cell) { openDrawer(cell.dataset.emp); return; }

      const wfBand = t.closest('[data-wf-band]');
      if (wfBand) { highlightBand(state.wfBand === wfBand.dataset.wfBand ? '' : wfBand.dataset.wfBand); return; }

      const bandLink = t.closest('[data-band-link]');
      if (bandLink) { Object.assign(state, { band: bandLink.dataset.bandLink, site: '', department: '', search: '', shown: 200 }); return; }

      const chip = t.closest('[data-band-chip]');
      if (chip) { state.band = chip.dataset.bandChip; refilter(); return; }

      const clear = t.closest('[data-clear]');
      if (clear) {
        const k = clear.dataset.clear;
        if (k === 'all') Object.assign(state, { site: '', department: '', search: '' }); else state[k] = '';
        refilter(); return;
      }

      const sortBtn = t.closest('button.sort');
      if (sortBtn) {
        const key = sortBtn.dataset.sort;
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = ['EmployeeID', 'Position', 'Site', 'EmploymentType'].includes(key) ? 1 : -1; }
        showWatchlist(); return;
      }
      if (t.closest('#wl-more')) { state.shown += 200; showWatchlist(); return; }

      const segBtn = t.closest('#seg-switch button');
      if (segBtn) { showSegments(segBtn.dataset.by); return; }

      const fairBtn = t.closest('#fair-switch button');
      if (fairBtn && govCache) {
        state.fairBy = fairBtn.dataset.fair;
        const y = scrollY; render(Views.governance(govCache, state)); scrollTo({ top: y }); return;
      }

      const suggest = t.closest('.suggests button');
      if (suggest) { ask(suggest.dataset.q); return; }

      if (t.closest('#go-back')) { if (history.length > 1) history.back(); else location.hash = '/watchlist'; return; }
      if (t.closest('#start-tour') || t.closest('#hint-tour')) { startTour(); return; }
      if (t.closest('#hint-dismiss')) { store.set('ri-hint-done', '1'); el('hintbar').remove(); return; }

      const closeBtn = t.closest('.close-int');
      if (closeBtn) { outcomeModal(closeBtn.dataset.id, closeBtn.dataset.empId); return; }
    });

    document.addEventListener('keydown', ev => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
        if (!el('app').hidden) { ev.preventDefault(); openPalette(); }
        return;
      }
      if (ev.key === 'Escape') {
        const m = document.querySelector('.modal-back'); if (m) { m.remove(); return; }
        if (tourEls) { endTour(); return; }
        if (state.peek) { closeDrawer(); return; }
        el('app').classList.remove('menu-open'); hideTip();
        return;
      }
      if (tourEls && (ev.key === 'ArrowRight' || ev.key === 'Enter')) { ev.preventDefault(); tourStep(tourIdx + 1); return; }
      if (tourEls && ev.key === 'ArrowLeft') { tourStep(tourIdx - 1); return; }
      if (typing || el('app').hidden || document.querySelector('.modal-back')) return;
      if (state.peek && (ev.key === 'j' || ev.key === 'ArrowDown')) { ev.preventDefault(); stepDrawer(1); return; }
      if (state.peek && (ev.key === 'k' || ev.key === 'ArrowUp')) { ev.preventDefault(); stepDrawer(-1); return; }
      if (ev.key === '/') { ev.preventDefault(); openPalette(); }
      if (ev.key === '?') { location.hash = '/help'; }
      const row = ev.target.closest && ev.target.closest('[data-peek]');
      if (row && ev.key === 'Enter') openDrawer(row.dataset.peek);
    });

    document.addEventListener('change', ev => {
      if (['wl-site', 'wl-dept'].includes(ev.target.id)) {
        state.site = el('wl-site').value; state.department = el('wl-dept').value;
        refilter();
      }
    });

    let searchTimer;
    document.addEventListener('input', ev => {
      if (ev.target.id !== 'wl-search') return;
      clearTimeout(searchTimer);
      const v = ev.target.value;
      searchTimer = setTimeout(() => { state.search = v; refilter(); }, 250);
    });

    document.addEventListener('submit', ev => {
      if (ev.target.id !== 'ask-form') return;
      ev.preventDefault();
      const input = el('ask-input'), q = input.value.trim();
      if (!q) return;
      input.value = '';
      ask(q);
    });
  }

  wire();
  boot();
  return { api, toast, route, startTour };
})();
