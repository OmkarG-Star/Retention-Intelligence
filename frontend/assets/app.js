/* Shell: session, routing, fetching, events. */

const App = (() => {
  let user = null, csrf = null, filters = {}, kpis = {};
  const state = { sort: 'priority_score', band: '', site: '', department: '', search: '', segBy: 'Site' };

  const el = id => document.getElementById(id);
  const view = () => el('view');

  const ROUTES = [
    { path: '/', label: 'Overview', title: 'Overview', sub: 'Retention position across the workforce' },
    { path: '/watchlist', label: 'Watchlist', title: 'Watchlist', sub: 'Who needs a conversation first' },
    { path: '/early', label: 'Early attrition', title: 'Early attrition', sub: 'The first 30 days, and the channels behind them' },
    { path: '/segments', label: 'Segments', title: 'Segments', sub: 'Risk by site, department, channel and tenure' },
    { path: '/anomalies', label: 'Anomalies', title: 'Anomalies and movement', sub: 'Abrupt change and risk velocity' },
    { path: '/interventions', label: 'Interventions', title: 'Interventions', sub: 'What was tried, and what followed' },
    { path: '/governance', label: 'Model', title: 'Model governance', sub: 'Performance, calibration, drift and fairness' },
    { path: '/copilot', label: 'Ask', title: 'Copilot', sub: 'Questions answered from the scored warehouse' },
  ];

  /* ------------------------------------------------------------- fetching */
  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...options };
    if (csrf && opts.method && opts.method !== 'GET') opts.headers['x-csrf-token'] = csrf;
    const res = await fetch(path, opts);
    if (res.status === 401) { showGate(); throw new Error('Session expired'); }
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (e) { }
      throw new Error(detail);
    }
    return res.status === 204 ? null : res.json();
  }

  function toast(message) {
    const t = el('toast');
    t.textContent = message; t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  /* ---------------------------------------------------------------- gate */
  function showGate() {
    el('gate').hidden = false; el('app').hidden = true;
  }

  function setTheme(mode) {
    const root = document.documentElement;
    if (mode === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem('ri-theme', mode); } catch (e) { }
    const btn = el('theme');
    if (btn) {
      btn.textContent = mode === 'dark' ? 'Light' : 'Dark';
      btn.setAttribute('aria-pressed', mode === 'dark' ? 'true' : 'false');
    }
    Chart.syncPalette();
  }

  async function boot() {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    try {
      user = await api('/api/auth/me');
      csrf = user.csrf;
      await enter();
    } catch (e) {
      showGate();
    }
  }

  async function signIn(username, password) {
    const err = el('login-error');
    err.hidden = true;
    try {
      user = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      csrf = user.csrf;
      await enter();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    }
  }

  async function enter() {
    el('gate').hidden = true; el('app').hidden = false;
    el('rail-user').innerHTML = `<b>${Chart.esc(user.full_name)}</b>${Chart.esc(user.role.replace('_', ' '))}`;
    el('rescore').hidden = user.role !== 'admin';
    renderNav();
    try { filters = await api('/api/filters'); } catch (e) { filters = {}; }
    await route();
  }

  function renderNav() {
    el('nav').innerHTML = ROUTES.map(r =>
      `<li><a href="#${r.path}" data-path="${r.path}">${r.label}<span class="count" data-count="${r.path}"></span></a></li>`
    ).join('');
  }

  function setChrome(route) {
    document.querySelectorAll('#nav a').forEach(a =>
      a.classList.toggle('active', a.dataset.path === route.path));
    el('crumb').innerHTML = `<h1>${Chart.esc(route.title)}</h1><p>${Chart.esc(route.sub)}</p>`;
    document.title = `${route.title} · Retention Intelligence`;
  }

  function loading() { view().innerHTML = '<div class="loading">Loading…</div>'; }

  /* -------------------------------------------------------------- routing */
  async function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const empMatch = hash.match(/^\/employee\/(.+)$/);
    const def = ROUTES.find(r => r.path === hash) || ROUTES[0];

    if (empMatch) {
      setChrome({ path: '/watchlist', title: 'Employee record', sub: 'Risk, drivers and history' });
      return showEmployee(decodeURIComponent(empMatch[1]));
    }
    setChrome(def);
    loading();
    try {
      switch (def.path) {
        case '/': {
          const d = await api('/api/overview');
          kpis = d.kpis || {};
          view().innerHTML = Views.overview(d);
          updateCounts();
          break;
        }
        case '/watchlist': return showWatchlist();
        case '/early': view().innerHTML = Views.early(await api('/api/early-attrition')); break;
        case '/segments': return showSegments(state.segBy);
        case '/anomalies': view().innerHTML = Views.anomalies(await api('/api/anomalies')); break;
        case '/interventions': {
          const d = await api('/api/interventions');
          view().innerHTML = Views.interventions(d, canAct());
          break;
        }
        case '/governance': view().innerHTML = Views.governance(await api('/api/governance')); break;
        case '/copilot': view().innerHTML = Views.copilot(); break;
      }
      await refreshMeta();
    } catch (e) {
      view().innerHTML = `<div class="panel empty"><h2>Could not load this view</h2>
        <p style="margin-top:8px">${Chart.esc(e.message)}</p></div>`;
    }
    view().focus({ preventScroll: true });
  }

  function updateCounts() {
    const map = { '/watchlist': kpis.critical, '/anomalies': kpis.anomalies, '/early': kpis.in_first_30_days };
    document.querySelectorAll('[data-count]').forEach(s => {
      const v = map[s.dataset.count];
      s.textContent = v ? v : '';
    });
  }

  async function refreshMeta() {
    if (!kpis.as_of) {
      try { const d = await api('/api/overview'); kpis = d.kpis || {}; updateCounts(); } catch (e) { return; }
    }
    el('meta-asof').innerHTML = `scored <b>${Chart.esc(kpis.as_of || '—')}</b>`;
    el('meta-model').innerHTML = `model <b>${Chart.esc(kpis.model_version || '—')}</b>`;
  }

  async function showWatchlist() {
    loading();
    const q = new URLSearchParams({ limit: 300, sort: state.sort });
    ['band', 'site', 'department', 'search'].forEach(k => { if (state[k]) q.set(k, state[k]); });
    const rows = await api('/api/watchlist?' + q);
    view().innerHTML = Views.watchlist(rows, filters, state);
  }

  async function showSegments(by) {
    loading();
    state.segBy = by;
    view().innerHTML = Views.segments(await api('/api/segments?by=' + encodeURIComponent(by)), by);
  }

  async function showEmployee(id) {
    loading();
    try {
      const d = await api('/api/employees/' + encodeURIComponent(id));
      view().innerHTML = Views.employee(d, canAct());
      view()._employee = id;
    } catch (e) {
      view().innerHTML = `<div class="panel empty"><h2>${Chart.esc(e.message)}</h2></div>`;
    }
  }

  const canAct = () => user && (user.role === 'admin' || user.role === 'hr_manager');

  /* ----------------------------------------------------------- copilot */
  async function ask(question) {
    const chat = el('chat');
    if (!chat) return;
    chat.insertAdjacentHTML('beforeend', `<div class="msg you"><pre>${Chart.esc(question)}</pre></div>`);
    chat.insertAdjacentHTML('beforeend', `<div class="msg bot" id="pending"><pre>Querying the warehouse…</pre></div>`);
    chat.scrollTop = chat.scrollHeight;
    try {
      const d = await api('/api/copilot/ask', { method: 'POST', body: JSON.stringify({ question }) });
      el('pending').outerHTML = `<div class="msg bot"><pre>${Chart.esc(d.answer)}</pre>
        <div class="src">${Chart.esc(d.source)} · intent: ${Chart.esc(d.intent)}</div></div>`;
    } catch (e) {
      el('pending').outerHTML = `<div class="msg bot"><pre>${Chart.esc(e.message)}</pre></div>`;
    }
    chat.scrollTop = chat.scrollHeight;
  }

  /* -------------------------------------------------------- intervention */
  function actionModal(employeeId) {
    const actions = ['Manager conversation', 'Workload and roster review', 'Career discussion',
      'Onboarding catch-up', 'Pay or benchmark review', 'Site or shift change',
      'Training assignment', 'Skip-level meeting'];
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">
      <h2>Log a retention action</h2>
      <p class="sub">${Chart.esc(employeeId)}</p>
      <label for="m-action">Action</label>
      <select id="m-action">${actions.map(a => `<option>${a}</option>`).join('')}</select>
      <label for="m-owner">Owner</label>
      <input id="m-owner" placeholder="Who is doing this" value="${Chart.esc(user.full_name)}">
      <label for="m-due">Due by</label>
      <input id="m-due" type="date">
      <label for="m-notes">Notes</label>
      <textarea id="m-notes" rows="3" placeholder="What is being addressed"></textarea>
      <div class="row" style="margin-top:18px;justify-content:flex-end">
        <button class="btn" data-close>Cancel</button>
        <button class="btn btn-primary" data-save>Save action</button>
      </div></div>`;
    document.body.appendChild(back);
    back.addEventListener('click', async ev => {
      if (ev.target.dataset.close !== undefined || ev.target === back) return back.remove();
      if (ev.target.dataset.save === undefined) return;
      try {
        await api('/api/interventions', {
          method: 'POST', body: JSON.stringify({
            EmployeeID: employeeId, action: el('m-action').value, owner: el('m-owner').value,
            due_date: el('m-due').value || null, notes: el('m-notes').value
          })
        });
        back.remove();
        toast('Action logged');
        showEmployee(employeeId);
      } catch (e) { toast(e.message); }
    });
  }

  /* ------------------------------------------------------------- events */
  function wire() {
    el('login-form').addEventListener('submit', ev => {
      ev.preventDefault();
      signIn(el('username').value, el('password').value);
    });
    document.querySelectorAll('.gate-accounts .chip').forEach(c =>
      c.addEventListener('click', () => {
        el('username').value = c.dataset.user; el('password').value = c.dataset.pass;
        signIn(c.dataset.user, c.dataset.pass);
      }));
    // Public deployments protect some accounts with private passwords: only
    // advertise the demo accounts the server says still use their demo password.
    fetch('/api/health').then(r => r.json()).then(h => {
      if (!Array.isArray(h.demo_accounts)) return;
      const open = new Set(h.demo_accounts);
      document.querySelectorAll('.gate-accounts .chip').forEach(c => {
        if (!open.has(c.dataset.user)) c.hidden = true;
      });
      if (!open.has(el('username').value)) {
        const first = document.querySelector('.gate-accounts .chip:not([hidden])');
        el('username').value = first ? first.dataset.user : '';
        el('password').value = first ? first.dataset.pass : '';
      }
    }).catch(() => {});
    el('theme').addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
      setTheme(dark ? 'dark' : 'light');
      route();                      // charts are SVG strings, so redraw them
    });
    el('logout').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { }
      user = null; csrf = null; location.hash = '/'; showGate();
    });
    el('rescore').addEventListener('click', async ev => {
      ev.target.disabled = true; ev.target.textContent = 'Scoring…';
      try {
        const r = await api('/api/score/run', { method: 'POST' });
        toast(`Scored ${r.n} employees as of ${r.as_of}`);
        kpis = {}; await route();
      } catch (e) { toast(e.message); }
      ev.target.disabled = false; ev.target.textContent = 'Run scoring';
    });
    window.addEventListener('hashchange', route);

    document.addEventListener('click', ev => {
      const row = ev.target.closest('[data-emp]');
      if (row) { location.hash = '/employee/' + encodeURIComponent(row.dataset.emp); return; }

      const bandBtn = ev.target.closest('.ladder button');
      if (bandBtn) { state.band = bandBtn.dataset.band; location.hash = '/watchlist'; return; }

      const sortBtn = ev.target.closest('#wl-sort button');
      if (sortBtn) { state.sort = sortBtn.dataset.sort; showWatchlist(); return; }

      const segBtn = ev.target.closest('#seg-switch button');
      if (segBtn) { showSegments(segBtn.dataset.by); return; }

      const suggest = ev.target.closest('.suggests button');
      if (suggest) { ask(suggest.dataset.q); return; }

      if (ev.target.id === 'log-action') { actionModal(view()._employee); return; }

      const closeBtn = ev.target.closest('.close-int');
      if (closeBtn) { closeIntervention(closeBtn.dataset.id); return; }
    });

    document.addEventListener('change', ev => {
      if (['wl-band', 'wl-site', 'wl-dept'].includes(ev.target.id)) {
        state.band = el('wl-band').value; state.site = el('wl-site').value;
        state.department = el('wl-dept').value;
        showWatchlist();
      }
    });

    let searchTimer;
    document.addEventListener('input', ev => {
      if (ev.target.id !== 'wl-search') return;
      clearTimeout(searchTimer);
      const v = ev.target.value;
      searchTimer = setTimeout(() => {
        state.search = v;
        showWatchlist().then(() => {
          const box = el('wl-search');
          if (box) { box.focus(); box.setSelectionRange(v.length, v.length); }
        });
      }, 300);
    });

    document.addEventListener('submit', ev => {
      if (ev.target.id !== 'ask-form') return;
      ev.preventDefault();
      const input = el('ask-input');
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      ask(q);
    });
  }

  async function closeIntervention(id) {
    const outcome = prompt('Outcome: Retained, Exited, In Progress or No Change', 'Retained');
    if (!outcome) return;
    try {
      await api('/api/interventions/' + id, { method: 'PATCH', body: JSON.stringify({ outcome }) });
      toast('Action updated');
      route();
    } catch (e) { toast(e.message); }
  }

  wire();
  boot();
  return { api, toast };
})();
