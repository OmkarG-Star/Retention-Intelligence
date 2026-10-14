/* Page renderers. Each returns an HTML string; App owns routing, fetching and
   events. Every number that needs explaining carries an (i) tip, and every
   chart mark answers hover. */

const Views = (() => {
  const esc = Chart.esc, pct = Chart.pct, num = Chart.nice;
  const I = (n, s = 16) => Icons.get(n, s);
  const band = b => b ? `<span class="band b-${esc(b)}">${esc(b)}</span>` : '';
  const tip = t => `<button type="button" class="tip" data-tip="${esc(t)}" aria-label="${esc(t)}">${I('info', 14)}</button>`;
  const note = (html, cls = '') => `<div class="note ${cls}">${I(cls === 'warn' ? 'alert' : 'info', 16)}<div>${html}</div></div>`;
  const id = v => `<span class="id">${esc(v)}</span>`;
  const MODEL_NAMES = { lgbm: 'Gradient boosting', logistic: 'Logistic regression', blend: 'Blend of both' };

  function delta(v) {
    if (v == null || isNaN(v)) return '<span class="delta flat">first run</span>';
    if (Math.abs(v) < 0.05) return '<span class="delta flat">steady</span>';
    return `<span class="delta ${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}</span>`;
  }

  function riskCell(p) {
    const w = Math.min(Math.max((p || 0) * 160, 3), 100);
    return `<div class="risk-cell"><span class="tnum">${pct(p)}</span><span class="track"><span class="fill" style="width:${w}%"></span></span></div>`;
  }

  function head(title, desc = '', right = '', help = '') {
    return `<div class="panel-head"><div><h2>${title}${help ? tip(help) : ''}</h2>${desc ? `<p>${desc}</p>` : ''}</div>${right}</div>`;
  }

  function stat({ k, v, s = '', help = '', href = '' }) {
    const tag = href ? `a href="${href}"` : 'div';
    return `<${tag} class="stat"><span class="k">${k}${help ? tip(help) : ''}</span>
      <span class="v">${v}</span><span class="s">${s}</span></${href ? 'a' : 'div'}>`;
  }

  function emptyState(icon, title, text = '') {
    return `<div class="empty-state"><span class="e-ic">${I(icon, 20)}</span><b>${title}</b>${text ? `<p>${text}</p>` : ''}</div>`;
  }

  function longDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function notScored() {
    return `<div class="panel">${emptyState('refresh', 'Nothing has been scored yet',
      'Build the data and train the model, then reload this page: <code>python -m attrition.cli pipeline</code>')}</div>`;
  }

  /* ============================================================ overview */
  function overview(d, user, wf) {
    const k = d.kpis || {}, t = d.trust || {};
    if (k.status === 'not_scored') return notScored();
    const first = user && user.full_name ? user.full_name.split(' ')[0] : '';
    const trend = d.trend || [];
    const issues = t.site_issues || [];
    const under = issues.filter(i => i.issues.includes('under-predicted'));

    return `
    <div class="stack">
      <section class="briefing" id="briefing">
        <p class="date">${first ? `Hello ${esc(first)}. ` : ''}Scored on ${esc(longDate(k.as_of))}</p>
        <h2><a href="#/watchlist" data-band-link="Critical">${num(k.critical)} people</a> need a conversation this week, and
          <a href="#/anomalies">${num(k.accelerating)} more</a> are rising fast. If nothing changes, expect about
          <a href="#/watchlist">${num(k.expected_exits_90d)} resignations</a> in the next 90 days.</h2>
        <div class="row">
          <a class="btn btn-primary" href="#/watchlist" data-band-link="Critical">${I('watchlist')} Open the call list</a>
          <a class="btn" href="#/governance">${I('shield')} How sure is this?</a>
        </div>
      </section>

      <div class="stats" style="--n:4" id="stats">
        ${stat({ k: 'Expected resignations, 90 days', v: num(k.expected_exits_90d), s: `out of ${num(k.headcount)} on rolls`, href: '#/watchlist',
          help: 'The sum of every person\'s 90-day probability. If nothing changes, this is how many resignations to expect.' })}
        ${stat({ k: 'Rising fast', v: num(k.accelerating), s: 'up more than 5 points since last run', href: '#/anomalies',
          help: 'People whose 30-day risk rose by more than 5 percentage points since the previous scoring run.' })}
        ${stat({ k: 'Already serving notice', v: num(k.serving_notice), s: 'resigned, not yet left',
          help: 'These people have resigned but not reached their last day. HR already knows, so they are not scored.' })}
        ${stat({ k: 'Attrition, last 12 months', v: pct(k.annualised_attrition, 1), s: `${num(k.exits_last_90d)} exits in the last quarter`, href: '#/segments',
          help: 'Exits in the last 12 months divided by headcount plus those exits.' })}
      </div>

      <section class="panel" id="workforce-panel">
        ${head('Everyone, one square each', `${num(k.headcount)} active employees, sorted by their chance of resigning in the next 90 days. Hover a square to see who it is; click to open them.`,
          '', 'Bands rank people against each other: Critical is the top 5% of 90-day risk, High the next 10%, Medium the next 25%. Together, Critical and High are the call list.')}
        <div class="strip-wrap"><div class="wf reveal" id="wf">${wfCells(wf)}</div></div>
        <div class="wf-legend" id="wf-legend">
          ${[['Critical', k.critical, 'talk this week'], ['High', k.high, 'talk this month'], ['Medium', k.medium, 'keep an eye on'], ['Low', k.low, 'no action']]
            .map(([b, n, w]) => `<button data-wf-band="${b}" title="Highlight ${esc(b)}: ${esc(w)}"><span class="sw ${b}"></span>${b} <b>${num(n)}</b></button>`).join('')}
          <span class="hint">Click a band to highlight it, click again to clear.</span>
        </div>
      </section>

      <div class="grid g-main">
        <section class="panel flush" id="call-first">
          ${head('Call first', 'Ranked by risk times how hard the role is to backfill, so a hard-to-replace planner can outrank a slightly riskier helper.',
            `<a class="btn btn-sm" href="#/watchlist">Full watchlist ${I('arrowRight', 14)}</a>`)}
          <div class="table-wrap"><table><thead><tr>
            <th>Employee</th><th>Role</th><th class="opt">Site</th><th class="num">90-day risk</th><th class="num opt">Change</th><th>Band</th>
          </tr></thead><tbody>
          ${(d.top_priority || []).map(r => `
            <tr class="clickable" tabindex="0" data-peek="${esc(r.EmployeeID)}">
              <td style="white-space:nowrap">${id(r.EmployeeID)}<span class="sub">${num(r.TenureDays)} days</span></td>
              <td class="cell-2">${esc(r.Position)}<span class="sub">${esc(r.Department)}</span></td>
              <td class="opt">${esc(r.Site)}</td>
              <td class="num">${riskCell(r.risk_90)}</td>
              <td class="num opt">${delta(r.risk_velocity)}</td>
              <td>${band(r.risk_band)}</td>
            </tr>`).join('') || `<tr><td colspan="6">${emptyState('users', 'Nothing scored yet')}</td></tr>`}
          </tbody></table></div>
        </section>

        <div class="stack">
          <section class="panel" id="trust-panel">
            ${head('How much to trust this list', `Checked on ${t.test_window ? esc(longDate(t.test_window[0])) + ' to ' + esc(longDate(t.test_window[1])) : 'a later period'}, which the model never saw.`)}
            ${t.lead_time_4w != null ? `<div class="trust">
              <p class="trust-big">Four weeks before they resigned, <b>${pct(t.lead_time_4w, 0)}</b> of leavers were already on the call list. A random list of the same size catches ${pct(t.random, 0)}.</p>
              <div><div class="meter"><span class="m-fill" style="width:${t.lead_time_4w * 100}%"></span><span class="m-ref" style="left:${t.random * 100}%"></span></div>
                <div class="meter-key"><span>random ${pct(t.random, 0)}</span><span>this model ${pct(t.lead_time_4w, 0)}</span></div></div>
              <div class="facts">
                <div><b>${pct(t.recall_at_15, 0)}</b><span>of 90-day resignations fall in the top 15%</span></div>
                <div><b>${pct(t.precision_at_15, 0)}</b><span>of the top 15% resign within 90 days (base rate ${pct(t.base_rate, 0)})</span></div>
              </div>
              ${under.length ? `<p class="callout"><b>Reads low at ${under.map(i => esc(i.site)).join(' and ')}.</b> Expect more resignations there than the scores suggest.</p>` : ''}
              <a class="btn btn-sm btn-ghost" href="#/governance" style="justify-self:start;margin-left:-10px">See the full model check ${I('arrowRight', 14)}</a>
            </div>` : emptyState('shield', 'No validation recorded', 'Retrain to produce the model check.')}
          </section>

          <section class="panel flush">
            ${head('Moving fastest', 'Largest change in 30-day risk since the previous run', `<a class="btn btn-sm btn-ghost" href="#/anomalies">All</a>`)}
            <div class="table-wrap"><table><tbody>
            ${(d.movers || []).slice(0, 6).map(m => `
              <tr class="clickable" tabindex="0" data-peek="${esc(m.EmployeeID)}">
                <td>${id(m.EmployeeID)}<span class="sub">${esc(m.Position)}</span></td>
                <td class="num"><span class="sub" style="display:inline">${pct(m.prev_risk_30)} to</span> ${pct(m.risk_30)}</td>
                <td class="num">${delta(m.risk_velocity)}</td>
              </tr>`).join('') || `<tr><td>${emptyState('clock', 'Needs two scoring runs')}</td></tr>`}
            </tbody></table></div>
          </section>
        </div>
      </div>

      <section class="panel">
        ${head('Risk by site', 'Average 90-day risk today, with exits over the last 12 months',
          `<a class="btn btn-sm" href="#/segments">${I('segments')} Compare groups</a>`)}
        ${Chart.slot(w => Chart.hbars((d.segments || []).map(s => {
          const issue = issues.find(i => i.site === s.segment);
          const low = issue && issue.issues.includes('under-predicted');
          return { label: s.segment, value: s.mean_risk_90, display: `${pct(s.mean_risk_90)}  ·  ${num(s.exits_12m)} exits`,
            color: Chart.colors.s1, flag: low ? 'model reads low' : '',
            tip: `<b>${esc(s.segment)}</b><div class="t-row"><span>Average 90-day risk</span><b>${pct(s.mean_risk_90)}</b></div><div class="t-row"><span>Headcount</span><b>${num(s.headcount)}</b></div><div class="t-row"><span>Exits, 12 months</span><b>${num(s.exits_12m)}</b></div>${low ? `<div class="t-row"><span>Model check</span><b>predicted ${Math.round(issue.calibration_ratio * 100)}% of actual</b></div>` : ''}` };
        }), { width: w, labelW: 230, valW: 230 }))}
      </section>

      <section class="panel">
        ${head('Predicted risk against what happened', 'Each scoring run over the last six months', '',
          'If both lines rise and fall together, the model is tracking real movement. The two charts have their own scales on purpose.')}
        <div class="grid g-2">
          <div><p class="section-title" style="margin:0 0 6px">Average 30-day risk</p>
            ${Chart.slot(w => Chart.line([{ name: 'Average 30-day risk', color: Chart.colors.s1, area: true,
              points: trend.map(r => ({ x: r.as_of.slice(5), y: r.mean_risk_30 })) }], { height: 170, fmt: v => (v * 100).toFixed(1) + '%' , width: w }))}</div>
          <div><p class="section-title" style="margin:0 0 6px">Exits in the 14 days before each run</p>
            ${Chart.slot(w => Chart.line([{ name: 'Exits', color: Chart.colors.s2,
              points: trend.map(r => ({ x: r.as_of.slice(5), y: r.actual_exits_14d })) }], { height: 170, fmt: v => num(v) , width: w }))}</div>
        </div>
      </section>
    </div>`;
  }

  function wfCells(wf) {
    if (!wf || !wf.rows) return '';
    const c = wf.columns, ix = n => c.indexOf(n);
    return wf.rows.map((r, i) => `<i class="${esc(r[ix('risk_band')])}" style="--k:${Math.min(i, 900)}" data-emp="${esc(r[0])}"
      data-tip-h="${esc(`<b>${esc(r[0])}</b> ${esc(r[ix('Position')])}<div class="t-row"><span>${esc(r[ix('Site')])}</span></div><div class="t-row"><span>90-day risk</span><b>${pct(r[ix('risk_90')])}</b></div><div class="t-row"><span>Band</span><b>${esc(r[ix('risk_band')])}</b></div>`)}"></i>`).join('');
  }

  /* ============================================================ watchlist */
  const WL_COLS = [
    ['EmployeeID', 'Employee', ''], ['Position', 'Role', ''], ['Site', 'Site', 'opt'], ['EmploymentType', 'Type', 'opt'],
    ['TenureDays', 'Tenure', 'num opt'], ['risk_30', '30-day', 'num opt'], ['risk_90', '90-day', 'num'],
    ['risk_velocity', 'Change', 'num opt'], ['anomaly_score', 'Anomaly', 'num opt'], ['priority_score', 'Priority', '']
  ];

  function sortRows(rows, key, dir) {
    const s = rows.slice();
    s.sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });
    return s;
  }

  function watchlist(rows, filters, state, k = {}) {
    const bands = [['', 'Everyone', k.headcount], ['Critical', 'Critical', k.critical], ['High', 'High', k.high],
                   ['Medium', 'Medium', k.medium], ['Low', 'Low', k.low]];
    const sorted = sortRows(rows, state.sort, state.dir);
    const shown = sorted.slice(0, state.shown || 200);
    const chips = [
      state.site && ['site', state.site], state.department && ['department', state.department],
      state.search && ['search', `“${state.search}”`]].filter(Boolean);
    return `
    <section class="panel flush" id="wl-panel">
      ${head(`${num(rows.length)} ${rows.length === 1 ? 'person' : 'people'}`,
        state.band ? `In the ${esc(state.band)} band. Click anyone for a quick look; open their record for the full story.` :
          'Everyone, highest priority first. Click anyone for a quick look; open their record for the full story.',
        `<a class="btn btn-sm" href="/api/export/watchlist.csv" title="Download the full ranked list">${I('download')} Export CSV</a>`)}
      <div class="toolbar">
        <div class="seg" id="wl-bands" role="group" aria-label="Risk band">
          ${bands.map(([v, l, n]) => `<button data-band-chip="${v}" class="${state.band === v ? 'on' : ''}">${l}${n != null ? `<span class="n">${num(n)}</span>` : ''}</button>`).join('')}
        </div>
        <label class="search">${I('search')}<input id="wl-search" placeholder="Search ID, role, department or site"
          value="${esc(state.search || '')}" aria-label="Search the watchlist"></label>
        <select id="wl-site" aria-label="Filter by site"><option value="">All sites</option>
          ${(filters.sites || []).map(s => `<option ${state.site === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select id="wl-dept" aria-label="Filter by department"><option value="">All departments</option>
          ${(filters.departments || []).map(s => `<option ${state.department === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      </div>
      ${chips.length ? `<div class="active-filters">${chips.map(([key, v]) =>
        `<button data-clear="${key}" title="Remove this filter">${esc(v)} ${I('x', 13)}</button>`).join('')}
        <button data-clear="all">Clear all</button></div>` : ''}
      <div class="table-wrap"><table id="wl-table"><thead><tr>
        ${WL_COLS.map(([key, label, cls]) => `<th class="${cls} ${state.sort === key ? 'sorted' : ''}" aria-sort="${state.sort === key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}">
          <button class="sort" data-sort="${key}">${label}<span class="ar">${state.sort === key && state.dir > 0 ? '▲' : '▼'}</span></button></th>`).join('')}
      </tr></thead><tbody>
      ${shown.map(r => `
        <tr class="clickable ${state.peek === r.EmployeeID ? 'sel' : ''}" tabindex="0" data-peek="${esc(r.EmployeeID)}">
          <td>${id(r.EmployeeID)}</td>
          <td class="cell-2">${esc(r.Position)}<span class="sub">${esc(r.Department)}</span></td>
          <td class="opt">${esc(r.Site)}</td>
          <td class="opt" style="white-space:nowrap"><span class="sub" style="display:inline">${esc(r.EmploymentType)}</span></td>
          <td class="num opt">${num(r.TenureDays)}d</td>
          <td class="num opt">${pct(r.risk_30)}</td>
          <td class="num">${riskCell(r.risk_90)}</td>
          <td class="num opt">${delta(r.risk_velocity)}</td>
          <td class="num opt">${r.anomaly_flag ? `<span class="pill warn">${num(r.anomaly_score)}</span>` : `<span class="sub" style="display:inline">${num(r.anomaly_score)}</span>`}</td>
          <td>${band(r.priority_band)}</td>
        </tr>`).join('') || `<tr><td colspan="10">${emptyState('search', 'No one matches these filters', 'Try another band, or clear the filters.')}</td></tr>`}
      </tbody></table></div>
      ${sorted.length > shown.length ? `<div class="t-foot">Showing ${num(shown.length)} of ${num(sorted.length)}
        <button class="btn btn-sm" id="wl-more">Show ${num(Math.min(200, sorted.length - shown.length))} more</button></div>` : ''}
    </section>`;
  }

  /* ================================================================ drawer */
  function drawer(d, canAct) {
    const p = d.profile || {};
    if (!d.scored) return `<div class="drawer-head"><div><h2>${esc(p.EmployeeID)}</h2></div>
      <button class="icon-btn" data-drawer-close aria-label="Close">${I('x')}</button></div>
      <div class="drawer-body">${note('This person is no longer active, so they are not scored.')}</div>`;
    const hz = [7, 15, 30, 90, 180];
    return `
      <div class="drawer-head"><div>
        <div class="row" style="gap:10px">${id(p.EmployeeID)}${band(p.risk_band)}</div>
        <h2 style="margin-top:4px">${esc(p.Position)}</h2>
        <p class="sub">${esc(p.Department)}, ${esc(p.Site)}. ${num(p.TenureDays)} days on rolls.</p></div>
        <button class="icon-btn" data-drawer-close aria-label="Close">${I('x')}</button></div>
      <div class="drawer-body">
        <div><h3>Chance of resigning within</h3>
          <div class="hz">${hz.map(h => `<div class="${h === 90 ? 'key' : ''}"><span>${h} days</span><b>${pct(p['risk_' + h], h < 30 ? 1 : 0)}</b></div>`).join('')}</div></div>
        <div><h3>Why</h3>${Chart.slot(w => Chart.contributions(d.drivers || [], { limit: 5, width: w }))}</div>
        <div><h3>Suggested next steps</h3>${actionsList(d.actions)}</div>
        ${(d.interventions || []).length ? `<div><h3>Already logged</h3>${loggedList(d.interventions)}</div>` : ''}
      </div>
      <div class="drawer-foot">
        <a class="btn" href="#/employee/${encodeURIComponent(p.EmployeeID)}">${I('user')} Full record</a>
        <a class="btn" href="#/employee/${encodeURIComponent(p.EmployeeID)}" data-goto-whatif>${I('sliders')} What-if</a>
        ${canAct ? `<button class="btn btn-primary" data-log-action="${esc(p.EmployeeID)}">${I('plus')} Log action</button>` : ''}
      </div>`;
  }

  function actionsList(actions) {
    return (actions || []).map(a => `<div class="action-item"><span class="a-ic">${I('check', 14)}</span>
      <div><div class="name">${esc(a.action)}</div><div class="why">Because of: ${esc(a.because.toLowerCase())}</div></div>
      <span class="pill">${esc(a.category)}</span></div>`).join('') || `<p class="sub">No factor is pushing this person's risk up.</p>`;
  }

  function loggedList(items) {
    return (items || []).map(i => `<div class="action-item"><span class="a-ic">${I('note', 14)}</span>
      <div><div class="name">${esc(i.action)}</div><div class="why">${esc((i.created_at || '').slice(0, 10))}, ${esc(i.owner || i.created_by || '')}${i.notes ? '. ' + esc(i.notes) : ''}</div></div>
      <span class="pill ${i.status === 'Closed' ? (i.outcome === 'Retained' ? 'good' : '') : 'warn'}">${esc(i.outcome || i.status)}</span></div>`).join('');
  }

  /* ============================================================== employee */
  function employee(d, canAct) {
    const p = d.profile || {};
    const back = `<button class="btn btn-sm btn-ghost back" id="go-back">${I('arrowLeft', 15)} Back</button>`;
    if (!d.scored) {
      return `${back}<div class="panel"><div class="who">${id(p.EmployeeID)}</div><h1 style="font-size:22px;font-weight:500;margin-top:4px">${esc(p.Position)}</h1>
        <p class="sub" style="margin-top:4px">${esc(p.Department)}, ${esc(p.Site)}</p>
        <div style="margin-top:16px">${d.exit ? note(`${d.exit.NoticeDate ? `Resigned on ${esc(d.exit.NoticeDate)}, ` : ''}last day ${esc(d.exit.ExitDate)}: ${esc(d.exit.ExitType)}, ${esc(d.exit.ExitReason)}.`) : ''}</div>
        <div style="margin-top:20px">${timeline(d.timeline)}</div></div>`;
    }
    const hist = (d.history || []).map(h => ({ x: (h.as_of || '').slice(5), y: h.risk_90 }));
    const beh = d.behaviour || [];
    const last = beh[beh.length - 1] || {};
    const mini = (key, title, fmt, color) => `<div><h4>${title}<b>${fmt(last[key])}</b></h4>
      ${Chart.slot(w => Chart.line([{ name: title, color, points: beh.map(b => ({ x: (b.SnapshotDate || '').slice(5, 10), y: b[key] })) }],
        { height: 120, width: w, fmt, left: 34, xTicks: 3, ticks: 3 }))}</div>`;
    const pctile = p.risk_percentile;

    return `
    ${back}
    <div class="stack">
      <section class="panel">
        <div class="emp-head">
          <div>
            <div class="who">${id(p.EmployeeID)}${band(p.risk_band)}${p.anomaly_flag ? `<span class="pill warn">${I('alert', 12)} unusual recent weeks</span>` : ''}</div>
            <h1 style="margin-top:6px">${esc(p.Position)}</h1>
            <div class="meta-line">
              <span>${I('building', 14)}${esc(p.Department)}</span>
              <span>${I('flag', 14)}${esc(p.Site)}</span>
              <span>${I('users', 14)}${esc(p.EmploymentType)}</span>
              <span>${I('compass', 14)}Hired via ${esc(p.RecruitmentSource)}</span>
              <span>${I('clock', 14)}${num(p.TenureDays)} days on rolls</span>
              <span>${I('shield', 14)}Criticality ${p.BusinessCriticality}/5</span>
            </div>
          </div>
          <div class="row">${canAct ? `<button class="btn btn-primary" data-log-action="${esc(p.EmployeeID)}">${I('plus')} Log retention action</button>` : ''}</div>
        </div>
        <div class="emp-risk">
          <span class="big">${pct(p.risk_90, 0)}</span>
          <span class="lbl">chance of resigning in the next 90 days. Higher than ${pctile != null ? Math.floor(pctile) : '—'}% of the workforce${d.peer_median_risk_90 != null ? `; the ${esc(p.Department)} median is ${pct(d.peer_median_risk_90)}` : ''}.</span>
        </div>
      </section>

      <section class="panel whatif" id="whatif" aria-label="What-if simulator"></section>

      <div class="grid g-side">
        <section class="panel">
          ${head('Over the next six months', 'Chance they have not resigned by each day', '',
            'Built from the same horizon models as the numbers on this page, so the curve and the percentages always agree.')}
          <div class="hz" style="margin-bottom:14px">${[7, 15, 30, 90, 180].map(h => `<div class="${h === 90 ? 'key' : ''}"><span>${h} days</span><b>${pct(p['risk_' + h], h < 30 ? 1 : 0)}</b></div>`).join('')}</div>
          ${Chart.slot(w => Chart.retention(d.survival_curve || [], { width: w }))}
        </section>
        <section class="panel">
          ${head('What is driving this score', 'Each area adds up its related measures. Ember pushes risk up, blue pulls it down; hover for the detail.', '',
            'Exact SHAP attributions from the 90-day model: how much each factor moved this person\'s probability compared with an average employee.')}
          ${Chart.slot(w => Chart.contributions(d.drivers || [], { width: w }))}
          ${note('These show what moved the score, not proven causes. Use them to open a conversation, not to settle one.')}
        </section>
      </div>

      <div class="grid g-2">
        <section class="panel">
          ${head('Suggested next steps', 'From the factors pushing risk up')}
          ${actionsList(d.actions)}
        </section>
        <section class="panel">
          ${head('Actions logged')}
          ${loggedList(d.interventions) || emptyState('note', 'Nothing logged yet', canAct ? 'After you speak to them, use “Log retention action” at the top.' : '')}
        </section>
      </div>

      <section class="panel">
        ${head('The last 26 weeks', 'The weekly signals the model reads. Each chart has its own scale.')}
        <div class="mini-charts">
          ${mini('OvertimeHours7D', 'Overtime hours a week', v => num(v, 0), Chart.colors.s1)}
          ${mini('EngagementScore', 'Engagement pulse, 1 to 10', v => num(v, 1), Chart.colors.s1)}
          ${mini('AbsenceDays7D', 'Days absent a week', v => num(v, 0), Chart.colors.s1)}
        </div>
      </section>

      <div class="grid g-side">
        <section class="panel">
          ${head('Risk history', '90-day risk at every scoring run')}
          ${Chart.slot(w => Chart.line([{ name: '90-day risk', color: Chart.colors.s1, area: true, points: hist }], { height: 180, width: w, fmt: v => (v * 100).toFixed(0) + '%' }))}
        </section>
        <section class="panel">
          ${head('Record', 'Joining, moves, grievances and other events')}
          ${timeline((d.timeline || []).slice(0, 10))}
        </section>
      </div>
    </div>`;
  }

  function timeline(items) {
    if (!items || !items.length) return emptyState('calendar', 'No events recorded');
    const mark = new Set(['Exit', 'Resignation Submitted', 'Grievance', 'Manager Change', 'Promotion']);
    return `<ul class="timeline">${items.slice(0, 14).map(e => `
      <li class="${mark.has(e.EventType) ? 'mark' : ''}"><span class="when">${esc((e.EventDate || '').slice(0, 10))}</span>
        <span class="pip"></span><span class="what">${esc(e.EventType)}<span class="sub">${esc(e.EventDetail)}</span></span></li>`).join('')}</ul>`;
  }

  /* ================================================================ early */
  function early(d) {
    const bands = (d.bands || []).slice(0, 6);
    return `
    <div class="stack">
      <div class="stats" style="--n:3">
        ${stat({ k: 'Exits within 30 days of joining', v: pct(d.early_share), s: `of all ${num(d.total_exits)} exits`,
          help: 'Share of all exits that happened in the first month after joining.' })}
        ${stat({ k: 'New joiners on rolls', v: num((d.new_joiners || []).length), s: 'under 90 days, scored today' })}
        ${stat({ k: 'Hiring channels compared', v: num((d.by_source || []).length), s: 'see channel quality below' })}
      </div>
      <section class="panel">
        ${head('When new hires leave', 'Exits by how long they had been with us. Hover a column for the split.')}
        ${Chart.slot(w => Chart.columns(bands.map(b => ({ label: b.band, value: b.exits, sub: b.absconding })), { width: w, height: 240 }))}
        <div class="legend"><span><i class="box" style="background:${Chart.colors.s1}"></i>gave notice</span>
          <span><i class="box" style="background:${Chart.colors.s2}"></i>left without notice</span></div>
      </section>
      <div class="grid g-2">
        <section class="panel flush">
          ${head('Channel quality', 'Share of each channel\'s hires who left within 30 days')}
          <div class="table-wrap"><table><thead><tr>
            <th>Channel</th><th class="num">Hired</th><th class="num opt">Left in 30 days</th><th class="num">Early exit rate</th><th class="num opt">Median tenure at exit</th>
          </tr></thead><tbody>
          ${(d.by_source || []).map(s => `<tr><td>${esc(s.source)}</td><td class="num">${num(s.hired)}</td>
            <td class="num opt">${num(s.early_exits_30d)}</td><td class="num">${riskCell(s.early_exit_rate)}</td>
            <td class="num opt">${s.median_tenure_at_exit ? num(s.median_tenure_at_exit) + 'd' : '—'}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="t-foot">The cheapest channel is not the cheapest if a fifth of its hires leave inside a month.</div>
        </section>
        <section class="panel flush">
          ${head('New joiners at risk now', 'On rolls under 90 days, highest 30-day risk first')}
          <div class="table-wrap"><table><thead><tr>
            <th>Employee</th><th>Role</th><th class="num">Day</th><th class="num opt">Onboarding</th><th class="num">30-day</th>
          </tr></thead><tbody>
          ${(d.new_joiners || []).slice(0, 12).map(r => `<tr class="clickable" tabindex="0" data-peek="${esc(r.EmployeeID)}">
            <td>${id(r.EmployeeID)}<span class="sub">${esc(r.RecruitmentSource)}</span></td>
            <td class="cell-2">${esc(r.Position)}<span class="sub">${esc(r.Site)}</span></td>
            <td class="num">${num(r.TenureDays)}</td>
            <td class="num opt">${r.OnboardingCompletionPct != null ? `<span class="${r.OnboardingCompletionPct < 70 ? 'delta up' : ''}">${num(r.OnboardingCompletionPct)}%</span>` : '—'}</td>
            <td class="num">${pct(r.risk_30)}</td></tr>`).join('') || `<tr><td colspan="5">${emptyState('newjoiner', 'No new joiners on rolls')}</td></tr>`}
          </tbody></table></div>
        </section>
      </div>
      <section class="panel">
        ${head('Reasons given for early exits', 'From exit records of people who left within 30 days')}
        ${Chart.slot(w => Chart.hbars((d.early_reasons || []).map(r => ({ label: r.reason, value: r.count })), { width: w, labelW: 220 }))}
      </section>
    </div>`;
  }

  /* ============================================================== segments */
  function segments(rows, by) {
    const options = [['Site', 'Site'], ['Department', 'Department'], ['EmploymentType', 'Employment type'],
                     ['RecruitmentSource', 'Hiring channel'], ['Position', 'Role'], ['tenure_band', 'Tenure']];
    const label = (options.find(o => o[0] === by) || [by, by])[1];
    const top = rows.slice().sort((a, b) => b.mean_risk_90 - a.mean_risk_90).slice(0, 12);
    return `
    <div class="stack">
      <section class="panel">
        ${head(`Average 90-day risk by ${label.toLowerCase()}`, 'Hover a bar for headcount and the last 12 months of exits.',
          `<div class="seg" id="seg-switch" role="group" aria-label="Group by">${options.map(([v, l]) =>
            `<button data-by="${v}" class="${by === v ? 'on' : ''}">${l}</button>`).join('')}</div>`)}
        ${Chart.slot(w => Chart.hbars(top.map(s => ({ label: `${s.segment}`, value: s.mean_risk_90, display: `${pct(s.mean_risk_90)}  ·  ${num(s.headcount)} people`,
          tip: `<b>${esc(s.segment)}</b><div class="t-row"><span>Average 90-day risk</span><b>${pct(s.mean_risk_90)}</b></div><div class="t-row"><span>Headcount</span><b>${num(s.headcount)}</b></div><div class="t-row"><span>Expected resignations, 90 days</span><b>${num(s.expected_exits_90d, 1)}</b></div><div class="t-row"><span>Exits, 12 months</span><b>${num(s.exits_12m)}</b></div>` })),
          { width: w, labelW: 240, valW: 190 }))}
      </section>
      <section class="panel flush">
        ${head(`Every ${label.toLowerCase()} in detail`, 'Forward-looking risk beside what actually happened', '',
          'Expected resignations = the sum of 90-day probabilities in the group. Early exits = people who left within 30 days of joining.')}
        <div class="table-wrap"><table><thead><tr>
          <th>${esc(label)}</th><th class="num">Headcount</th><th class="num">Avg 90-day risk</th><th class="num opt">Critical</th>
          <th class="num opt">Rising fast</th><th class="num">Expected, 90 days</th><th class="num opt">Exits, 12m</th>
          <th class="num opt">Early exits</th><th class="num">Attrition, 12m</th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.segment)}</td><td class="num">${num(r.headcount)}</td><td class="num">${riskCell(r.mean_risk_90)}</td>
          <td class="num opt">${num(r.critical)}</td><td class="num opt">${num(r.accelerating)}</td><td class="num">${num(r.expected_exits_90d, 1)}</td>
          <td class="num opt">${num(r.exits_12m)}</td><td class="num opt">${num(r.early_exits_12m)}</td><td class="num">${pct(r.attrition_12m)}</td></tr>`).join('')
          || `<tr><td colspan="9">${emptyState('segments', 'No groups to show')}</td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
  }

  /* ============================================================= anomalies */
  function anomalies(d) {
    return `
    <div class="grid g-2">
      <section class="panel flush">
        ${head('Sudden behaviour changes', 'Found by a separate model that watches week-to-week change', '',
          'Isolation Forest over week-on-week changes in overtime, absence, engagement and more. It is independent of the risk model, so it can catch a pattern the risk model has never seen.')}
        <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Role</th><th class="num">Anomaly</th><th class="num">30-day risk</th><th>Band</th></tr></thead><tbody>
        ${(d.items || []).map(r => `<tr class="clickable" tabindex="0" data-peek="${esc(r.EmployeeID)}">
          <td>${id(r.EmployeeID)}<span class="sub">${num(r.TenureDays)} days</span></td>
          <td class="cell-2">${esc(r.Position)}<span class="sub">${esc(r.Site)}</span></td>
          <td class="num"><span class="pill warn">${num(r.anomaly_score)}</span></td><td class="num">${pct(r.risk_30)}</td><td>${band(r.risk_band)}</td>
        </tr>`).join('') || `<tr><td colspan="5">${emptyState('check', 'Nothing unusual this run')}</td></tr>`}
        </tbody></table></div>
        <div class="t-foot">A high anomaly score with low risk is still worth a call: a new pattern shows up here first.</div>
      </section>
      <section class="panel flush">
        ${head('Risk rising fastest', 'Biggest movers in 30-day risk since the previous run')}
        <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Role</th><th class="num opt">Before</th><th class="num">Now</th><th class="num">Change</th></tr></thead><tbody>
        ${(d.movers || []).map(r => `<tr class="clickable" tabindex="0" data-peek="${esc(r.EmployeeID)}">
          <td>${id(r.EmployeeID)}</td><td class="cell-2">${esc(r.Position)}<span class="sub">${esc(r.Site)}</span></td>
          <td class="num opt">${pct(r.prev_risk_30)}</td><td class="num">${pct(r.risk_30)}</td><td class="num">${delta(r.risk_velocity)}</td>
        </tr>`).join('') || `<tr><td colspan="5">${emptyState('clock', 'Needs at least two scoring runs')}</td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
  }

  /* ========================================================= interventions */
  function interventions(d, canAct) {
    const e = d.effectiveness || {};
    const retained = (e.summary || []).reduce((a, r) => a + r.retained, 0);
    return `
    <div class="stack">
      <div class="stats" style="--n:3">
        ${stat({ k: 'Actions logged', v: num(e.total), s: 'all time' })}
        ${stat({ k: 'Waiting for an outcome', v: num(e.open), s: canAct ? 'record the outcome below once you know it' : 'still open' })}
        ${stat({ k: 'Closed as retained', v: num(retained), s: 'the person stayed after the action' })}
      </div>
      <section class="panel flush">
        ${head('What has worked', 'Outcomes grouped by action type', '',
          'Average risk change = movement in 30-day risk between logging the action and closing it. Negative is good.')}
        <div class="table-wrap"><table><thead><tr><th>Action</th><th class="num">Closed</th><th class="num">Retained</th><th class="num">Exited</th><th class="num">Avg risk change</th></tr></thead><tbody>
        ${(e.summary || []).map(r => `<tr><td>${esc(r.action)}</td><td class="num">${num(r.closed)}</td><td class="num">${num(r.retained)}</td>
          <td class="num">${num(r.exited)}</td><td class="num">${r.mean_risk_change_pts == null ? '—' : delta(r.mean_risk_change_pts)}</td></tr>`).join('')
          || `<tr><td colspan="5">${emptyState('target', 'No closed actions yet', 'Outcomes appear here once actions are closed.')}</td></tr>`}
        </tbody></table></div>
        ${e.note ? `<div class="t-foot">${esc(e.note)}</div>` : ''}
      </section>
      <section class="panel flush">
        ${head('Action log', canAct ? 'Every conversation and follow-up. Record the outcome once you know it.' : 'Every conversation and follow-up')}
        <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Action</th><th class="opt">Owner</th><th class="opt">Raised</th>
          <th class="num opt">Risk then</th><th>Status</th>${canAct ? '<th></th>' : ''}</tr></thead><tbody>
        ${(d.items || []).map(i => `<tr>
          <td><a href="#/employee/${encodeURIComponent(i.EmployeeID)}" class="id">${esc(i.EmployeeID)}</a></td>
          <td class="cell-2">${esc(i.action)}<span class="sub">${esc(i.notes || '')}</span></td>
          <td class="opt">${esc(i.owner || i.created_by || '')}</td><td class="opt">${esc((i.created_at || '').slice(0, 10))}</td>
          <td class="num opt">${pct(i.risk_at_creation)}</td>
          <td><span class="pill ${i.status === 'Closed' ? (i.outcome === 'Retained' ? 'good' : '') : 'warn'}">${esc(i.outcome || i.status)}</span></td>
          ${canAct ? `<td>${i.status === 'Open' ? `<button class="btn btn-sm close-int" data-id="${i.id}" data-emp-id="${esc(i.EmployeeID)}">Record outcome</button>` : ''}</td>` : ''}
        </tr>`).join('') || `<tr><td colspan="7">${emptyState('actions', 'Nothing logged yet', 'Open anyone on the watchlist and choose “Log action”.')}</td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
  }

  /* ============================================================ governance */
  function governance(d, state = {}) {
    if (d.status === 'no_model') return notScored();
    const c = d.current || {}, metrics = c.metrics || {};
    const hs = Object.keys(metrics).sort((a, b) => a - b);
    const bh = String(c.band_horizon || 90), mb = metrics[bh] || {};
    const val = c.validation || {}, lt = val.lead_time || {}, sr = val.shap_recovery || {}, sv = val.survival || {};
    const four = (lt.curve || []).find(x => x.weeks_before === 4) || {};
    const twelve = (lt.curve || []).find(x => x.weeks_before === 12) || {};
    const fairBy = state.fairBy || 'Site';
    const fair = (mb.fairness || []).filter(f => f.attribute === fairBy);
    const flagged = (mb.fairness || []).filter(f => (f.issues || []).length);
    const drift = c.drift || [];
    const shifted = drift.filter(x => x.psi > 0.25);

    return `
    <div class="stack">
      <section class="briefing">
        <p class="date">Model ${esc(c.version)}, trained ${esc(longDate((c.trained_at || '').slice(0, 10)))}</p>
        <h2>It predicts who will decide to resign, and every number below was measured on a later period the model never saw.</h2>
      </section>

      <div class="kv" style="--n:4">
        <div><span>Prediction target</span><b style="font-size:15px">Resignation decision</b><small>terminations and contract ends excluded</small></div>
        <div><span>Data up to</span><b>${esc(longDate((c.window || {}).data_cutoff))}</b><small>weekly snapshots</small></div>
        <div><span>Models in use</span><b style="font-size:15px">${[...new Set(Object.values(c.champions || {}))].map(k => esc(MODEL_NAMES[k] || k)).join(', ')}</b><small>blend unless one model clearly wins</small></div>
        <div><span>Drifted inputs</span><b>${num(shifted.length)}</b><small>of ${num(c.n_features)} features, PSI above 0.25</small></div>
      </div>

      <section class="panel" id="lead-time">
        ${head('How much warning does it give?', `For ${num(lt.leavers)} people who resigned in the held-out period: were they already on the call list (top 15%) in the weeks before?`, '',
          'Each week is ranked exactly as the weekly scoring run ranks it. A random list of the same size would catch 15% at every point.')}
        ${Chart.slot(w => Chart.leadTime(lt.curve, lt.random_baseline ?? 0.15, { width: w }))}
        <p class="sub" style="margin-top:8px">${four.caught != null ? `${pct(four.caught, 0)} were flagged four weeks ahead and ${pct(twelve.caught, 0)} twelve weeks ahead, against 15% for a random list. Based on ${num(lt.leavers)} resignations.` : ''}</p>
      </section>

      <section class="panel flush">
        ${head('How well does it rank people?', 'Held-out test window per horizon, with 95% intervals from resampling employees', '',
          'PR-AUC suits rare events; random ranking scores the base rate. Recall at 15% = share of resignations that land on the call list. Precision at 15% = share of the call list who do resign.')}
        <div class="table-wrap"><table><thead><tr>
          <th>Horizon</th><th>Model</th><th class="num">Resignations</th><th class="num opt">Base rate</th><th class="num">PR-AUC</th>
          <th class="num opt">95% interval</th><th class="num">Recall at 15%</th><th class="num opt">Precision at 15%</th><th class="num opt">Brier</th><th class="opt">Test window</th>
        </tr></thead><tbody>
        ${hs.map(h => { const m = metrics[h]; return `<tr>
          <td>${h} days</td><td>${esc(MODEL_NAMES[m.champion] || m.champion || '')}</td>
          <td class="num">${num(m.positives)}</td><td class="num opt">${pct(m.base_rate, 1)}</td>
          <td class="num">${num(m.pr_auc, 3)}</td><td class="num opt">${m.pr_auc_ci ? `${num(m.pr_auc_ci[0], 3)} – ${num(m.pr_auc_ci[1], 3)}` : '—'}</td>
          <td class="num">${pct(m.recall_at_15, 0)}</td><td class="num opt">${pct(m.precision_at_15, 0)}</td><td class="num opt">${num(m.brier, 4)}</td>
          <td class="opt"><span class="sub" style="display:inline">${m.windows ? esc(m.windows.test[0]) + ' to ' + esc(m.windows.test[1]) : ''}</span></td>
        </tr>`; }).join('')}
        </tbody></table></div>
      </section>

      ${backtestPanel(d.backtest)}
      ${leverPanel(d.lever_audit)}

      <div class="grid g-side">
        <section class="panel">
          ${head('Three models compete, one serves', 'Chosen on the validation window, never on test. Hover for detail.', '',
            'Each horizon trains gradient boosting, logistic regression and a blend of the two. The blend serves unless a single model beats it on validation by more than 0.01 PR-AUC: when candidates are tied, picking the top validation score mostly picks noise, and the rolling backtest showed the blend holding up best.')}
          ${Chart.slot(w => Chart.forest(metrics, { width: w }))}
          <div class="legend">
            <span><i class="box" style="background:${Chart.colors.cat1}"></i>Gradient boosting</span>
            <span><i class="box" style="background:${Chart.colors.cat2}"></i>Logistic regression</span>
            <span><i class="box" style="background:${Chart.colors.cat3}"></i>Blend</span>
            <span>Filled dot: the live model</span>
          </div>
        </section>
        <section class="panel">
          ${head('Are the percentages honest?', `Predicted against observed, ${esc(bh)}-day model`, '',
            'Each dot is a tenth of the test rows. Dots on the dashed line mean a 10% prediction really does resign about 10% of the time.')}
          ${Chart.slot(w => Chart.calibration(mb.calibration, { width: w, height: 300 }))}
        </section>
      </div>

      <section class="panel" id="shap-check">
        ${head('Does it explain for the right reasons?', `The demo data comes from a simulator with known causes. ${num(sr.recovered)} of ${num(sr.total)} planted causes are recovered with the right direction, and the two pure-noise inputs get almost nothing.`, '',
          'Share = this factor\'s portion of all SHAP attribution on the test window. Direction compares the factor\'s value with its SHAP effect, which should match the simulator.')}
        <div class="table-wrap"><table><thead><tr><th>Planted cause</th><th>Should</th><th class="num">Share of attribution</th><th class="num opt">Direction check</th><th>Verdict</th></tr></thead><tbody>
        ${(sr.drivers || []).map(r => `<tr><td>${esc(r.driver)}</td><td><span class="sub" style="display:inline">${esc(r.expected)}</span></td>
          <td class="num"><div class="risk-cell"><span class="tnum">${pct(r.share, 1)}</span><span class="track"><span class="fill" style="width:${Math.min(r.share * 900, 100)}%;background:var(--series-1)"></span></span></div></td>
          <td class="num opt">${r.direction_corr == null ? '—' : num(r.direction_corr, 2)}</td>
          <td>${verdict(r.verdict)}</td></tr>`).join('')}
        ${(sr.noise_controls || []).map(n => `<tr><td>${esc(n.feature)}</td><td><span class="sub" style="display:inline">be ignored</span></td>
          <td class="num">${pct(n.share, 1)}</td><td class="num opt">—</td><td>${verdict(n.verdict === 'ignored' ? 'recovered' : 'wrong direction', n.verdict)}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="sub" style="margin-top:10px">“Weak” causes are real but small or rare in this data (for example salary delays, which only hit a few sites in a few months), so the model has had little to learn from.</p>
      </section>

      <section class="panel flush" id="fairness">
        ${head('Where is it less reliable?', `Checked at the call-list cut (top 15%) on the ${esc(bh)}-day test window`,
          `<div class="seg" id="fair-switch" role="group" aria-label="Group by">${['Site', 'Department', 'EmploymentType', 'RecruitmentSource', 'TenureBand'].map(v =>
            `<button data-fair="${v}" class="${fairBy === v ? 'on' : ''}">${{ EmploymentType: 'Contract', RecruitmentSource: 'Channel', TenureBand: 'Tenure' }[v] || v}</button>`).join('')}</div>`,
          'Predicted ÷ actual below 0.75 means the model under-states that group\'s risk, so its people reach the list late. Recall = share of the group\'s resignations that reach the list.')}
        ${flagged.length ? `<div style="padding:0 20px 14px">${note(`<b>${num(flagged.length)} group${flagged.length > 1 ? 's' : ''} flagged.</b> ` +
          flagged.slice(0, 4).map(f => `${esc(f.group)} (${f.issues.join(', ')})`).join('; ') + (flagged.length > 4 ? '; and more below.' : '.') +
          ' A sudden change at one site, such as delayed salaries, is the usual cause: check the drift panel below.', 'warn')}</div>` : ''}
        <div class="table-wrap"><table><thead><tr><th>Group</th><th class="num opt">Rows</th><th class="num">Resignations</th><th class="num opt">Actual rate</th>
          <th class="num opt">Predicted rate</th><th class="num">Predicted ÷ actual</th><th class="num">Recall at cut</th><th>Check</th></tr></thead><tbody>
        ${fair.map(f => `<tr><td>${esc(f.group)}</td><td class="num opt">${num(f.n)}</td><td class="num">${num(f.events)}</td>
          <td class="num opt">${pct(f.base_rate, 1)}</td><td class="num opt">${pct(f.mean_score, 1)}</td>
          <td class="num">${f.calibration_ratio == null ? '—' : num(f.calibration_ratio, 2)}</td>
          <td class="num">${f.recall == null ? '—' : pct(f.recall, 0)}</td>
          <td>${(f.issues || []).length ? f.issues.map(i => `<span class="pill bad">${esc(i)}</span>`).join(' ') : `<span class="sub" style="display:inline">${f.calibration_ratio == null ? 'too few events' : 'ok'}</span>`}</td></tr>`).join('')
          || `<tr><td colspan="8">${emptyState('users', 'No group met the minimum size')}</td></tr>`}
        </tbody></table></div>
        <div class="t-foot">A group flagged more often is not automatically unfair: site conditions genuinely differ. Explain it before scores drive decisions about people.</div>
      </section>

      <div class="grid g-2">
        <section class="panel">
          ${head('Has the data moved?', 'Population stability of each input: training data against the last 13 weeks', '',
            'Below 0.10 is stable, 0.10 to 0.25 is worth watching, above 0.25 means retrain before trusting the scores.')}
          ${Chart.slot(w => Chart.hbars(drift.slice(0, 10).map(x => ({ label: x.feature, value: x.psi, display: x.psi.toFixed(2),
            color: x.psi > 0.25 ? Chart.colors.high : x.psi > 0.1 ? Chart.colors.med : Chart.colors.low,
            tip: `<b>${esc(x.feature)}</b><div class="t-row"><span>PSI</span><b>${x.psi.toFixed(3)}</b></div><div class="t-row"><span>Training mean</span><b>${num(x.baseline_mean, 2)}</b></div><div class="t-row"><span>Recent mean</span><b>${num(x.current_mean, 2)}</b></div>` })),
            { width: w, labelW: 230, valW: 50, ref: 0.25 }))}
          <div class="legend"><span><i class="dash"></i>retrain line, 0.25</span></div>
        </section>
        <section class="panel">
          ${head('A second opinion on timing', 'An independent survival model, scored the same way', '',
            'Harrell\'s C: of two people where we know who resigned first, how often the model gave that person the higher risk. 0.5 is a coin flip.')}
          <div class="kv" style="--n:2">
            <div><span>Horizon model (live)</span><b>${num(sv.c_index_horizon_model, 3)}</b><small>concordance</small></div>
            <div><span>Survival model</span><b>${num(sv.c_index_survival_model, 3)}</b><small>concordance</small></div>
          </div>
          <p class="sub" style="margin-top:12px">The live models order people slightly better, so the employee page draws its six-month curve from them. That keeps the curve and the percentages in agreement.</p>
        </section>
      </div>

      <div class="grid g-2">
        <section class="panel flush">
          ${head('Versions')}
          <div class="table-wrap"><table><thead><tr><th>Version</th><th>Trained</th><th class="num opt">Features</th><th class="opt">Fingerprint</th><th></th></tr></thead><tbody>
          ${(d.versions || []).slice(0, 8).map(v => `<tr><td>${id(v.version)}</td><td>${esc((v.trained_at || '').slice(0, 16).replace('T', ' '))}</td>
            <td class="num opt">${num(v.n_features)}</td><td class="opt">${id(v.data_fingerprint)}</td>
            <td>${v.is_current ? '<span class="pill good">live</span>' : ''}</td></tr>`).join('')}
          </tbody></table></div>
        </section>
        <section class="panel flush">
          ${head('Scoring runs')}
          <div class="table-wrap"><table><thead><tr><th>As of</th><th class="num">Scored</th><th class="num">Avg 30-day risk</th><th class="num">Critical</th></tr></thead><tbody>
          ${(d.runs || []).slice(0, 8).map(r => `<tr><td>${esc(r.as_of)}</td><td class="num">${num(r.n_scored)}</td>
            <td class="num">${pct(r.mean_risk_30, 2)}</td><td class="num">${num(r.n_critical)}</td></tr>`).join('')}
          </tbody></table></div>
        </section>
      </div>
    </div>`;
  }

  /* backtest: the same method replayed at earlier cut-offs */
  function backtestPanel(bt) {
    if (!bt || !bt.horizons || !Object.keys(bt.horizons).length) return '';
    const hs = Object.keys(bt.horizons).sort((a, b) => a - b);
    const maxPr = Math.max(...hs.flatMap(h => bt.horizons[h].origins.map(o => o.champion_scores.pr_auc)), 0.01);
    const sum = h => bt.horizons[h].summary;
    const lede = hs.map(h => `${h}-day model ${num(sum(h).lift_min, 1)}× to ${num(Math.max(...bt.horizons[h].origins.map(o => o.lift)), 1)}× better than random`).join('; ');
    return `
      <section class="panel flush" id="backtest">
        ${head('Does it hold up over time?', `The whole method replayed at ${num(bt.horizons[hs[0]].origins.length)} cut-offs, ${bt.step_months} months apart, each scored on a later window it never saw. ${esc(lede)}.`, '',
          'One test window gives one number, and one number can be lucky. Each row retrains every candidate from scratch with only the data available at that date. The test windows do not overlap.')}
        <div class="table-wrap"><table><thead><tr>
          <th>Horizon</th><th>Test window</th><th class="num opt">Trained on</th><th class="num">Resignations</th><th class="num opt">Base rate</th>
          <th>PR-AUC against random</th><th class="num">Lift</th><th class="num">Recall at 15%</th><th class="opt">Model used</th>
        </tr></thead><tbody>
        ${hs.map(h => bt.horizons[h].origins.map((o, i) => `<tr class="${i === 0 ? 'grp-first' : ''}">
          <td>${i === 0 ? `<b>${h} days</b>` : ''}</td>
          <td><span class="tnum">${esc(o.test[0])} to ${esc(o.test[1])}</span>${i === 0 ? ' <span class="pill accent">latest</span>' : ''}</td>
          <td class="num opt">${num(o.train_rows)} rows</td>
          <td class="num">${num(o.decisions)}</td><td class="num opt">${pct(o.base_rate, 1)}</td>
          <td><div class="bt-bar" data-tip-h="${esc(`<b>${o.test[0]} to ${o.test[1]}</b>` + Object.entries(o.candidates).map(([k, c]) => `<div class='t-row'><span>${MODEL_NAMES[k] || k}</span><b>${c.pr_auc.toFixed(3)}</b></div>`).join(''))}">
            <span class="track"><i class="rand" style="left:${(o.base_rate / maxPr) * 100}%"></i><i class="fill" style="width:${(o.champion_scores.pr_auc / maxPr) * 100}%"></i></span>
            <b>${num(o.champion_scores.pr_auc, 3)}</b></div></td>
          <td class="num">${num(o.lift, 1)}×</td>
          <td class="num">${pct(o.champion_scores.recall_at_15, 0)}</td>
          <td class="opt">${esc(MODEL_NAMES[o.champion] || o.champion)}</td></tr>`).join('')).join('')}
        </tbody></table></div>
        <div class="t-foot"><span><i class="bt-key"></i> PR-AUC of the model the rule chose</span><span><i class="bt-key rand"></i> what a random list scores (the base rate)</span>
          <span class="spacer"></span><span>Hover a bar for every candidate. The oldest window trained on the least data.</span></div>
      </section>`;
  }

  /* lever audit: do the what-if levers push risk the way they should? */
  function leverPanel(la) {
    if (!la || !la.horizons) return '';
    const h = la.horizons['90'] || la.horizons[Object.keys(la.horizons).pop()];
    if (!h) return '';
    const worst = Math.max(...Object.values(la.horizons).map(x => x.wrong_share));
    return `
      <section class="panel" id="lever-audit">
        ${head('Do the what-if levers point the right way?', `${num(la.people)} people were projected forward with each lever moved. Across all five horizons, ${pct(worst, 1)} of moves at most went the wrong way.`, '',
          'Moves smaller than 0.01 in log-odds count as no reaction. Measured on the raw model score, which calibration can only flatten, never reverse.')}
        <div class="lv-audit">${h.moves.map(m => `
          <div class="la-row" data-tip-h="${esc(`<b>${m.move}</b><div class='t-row'><span>Expected direction</span><b>${pct(m.expected_share, 0)}</b></div><div class='t-row'><span>No reaction</span><b>${pct(m.no_reaction_share, 0)}</b></div><div class='t-row'><span>Wrong direction</span><b>${pct(m.wrong_share, 0)}</b></div><div class='t-row'><span>Median effect (log-odds)</span><b>${m.median_logodds.toFixed(3)}</b></div>`)}">
            <span class="nm">${esc(m.move)}</span>
            <span class="stack-bar"><i class="ok" style="width:${m.expected_share * 100}%"></i><i class="none" style="width:${m.no_reaction_share * 100}%"></i><i class="bad" style="width:${m.wrong_share * 100}%"></i></span>
            <b class="${m.wrong_share > 0.05 ? 'warn-t' : ''}">${pct(m.expected_share, 0)}</b></div>`).join('')}
        </div>
        <div class="legend" style="margin-top:12px"><span><i class="box" style="background:var(--good-mark)"></i>Expected direction</span>
          <span><i class="box" style="background:var(--line-2)"></i>No reaction</span><span><i class="box" style="background:var(--bad)"></i>Wrong direction</span>
          <span>90-day model, the one that sets bands and explanations</span></div>
      </section>`;
  }

  function verdict(v, text) {
    const map = { recovered: ['ok', 'check', 'recovered'], weak: ['weak', 'info', 'weak'], 'wrong direction': ['bad', 'alert', 'wrong direction'] };
    const [cls, icon, label] = map[v] || map.weak;
    return `<span class="verdict ${cls}">${I(icon, 14)}${esc(text || label)}</span>`;
  }

  /* =============================================================== copilot */
  function copilot() {
    const prompts = ['Who should I call today?', 'Which recruitment channel has the worst early attrition?',
      'Why is risk rising at Port Terminal Project?', 'Which site needs attention this month?',
      'How accurate is the model?', 'What are the most common risk drivers right now?'];
    return `
    <section class="panel">
      ${head('Ask about the workforce', 'Every answer is built from live queries on the current scoring run, so it cannot invent a number.')}
      <div class="chat" id="chat">
        <div class="msg bot"><span class="who">${I('spark', 15)}</span><div><pre>Ask about risk, sites, hiring channels, new joiners, a specific employee ID, or the model itself. Or start with one of the questions below.</pre></div></div>
      </div>
      <div class="suggests">${prompts.map(p => `<button data-q="${esc(p)}">${esc(p)}</button>`).join('')}</div>
      <form class="ask" id="ask-form">
        <input id="ask-input" placeholder="Ask a question, for example: who joined last month and is at risk?" autocomplete="off" aria-label="Your question">
        <button class="btn btn-primary" type="submit">${I('send')} Ask</button>
      </form>
    </section>`;
  }

  /* ================================================================= guide */
  function help(routes, groups) {
    const gloss = [
      ['Resignation risk (7 to 180 days)', 'The chance, from 0 to 100%, that a person decides to resign within that many days.'],
      ['Risk band', 'Critical, High, Medium or Low. Bands rank people against each other in the same run.'],
      ['Call list', 'Critical plus High: the top 15% by 90-day risk.'],
      ['Priority', 'Risk weighted by how hard the role is to replace. It sets the order of the watchlist.'],
      ['Change', 'How many percentage points the 30-day risk moved since the last scoring run.'],
      ['Anomaly score', 'How unusual someone\'s recent weeks look against their own history, from 0 to 100.'],
      ['Drivers', 'The factors that pushed a person\'s score up (ember) or down (blue).'],
      ['Lead time', 'How many weeks before a resignation the person was already on the call list.'],
      ['PR-AUC', 'A ranking score for rare events. Random ranking scores the base rate; higher is better.'],
      ['What-if', 'Moves a lever (overtime, pay, promotion...) for one person and shows how the model expects their risk to respond. An expectation, not a promise.'],
      ['Backtest', 'The whole method replayed at earlier dates, each checked on a later period it never saw.'],
      ['Drift', 'Whether today\'s data still looks like the data the model learned from.']
    ];
    return `
    <div class="stack">
      <section class="briefing">
        <p class="date">Guide</p>
        <h2>This tool helps you spot people likely to resign, understand why, and act before they decide.</h2>
        <div class="row"><button class="btn btn-primary" id="start-tour">${I('play')} Take the one-minute tour</button>
          <a class="btn" href="#/watchlist">${I('watchlist')} Go to the watchlist</a></div>
      </section>
      <div class="steps3">
        <div class="step3"><span class="n">Step 1</span><h3>Spot</h3><p>Open the watchlist. Start with the Critical band and work down.</p></div>
        <div class="step3"><span class="n">Step 2</span><h3>Understand and plan</h3><p>Click a person to see what is driving their score, then open What-if to test a change before you make it.</p></div>
        <div class="step3"><span class="n">Step 3</span><h3>Act and record</h3><p>Talk to them, then log the action. Record what happened later under Actions.</p></div>
      </div>
      <section class="panel">
        ${head('What each page is for')}
        <div class="pages">
          ${groups.map(g => g.items.map(p => { const r = routes.find(x => x.path === p); return r ? `
            <a class="page-card" href="#${r.path}"><span class="p-ic">${I(r.icon, 16)}</span>
              <div><b>${esc(r.label)}</b><p>${esc(r.help)}</p></div></a>` : ''; }).join('')).join('')}
        </div>
      </section>
      <div class="grid g-main">
        <section class="panel">${head('Words used here')}
          <dl class="gloss">${gloss.map(([t, dd]) => `<div><dt>${esc(t)}</dt><dd>${esc(dd)}</dd></div>`).join('')}</dl></section>
        <section class="panel">${head('Shortcuts')}
          <div class="keys">
            <div>Find a person or page <span><kbd>Ctrl</kbd> <kbd>K</kbd></span></div>
            <div>Quick search <kbd>/</kbd></div>
            <div>Open this guide <kbd>?</kbd></div>
            <div>Close a window or panel <kbd>Esc</kbd></div>
          </div></section>
      </div>
    </div>`;
  }

  return { overview, watchlist, drawer, employee, early, segments, anomalies, interventions, governance,
           copilot, help, notScored, sortRows };
})();
