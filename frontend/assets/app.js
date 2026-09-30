/* Shell: session, routing, fetching, events, and the interactive layer
   (command search, guided tour, tooltips, modals, count-up numbers). */

const App = (() => {
  let user = null, csrf = null, filters = {}, kpis = {};
  const state = { sort: 'priority_score', band: '', site: '', department: '', search: '', segBy: 'Site' };
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
    { path: '/', icon: 'overview', label: 'Overview', title: 'Overview', sub: 'Retention position across the workforce',
      help: 'Today in one line, the key numbers and the four risk groups.' },
    { path: '/watchlist', icon: 'watchlist', label: 'Watchlist', title: 'Watchlist', sub: 'Who needs a conversation first',
      help: 'Everyone ranked by priority. Filter, search, sort and export.' },
    { path: '/early', icon: 'newjoiner', label: 'New joiners', title: 'New joiners', sub: 'The first 30 days, and the hiring channels behind them',
      help: 'Where new hires are lost, and which hiring channels keep people.' },
    { path: '/segments', icon: 'segments', label: 'Segments', title: 'Segments', sub: 'Risk by site, department, channel and tenure',
      help: 'Compare sites, departments, roles and tenure groups side by side.' },
    { path: '/anomalies', icon: 'anomaly', label: 'Anomalies', title: 'Anomalies and movement', sub: 'Sudden change and fast-rising risk',
      help: 'People whose behaviour suddenly changed or whose risk jumped.' },
    { path: '/interventions', icon: 'actions', label: 'Actions', title: 'Retention actions', sub: 'What was tried, and what followed',
      help: 'Every logged conversation, its outcome, and which actions work.' },
    { path: '/governance', icon: 'shield', label: 'Model health', title: 'Model health', sub: 'Accuracy, honesty of the percentages, drift and fairness',
      help: 'Can the scores be trusted? Accuracy, calibration, drift and fairness.' },
    { path: '/copilot', icon: 'chat', label: 'Ask', title: 'Ask', sub: 'Questions answered from the scored data',
      help: 'Ask questions in plain English and get answers from live data.' },
    { path: '/help', icon: 'book', label: 'Guide', title: 'Guide', sub: 'How to use this tool in ten minutes a week',
      help: 'This page: the routine, what every page is for, and the words used.' },
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
    if (res.status === 401 && !path.startsWith('/api/auth/')) { showGate(); throw new Error('Session expired, please sign in again'); }
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
    t.innerHTML = `<span class="t-ic">${I(kind === 'err' ? 'alert' : 'check', 15)}</span><span>${esc(message)}</span>`;
    t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.hidden = true; }, 3400);
  }

  /* ---------------------------------------------------------------- gate */
  function showGate() {
    el('gate').hidden = false; el('app').hidden = true;
    endTour();
  }

  function setTheme(mode) {
    const root = document.documentElement;
    if (mode === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    store.set('ri-theme', mode);
    const btn = el('theme');
    if (btn) {
      btn.innerHTML = I(mode === 'dark' ? 'sun' : 'moon');
      btn.setAttribute('aria-pressed', mode === 'dark' ? 'true' : 'false');
      btn.title = mode === 'dark' ? 'Switch to light' : 'Switch to dark';
    }
    Chart.syncPalette();
  }

  async function boot() {
    Icons.hydrate();
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
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
    err.hidden = true; btn.disabled = true; btn.classList.add('busy');
    try {
      user = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      csrf = user.csrf;
      await enter();
      toast(`Signed in as ${user.full_name}`);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    }
    btn.disabled = false; btn.classList.remove('busy');
  }

  async function enter() {
    el('gate').hidden = true; el('app').hidden = false;
    const initials = (user.full_name || user.username).split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    el('avatar').textContent = initials;
    el('rail-user').innerHTML = `<b>${esc(user.full_name)}</b><span class="role-tag">${esc(user.role.replace('_', ' '))}</span>`;
    el('rescore').hidden = user.role !== 'admin';
    renderNav();
    const [f, o] = await Promise.allSettled([api('/api/filters'), api('/api/overview')]);
    filters = f.status === 'fulfilled' ? f.value : {};
    if (o.status === 'fulfilled') { kpis = o.value.kpis || {}; overviewCache = o.value; }
    updateCounts(); refreshMeta();
    await route();
    if (!store.get('ri-tour-done') && (location.hash === '' || location.hash === '#/')) setTimeout(startTour, 900);
  }

  function renderNav() {
    el('nav').innerHTML = GROUPS.map(g => `<div class="nav-group"><span>${g.name}</span>${g.items.map(p => {
      const r = ROUTES.find(x => x.path === p);
      return `<a href="#${r.path}" data-path="${r.path}" title="${esc(r.label)}">${I(r.icon)}<span>${esc(r.label)}</span>
        <span class="count" data-count="${r.path}"></span></a>`;
    }).join('')}</div>`).join('');
  }

  function setChrome(r) {
    document.querySelectorAll('#nav a').forEach(a => {
      const on = a.dataset.path === r.path;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    el('crumb').innerHTML = `<h1>${I(r.icon || 'overview')}${esc(r.title)}</h1><p>${esc(r.sub)}</p>`;
    document.title = `${r.title} · Retention Intelligence`;
    el('app').classList.remove('menu-open');
  }

  function loading() {
    view().classList.remove('enter');
    view().innerHTML = `<div class="skeleton" aria-busy="true" aria-label="Loading">
      <div class="sk" style="height:110px"></div>
      <div class="sk-row">${'<div class="sk" style="height:96px"></div>'.repeat(5)}</div>
      <div class="sk" style="height:280px"></div></div>`;
  }

  /* Rise-in, staggered, then count the headline numbers up from zero. */
  function animate(on = true) {
    const v = view();
    v.classList.toggle('enter', on);
    if (!on) return;
    v.querySelectorAll('.anim').forEach((n, i) => n.style.setProperty('--i', Math.min(i, 12)));
    if (reduced) return;
    v.querySelectorAll('[data-count]').forEach(n => {
      if (n.children.length) return;
      const m = n.textContent.trim().match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/);
      if (!m) return;
      const target = parseFloat(m[2].replace(/,/g, ''));
      const dec = (m[2].split('.')[1] || '').length;
      const grouped = m[2].includes(',');
      const fmt = x => grouped ? x.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) : x.toFixed(dec);
      const t0 = performance.now(), dur = 900;
      const step = now => {
        const p = Math.min((now - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
        n.textContent = m[1] + fmt(target * e) + m[3];
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /* -------------------------------------------------------------- routing */
  let overviewCache = null;
  async function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const empMatch = hash.match(/^\/employee\/(.+)$/);
    const def = ROUTES.find(r => r.path === hash) || ROUTES[0];
    hideTip();

    if (empMatch) {
      setChrome({ path: '/watchlist', icon: 'user', title: 'Employee record', sub: 'Risk, reasons, history and actions' });
      return showEmployee(decodeURIComponent(empMatch[1]));
    }
    setChrome(def);
    loading();
    try {
      switch (def.path) {
        case '/': {
          const d = await api('/api/overview');
          overviewCache = d; kpis = d.kpis || {};
          view().innerHTML = Views.overview(d, user);
          updateCounts(); refreshMeta();
          break;
        }
        case '/watchlist': await showWatchlist(true); break;
        case '/early': view().innerHTML = Views.early(await api('/api/early-attrition')); break;
        case '/segments': await showSegments(state.segBy, true); break;
        case '/anomalies': view().innerHTML = Views.anomalies(await api('/api/anomalies')); break;
        case '/interventions': view().innerHTML = Views.interventions(await api('/api/interventions'), canAct()); break;
        case '/governance': view().innerHTML = Views.governance(await api('/api/governance')); break;
        case '/copilot': view().innerHTML = Views.copilot(); break;
        case '/help': view().innerHTML = Views.help(ROUTES, GROUPS); break;
      }
      animate(true);
    } catch (e) {
      view().innerHTML = `<div class="panel"><div class="empty-state"><span class="h-ic">${I('alert', 22)}</span>
        <b>Could not load this page</b><p>${esc(e.message)}</p>
        <button class="btn btn-sm" onclick="App.route()">${I('refresh', 15)} Try again</button></div></div>`;
    }
    view().focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  function updateCounts() {
    const map = { '/watchlist': kpis.critical, '/anomalies': kpis.anomalies, '/early': kpis.in_first_30_days };
    document.querySelectorAll('[data-count]').forEach(s => {
      if (!s.classList.contains('count')) return;
      const v = map[s.dataset.count];
      s.textContent = v ? v : '';
      s.classList.toggle('hot', s.dataset.count === '/watchlist' && !!v);
      s.title = s.dataset.count === '/watchlist' ? 'people in the Critical band' : '';
    });
  }

  function refreshMeta() {
    if (!kpis.as_of) { el('meta-asof').innerHTML = ''; return; }
    el('meta-asof').innerHTML = `<span class="live-dot"></span>Scored <b>${esc(kpis.as_of)}</b>`;
    el('meta-asof').title = `Latest scoring run ${kpis.as_of} · model ${kpis.model_version || '—'}`;
  }

  async function showWatchlist(fresh = false) {
    if (fresh) loading();
    const q = new URLSearchParams({ limit: 300, sort: state.sort });
    ['band', 'site', 'department', 'search'].forEach(k => { if (state[k]) q.set(k, state[k]); });
    const rows = await api('/api/watchlist?' + q);
    view().innerHTML = Views.watchlist(rows, filters, state, kpis);
    animate(fresh);
  }

  async function showSegments(by, fresh = false) {
    if (fresh) loading();
    state.segBy = by;
    view().innerHTML = Views.segments(await api('/api/segments?by=' + encodeURIComponent(by)), by);
    animate(fresh);
  }

  async function showEmployee(id) {
    loading();
    try {
      const d = await api('/api/employees/' + encodeURIComponent(id));
      view().innerHTML = Views.employee(d, canAct());
      view()._employee = id;
      animate(true);
    } catch (e) {
      view().innerHTML = `<div class="panel"><div class="empty-state"><span class="h-ic">${I('search', 22)}</span>
        <b>${esc(e.message)}</b><a class="btn btn-sm" href="#/watchlist">Back to watchlist</a></div></div>`;
    }
    window.scrollTo({ top: 0 });
  }

  const canAct = () => user && (user.role === 'admin' || user.role === 'hr_manager');

  /* ----------------------------------------------------------- copilot */
  async function ask(question) {
    const chat = el('chat');
    if (!chat) return;
    chat.insertAdjacentHTML('beforeend', `<div class="msg you"><span class="who">${I('user', 16)}</span>
      <div class="body"><pre>${esc(question)}</pre></div></div>`);
    chat.insertAdjacentHTML('beforeend', `<div class="msg bot" id="pending"><span class="who">${I('spark', 16)}</span>
      <div class="body"><span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span></div></div>`);
    chat.scrollTop = chat.scrollHeight;
    try {
      const d = await api('/api/copilot/ask', { method: 'POST', body: JSON.stringify({ question }) });
      el('pending').outerHTML = `<div class="msg bot"><span class="who">${I('spark', 16)}</span><div class="body">
        <pre>${esc(d.answer)}</pre><div class="src">${I('info', 12)}${esc(d.source)} · ${esc(d.intent)}</div></div></div>`;
    } catch (e) {
      el('pending').outerHTML = `<div class="msg bot"><span class="who">${I('alert', 16)}</span><div class="body"><pre>${esc(e.message)}</pre></div></div>`;
    }
    chat.scrollTop = chat.scrollHeight;
  }

  /* ------------------------------------------------------------- modals */
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
    setTimeout(() => { const f = back.querySelector('select, input, textarea, button.choice'); f && f.focus(); }, 50);
    return back;
  }

  function actionModal(employeeId) {
    const actions = ['Manager conversation', 'Workload and roster review', 'Career discussion',
      'Onboarding catch-up', 'Pay or benchmark review', 'Site or shift change',
      'Training assignment', 'Skip-level meeting'];
    const due = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    modal(`
      <h2><span class="h-ic">${I('plus', 16)}</span>Log a retention action</h2>
      <p class="sub">For ${esc(employeeId)}. You can record the outcome later under Actions.</p>
      <label for="m-action">What are you doing?</label>
      <select id="m-action">${actions.map(a => `<option>${a}</option>`).join('')}</select>
      <label for="m-owner">Who owns it?</label>
      <input id="m-owner" placeholder="Name" value="${esc(user.full_name)}">
      <label for="m-due">Follow up by</label>
      <input id="m-due" type="date" value="${due}">
      <label for="m-notes">Notes (optional)</label>
      <textarea id="m-notes" rows="3" placeholder="What is being addressed"></textarea>
      <div class="row" style="margin-top:18px;justify-content:flex-end">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" data-save>${I('check', 15)} Save action</button>
      </div>`, async (ev, close) => {
      if (!ev.target.closest('[data-save]')) return;
      try {
        await api('/api/interventions', {
          method: 'POST', body: JSON.stringify({
            EmployeeID: employeeId, action: el('m-action').value, owner: el('m-owner').value,
            due_date: el('m-due').value || null, notes: el('m-notes').value
          })
        });
        close(); toast('Action logged'); showEmployee(employeeId);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function outcomeModal(id, emp) {
    const opts = [['Retained', 'check', 'They stayed'], ['In Progress', 'clock', 'Still working on it'],
                  ['No Change', 'anomaly', 'Nothing changed yet'], ['Exited', 'logout', 'They left']];
    let pick = 'Retained';
    modal(`
      <h2><span class="h-ic">${I('actions', 16)}</span>Record the outcome</h2>
      <p class="sub">Action #${esc(id)} for ${esc(emp || '')}. What happened after the action?</p>
      <div class="choices">${opts.map(([v, ic, t], i) => `<button class="choice ${i === 0 ? 'on' : ''}" data-v="${v}">
        ${I(ic)}<span><b>${v}</b><br><span class="sub">${t}</span></span></button>`).join('')}</div>
      <label for="o-notes">Notes (optional)</label>
      <textarea id="o-notes" rows="2" placeholder="Anything worth remembering"></textarea>
      <div class="row" style="margin-top:18px;justify-content:flex-end">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" data-save>${I('check', 15)} Save outcome</button>
      </div>`, async (ev, close, back) => {
      const c = ev.target.closest('.choice');
      if (c) {
        pick = c.dataset.v;
        back.querySelectorAll('.choice').forEach(b => b.classList.toggle('on', b === c));
        return;
      }
      if (!ev.target.closest('[data-save]')) return;
      try {
        await api('/api/interventions/' + id, { method: 'PATCH',
          body: JSON.stringify({ outcome: pick, notes: el('o-notes').value || null }) });
        close(); toast(`Marked as ${pick}`); route();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  /* ------------------------------------------------------ command search */
  let palTimer, palItems = [], palSel = 0;
  function openPalette(seed = '') {
    if (document.querySelector('.palette')) return;
    const back = modal(`<div class="palette-inner"></div>`);
    back.classList.add('palette-back');
    const box = back.querySelector('.modal');
    box.className = 'palette';
    box.innerHTML = `<div class="p-in">${I('search')}<input id="p-q" placeholder="Type an employee ID, role, site or page…" autocomplete="off" aria-label="Search"></div>
      <div class="p-list" id="p-list" role="listbox"></div>
      <div class="p-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>`;
    const input = box.querySelector('#p-q');
    input.value = seed;
    input.focus();
    const render = emps => {
      const q = input.value.trim().toLowerCase();
      const pages = ROUTES.filter(r => !q || (r.label + ' ' + r.title + ' ' + r.help).toLowerCase().includes(q)).slice(0, q ? 5 : 9);
      palItems = [...pages.map(r => ({ href: '#' + r.path })), ...(emps || []).map(e => ({ href: '#/employee/' + encodeURIComponent(e.EmployeeID) }))];
      palSel = Math.min(palSel, Math.max(palItems.length - 1, 0));
      let i = 0;
      box.querySelector('#p-list').innerHTML =
        (pages.length ? `<div class="p-sec">Pages</div>` + pages.map(r => `<div class="p-item" data-i="${i++}" role="option">
          <span class="h-ic">${I(r.icon, 16)}</span><div><b>${esc(r.label)}</b><small>${esc(r.help)}</small></div></div>`).join('') : '') +
        ((emps || []).length ? `<div class="p-sec">People</div>` + emps.map(e => `<div class="p-item" data-i="${i++}" role="option">
          <span class="h-ic">${I('user', 16)}</span><div><b>${esc(e.EmployeeID)} · ${esc(e.Position)}</b>
          <small>${esc(e.Department)} · ${esc(e.Site)}</small></div>${e.risk_band ? `<span class="band b-${esc(e.risk_band)}"><i class="dot"></i>${esc(e.risk_band)}</span>` : ''}</div>`).join('') : '') +
        (!palItems.length ? `<div class="empty-state"><b>No matches</b><p>Try an ID like EMP11691, a role or a site name.</p></div>` : '');
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
      }, 180);
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

  /* ---------------------------------------------------------- guided tour */
  const TOUR = [
    { sel: '.view .hero', title: 'Your day in one line', text: 'This summary says how many people need attention. The amber button takes you straight to them.' },
    { sel: '.view .kpis', title: 'Key numbers', text: 'Each tile opens the page behind it. Hover or tap the (i) icons for a plain explanation.' },
    { sel: '#ladder-panel', title: 'Four risk groups', text: 'Click any colour to open just those people in the watchlist.' },
    { sel: '#nav', title: 'Pages grouped by job', text: 'Monitor who is at risk, Analyse groups, Act and record outcomes, and check the model can be Trusted.' },
    { sel: '#search-open', title: 'Find anyone fast', text: 'Type an employee ID, a role, a site or a page name. Shortcut: Ctrl K.' },
    { sel: '#help', title: 'Replay any time', text: 'The compass restarts this tour. The Guide page in the menu explains every term.' },
  ];
  let tourIdx = -1, tourEls = null, tourSteps = [];

  function visible(node) {
    if (!node) return false;
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth;
  }

  async function startTour() {
    if (el('app').hidden) return;
    if (location.hash !== '' && location.hash !== '#/') {
      location.hash = '/';
      await new Promise(r => setTimeout(r, 700));
    }
    endTour();
    tourSteps = TOUR.filter(s => visible(document.querySelector(s.sel)));
    if (!tourSteps.length) return;
    const hole = document.createElement('div'); hole.className = 'tour-hole';
    const pop = document.createElement('div'); pop.className = 'tour-pop'; pop.setAttribute('role', 'dialog');
    const catcher = document.createElement('div');
    catcher.style.cssText = 'position:fixed;inset:0;z-index:79';
    document.body.append(catcher, hole, pop);
    tourEls = { hole, pop, catcher };
    catcher.addEventListener('click', () => tourStep(tourIdx + 1));
    pop.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.t === 'next') tourStep(tourIdx + 1);
      if (b.dataset.t === 'prev') tourStep(tourIdx - 1);
      if (b.dataset.t === 'skip') endTour(true);
    });
    tourStep(0);
  }

  function tourStep(i) {
    if (!tourEls) return;
    if (i >= tourSteps.length) return endTour(true);
    tourIdx = Math.max(0, i);
    const s = tourSteps[tourIdx], target = document.querySelector(s.sel);
    if (!target) return endTour(true);
    target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    const last = tourIdx === tourSteps.length - 1;
    tourEls.pop.innerHTML = `<div class="t-step">Step ${tourIdx + 1} of ${tourSteps.length}</div>
      <h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>
      <div class="row"><div class="tour-dots">${tourSteps.map((_, k) => `<i class="${k === tourIdx ? 'on' : ''}"></i>`).join('')}</div>
      <div class="spacer"></div>
      ${last ? '' : '<button class="btn btn-sm btn-ghost" data-t="skip">Skip</button>'}
      ${tourIdx ? `<button class="btn btn-sm" data-t="prev" aria-label="Back">${I('arrowLeft', 14)}</button>` : ''}
      <button class="btn btn-sm btn-primary" data-t="next">${last ? 'Done' : 'Next'} ${last ? I('check', 14) : I('arrowRight', 14)}</button></div>`;
    setTimeout(placeTour, reduced ? 0 : 320);
    placeTour();
  }

  function placeTour() {
    if (!tourEls || tourIdx < 0) return;
    const target = document.querySelector(tourSteps[tourIdx].sel);
    if (!target) return;
    const r = target.getBoundingClientRect(), pad = 6;
    const top = Math.max(r.top - pad, 4), bottom = Math.min(r.bottom + pad, innerHeight - 4);
    Object.assign(tourEls.hole.style, { left: `${r.left - pad}px`, top: `${top}px`,
      width: `${r.width + pad * 2}px`, height: `${bottom - top}px` });
    const pop = tourEls.pop, pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 14;
    let x, y;
    if (bottom + gap + ph < innerHeight) { y = bottom + gap; x = r.left; }
    else if (top - gap - ph > 0) { y = top - gap - ph; x = r.left; }
    else if (r.right + gap + pw < innerWidth) { x = r.right + gap; y = Math.max(r.top + 20, 16); }
    else { y = innerHeight - ph - 16; x = r.left + 16; }
    x = Math.min(Math.max(x, 16), innerWidth - pw - 16);
    y = Math.min(Math.max(y, 16), innerHeight - ph - 16);
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
  }

  function endTour(done) {
    if (tourEls) { Object.values(tourEls).forEach(n => n.remove()); tourEls = null; }
    tourIdx = -1;
    if (done) store.set('ri-tour-done', '1');
  }

  /* ------------------------------------------------------------- tooltips */
  function showTip(target) {
    const box = el('tipbox');
    box.textContent = target.dataset.tip;
    box.hidden = false;
    const r = target.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
    let x = r.left + r.width / 2 - bw / 2, y = r.top - bh - 8;
    if (y < 8) y = r.bottom + 8;
    x = Math.min(Math.max(x, 8), innerWidth - bw - 8);
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box._for = target;
  }
  function hideTip() { const b = el('tipbox'); if (b) { b.hidden = true; b._for = null; } }

  /* ------------------------------------------------------------- events */
  function wire() {
    el('login-form').addEventListener('submit', ev => {
      ev.preventDefault();
      signIn(el('username').value, el('password').value);
    });
    el('pw-toggle').addEventListener('click', () => {
      const p = el('password'), show = p.type === 'password';
      p.type = show ? 'text' : 'password';
      el('pw-toggle').innerHTML = I(show ? 'eyeOff' : 'eye', 16);
      el('pw-toggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
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
      toast('Signed out');
    });
    el('rescore').addEventListener('click', async () => {
      const b = el('rescore');
      b.disabled = true; b.classList.add('busy'); b.querySelector('span').textContent = 'Scoring…';
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
    window.addEventListener('resize', () => { placeTour(); hideTip(); });
    window.addEventListener('scroll', () => { hideTip(); }, { passive: true });

    document.addEventListener('mouseover', ev => { const t = ev.target.closest('[data-tip]'); if (t) showTip(t); });
    document.addEventListener('mouseout', ev => { const t = ev.target.closest('[data-tip]'); if (t && !t.contains(ev.relatedTarget)) hideTip(); });
    document.addEventListener('focusin', ev => { const t = ev.target.closest('[data-tip]'); if (t) showTip(t); });
    document.addEventListener('focusout', ev => { if (ev.target.closest('[data-tip]')) hideTip(); });

    document.addEventListener('click', ev => {
      const tipBtn = ev.target.closest('.tip');
      if (tipBtn) {                      // tap to toggle on touch; never trigger the card underneath
        ev.preventDefault(); ev.stopPropagation();
        const b = el('tipbox'); b._for === tipBtn && !b.hidden ? hideTip() : showTip(tipBtn);
        return;
      }
      hideTip();

      const row = ev.target.closest('[data-emp]');
      if (row) { location.hash = '/employee/' + encodeURIComponent(row.dataset.emp); return; }

      const card = ev.target.closest('[data-href]');
      if (card) { location.hash = card.dataset.href.replace(/^#/, ''); return; }

      const bandLink = ev.target.closest('[data-band-link]');
      if (bandLink) { state.band = bandLink.dataset.bandLink; state.site = state.department = state.search = ''; return; }

      const bandBtn = ev.target.closest('.ladder button');
      if (bandBtn) { state.band = bandBtn.dataset.band; state.site = state.department = state.search = ''; location.hash = '/watchlist'; return; }

      const chip = ev.target.closest('[data-band-chip]');
      if (chip) { state.band = chip.dataset.bandChip; showWatchlist(); return; }

      if (ev.target.closest('#wl-clear')) {
        Object.assign(state, { band: '', site: '', department: '', search: '' }); showWatchlist(); return;
      }

      const sortBtn = ev.target.closest('#wl-sort button');
      if (sortBtn) { state.sort = sortBtn.dataset.sort; showWatchlist(); return; }

      const segBtn = ev.target.closest('#seg-switch button');
      if (segBtn) { showSegments(segBtn.dataset.by); return; }

      const suggest = ev.target.closest('.suggests button');
      if (suggest) { ask(suggest.dataset.q); return; }

      if (ev.target.closest('#log-action')) { actionModal(view()._employee); return; }
      if (ev.target.closest('#go-back')) {
        if (history.length > 1) history.back(); else location.hash = '/watchlist';
        return;
      }
      if (ev.target.closest('#start-tour')) { startTour(); return; }

      const closeBtn = ev.target.closest('.close-int');
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
        if (tourEls) { endTour(true); return; }
        el('app').classList.remove('menu-open'); hideTip();
        return;
      }
      if (tourEls && (ev.key === 'ArrowRight' || ev.key === 'Enter')) { ev.preventDefault(); tourStep(tourIdx + 1); return; }
      if (tourEls && ev.key === 'ArrowLeft') { tourStep(tourIdx - 1); return; }
      if (typing || el('app').hidden || document.querySelector('.modal-back')) return;
      if (ev.key === '/') { ev.preventDefault(); openPalette(); }
      if (ev.key === '?') { location.hash = '/help'; }
      const card = ev.target.closest && ev.target.closest('[data-href]');
      if (card && ev.key === 'Enter') location.hash = card.dataset.href.replace(/^#/, '');
    });

    document.addEventListener('change', ev => {
      if (['wl-site', 'wl-dept'].includes(ev.target.id)) {
        state.site = el('wl-site').value; state.department = el('wl-dept').value;
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

  wire();
  boot();
  return { api, toast, route, startTour };
})();
