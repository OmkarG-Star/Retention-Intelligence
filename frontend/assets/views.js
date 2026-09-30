/* Page renderers. Each returns HTML; App handles routing, fetching and events.
   Top-level blocks carry the "anim" class so they rise in one after another when
   a page opens. Every number that needs explaining gets an (i) tip. */

const Views = (() => {
  const esc = Chart.esc;
  const I = (n, s = 16) => Icons.get(n, s);
  const pct = (v, d = 1) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(d) + '%';
  const num = (v, d = 0) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString(undefined,
    { minimumFractionDigits: d, maximumFractionDigits: d });
  const bandMark = b => b ? `<span class="band b-${esc(b)}"><i class="dot"></i>${esc(b)}</span>` : '';
  const velocity = v => v == null || isNaN(v) ? '<span class="sub">first run</span>'
    : Math.abs(v) < 0.05 ? '<span class="sub">no change</span>'
    : `<span class="${v >= 0 ? 'delta-up' : 'delta-down'}">${I(v >= 0 ? 'trendUp' : 'trendDown', 13)}${v >= 0 ? '+' : ''}${v.toFixed(1)}</span>`;
  const tip = t => `<button type="button" class="tip" data-tip="${esc(t)}" aria-label="${esc(t)}">${I('info', 14)}</button>`;
  const note = (text, style = 'margin-top:14px') => `<div class="note" style="${style}">${I('info', 16)}<div>${text}</div></div>`;

  function head(icon, title, sub = '', right = '', help = '') {
    return `<header><div><h2><span class="h-ic">${I(icon)}</span>${title}${help ? tip(help) : ''}</h2>
      ${sub ? `<p>${sub}</p>` : ''}</div>${right}</header>`;
  }

  function kpi({ icon, tone, k, v, s = '', help = '', href = '' }) {
    return `<div class="kpi anim tone-${tone} ${href ? 'link' : ''}" ${href ? `data-href="${href}" role="link" tabindex="0"` : ''}>
      <div class="top"><span class="kic">${I(icon)}</span><span class="k">${k}</span>${help ? tip(help) : ''}</div>
      <div class="v" data-count>${v}</div><div class="s">${s}</div></div>`;
  }

  function riskCell(p, band) {
    const col = Chart.colors.risk[band] || Chart.colors.navy;
    const width = Math.min(Math.max((p || 0) * 260, 2), 100);
    return `<div class="bar-cell"><span style="min-width:44px">${pct(p)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${width}%;background:${col}"></span></span></div>`;
  }

  function emptyState(icon, title, text = '') {
    return `<div class="empty-state"><span class="h-ic">${I(icon, 22)}</span><b>${title}</b>${text ? `<p>${text}</p>` : ''}</div>`;
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  /* ------------------------------------------------------------ overview */
  function overview(d, user) {
    const k = d.kpis || {};
    if (k.status === 'not_scored') return notScored();
    const ladder = [['Critical', k.critical], ['High', k.high], ['Medium', k.medium], ['Low', k.low]];
    const trend = (d.trend || []).map(t => ({ y: t.mean_risk_30, label: t.as_of.slice(5) }));
    const actual = (d.trend || []).map(t => ({ y: t.actual_exits_14d, label: t.as_of.slice(5) }));
    const first = user && user.full_name ? user.full_name.split(' ')[0] : '';
    const kept = k.annualised_attrition == null ? null : 1 - k.annualised_attrition;

    return `
    <div class="stack">
      <section class="panel hero anim">
        <div>
          <p class="hello">${I('spark', 14)} ${greeting()}${first ? ', ' + esc(first) : ''}. Here is today in one line.</p>
          <h2><b>${num(k.critical)}</b> people are in the Critical band and <b>${num(k.accelerating)}</b> have risk
            rising fast. If nothing changes, expect about <b>${num(k.expected_exits_90d)}</b> exits in the next 90 days.</h2>
          <div class="row">
            <a class="btn btn-primary" href="#/watchlist" data-band-link="Critical">${I('watchlist')} See who to call first ${I('arrowRight', 15).replace('class="ic ', 'class="ic ic-go ')}</a>
            <a class="btn" href="#/anomalies">${I('trendUp')} Who is moving</a>
            <a class="btn" href="#/help">${I('book')} How to read this</a>
          </div>
        </div>
        <div class="hero-ring">
          ${Chart.ring(kept, { size: 118, stroke: 11, color: Chart.colors.amber, text: pct(kept, 0), label: 'Share of workforce kept over 12 months' })}
          <p>kept over 12 months</p>
        </div>
      </section>

      <div class="kpis">
        ${kpi({ icon: 'users', tone: 'crit', k: 'Expected exits, next 90 days', v: num(k.expected_exits_90d),
          s: 'sum of individual probabilities', href: '#/watchlist',
          help: 'Add up every person\'s 90-day leaving probability. This is how many exits the model expects if nothing changes.' })}
        ${kpi({ icon: 'trendUp', tone: 'high', k: 'Risk accelerating', v: num(k.accelerating),
          s: 'up more than 5 points since last run', href: '#/anomalies',
          help: 'People whose 30-day risk rose by more than 5 percentage points since the previous scoring run.' })}
        ${kpi({ icon: 'anomaly', tone: 'med', k: 'Behaviour anomalies', v: num(k.anomalies),
          s: 'abrupt change, independent of risk', href: '#/anomalies',
          help: 'A sudden change in overtime, absence or engagement. A separate model finds these, so it can catch patterns the risk model has never seen.' })}
        ${kpi({ icon: 'newjoiner', tone: 'teal', k: 'In first 30 days', v: num(k.in_first_30_days),
          s: `${pct(k.early_exit_share)} of exits happen in this window`, href: '#/early',
          help: 'New joiners still in their first month. This is the window where early exits cluster.' })}
        ${kpi({ icon: 'calendar', tone: 'navy', k: 'Attrition, last 12 months', v: pct(k.annualised_attrition, 1),
          s: `${num(k.exits_last_90d)} exits in the last quarter`, href: '#/segments',
          help: 'Exits in the last 12 months divided by average headcount.' })}
      </div>

      <section class="panel anim" id="ladder-panel">
        ${head('target', 'Where the workforce stands today',
          `${num(k.headcount)} active employees split into four risk groups. Click a colour to see those people.`,
          `<a class="btn btn-sm" href="#/watchlist">${I('watchlist')} Open watchlist</a>`,
          'Bands rank people against each other in this run. Critical is the top 5% of 90-day risk, High the next 10%, Medium the next 25%.')}
        <div class="ladder">
          ${ladder.map(([band, n]) => `
            <button data-band="${band}" style="flex:${Math.max(n, 1)} 1 0;background:${Chart.colors.risk[band]}"
              title="Show the ${n} people in the ${band} band">
              <span class="n">${num(n)}</span><span class="l">${band}</span>
            </button>`).join('')}
        </div>
        <div class="ladder-key">
          <span><i class="dot Critical"></i>Critical: talk this week</span>
          <span><i class="dot High"></i>High: talk this month</span>
          <span><i class="dot Medium"></i>Medium: keep an eye on</span>
          <span><i class="dot Low"></i>Low: no action needed</span>
        </div>
      </section>

      <div class="grid g-main">
        <section class="panel anim">
          ${head('flag', 'Retention priority queue', 'Risk weighted by how hard the role is to backfill. Click a row to open the person.',
            '', 'Priority = leaving risk × business criticality, so a hard-to-replace planner can outrank a slightly riskier helper.')}
          <div class="table-wrap">
            <table><thead><tr>
              <th>Employee</th><th>Role</th><th>Site</th><th class="num">30-day</th>
              <th class="num">90-day</th><th class="num">Change</th><th>Band</th>
            </tr></thead><tbody>
            ${(d.top_priority || []).map(r => `
              <tr class="clickable" data-emp="${esc(r.EmployeeID)}">
                <td><span class="id">${esc(r.EmployeeID)}</span><div class="sub">${num(r.TenureDays)} days · criticality ${r.BusinessCriticality}</div></td>
                <td>${esc(r.Position)}<div class="sub">${esc(r.Department)}</div></td>
                <td>${esc(r.Site)}</td>
                <td class="num">${pct(r.risk_30)}</td>
                <td class="num">${riskCell(r.risk_90, r.risk_band)}</td>
                <td class="num">${velocity(r.risk_velocity)}</td>
                <td>${bandMark(r.risk_band)}</td>
              </tr>`).join('') || `<tr><td colspan="7">${emptyState('users', 'Nothing scored yet')}</td></tr>`}
            </tbody></table>
          </div>
        </section>

        <div class="stack">
          <section class="panel anim">
            ${head('anomaly', 'Risk against reality', 'Average predicted risk per run, with the exits that followed', '',
              'If the amber line and the teal line move together, the model is tracking what really happens.')}
            ${Chart.line([{ points: trend, color: Chart.colors.amber, area: true }],
              { height: 150, fmt: v => (v * 100).toFixed(1) + '%' })}
            ${Chart.line([{ points: actual, color: Chart.colors.teal, dots: false }],
              { height: 110, fmt: v => Math.round(v) })}
            <div class="legend" style="margin-top:8px">
              <span><i class="dot" style="background:${Chart.colors.amber}"></i>average predicted risk</span>
              <span><i class="dot" style="background:${Chart.colors.teal}"></i>exits in the 14 days before each run</span>
            </div>
          </section>

          <section class="panel anim">
            ${head('trendUp', 'Moving fastest', 'Largest jump since the previous run',
              `<a class="btn btn-sm btn-ghost" href="#/anomalies">All ${I('arrowRight', 14)}</a>`)}
            <div class="table-wrap"><table><tbody>
            ${(d.movers || []).slice(0, 7).map(m => `
              <tr class="clickable" data-emp="${esc(m.EmployeeID)}">
                <td><span class="id">${esc(m.EmployeeID)}</span><div class="sub">${esc(m.Position)}, ${esc(m.Site)}</div></td>
                <td class="num">${pct(m.prev_risk_30)} → <b>${pct(m.risk_30)}</b></td>
                <td class="num">${velocity(m.risk_velocity)}</td>
              </tr>`).join('') || `<tr><td>${emptyState('clock', 'No earlier run to compare against')}</td></tr>`}
            </tbody></table></div>
          </section>
        </div>
      </div>

      <section class="panel anim">
        ${head('building', 'Risk by site', 'Average 90-day risk and exits in the last 12 months',
          `<a class="btn btn-sm" href="#/segments">${I('segments')} All segments</a>`)}
        ${Chart.bars((d.segments || []).map(s => ({
          label: `${s.segment} (${s.headcount})`, value: s.mean_risk_90,
          display: pct(s.mean_risk_90) + ` · ${s.exits_12m} exits`,
          color: s.mean_risk_90 > 0.08 ? Chart.colors.risk.High : Chart.colors.navy
        })), { width: 640, labelW: 220 })}
      </section>
    </div>`;
  }

  function notScored() {
    return `<div class="panel anim">${emptyState('refresh', 'No scoring run found',
      'Build the data and model first, then reload: <code>python -m attrition.cli pipeline</code>')}</div>`;
  }

  /* ----------------------------------------------------------- watchlist */
  function watchlist(rows, filters, state, k = {}) {
    const bands = [['', 'Everyone', k.headcount], ['Critical', 'Critical', k.critical], ['High', 'High', k.high],
                   ['Medium', 'Medium', k.medium], ['Low', 'Low', k.low]];
    const active = state.band || state.site || state.department || state.search;
    return `
    <div class="stack">
      <section class="panel anim">
        ${head('watchlist', 'Watchlist', `Showing <b>${rows.length}</b> ${rows.length === 1 ? 'person' : 'people'}, highest priority first. Click anyone to see why.`,
          `<a class="btn btn-sm" href="/api/export/watchlist.csv" title="Download the full ranked list">${I('download')} Export CSV</a>`)}
        <div class="chips" id="wl-bands">
          ${bands.map(([v, l, n]) => `<button class="fchip ${state.band === v ? 'on' : ''}" data-band-chip="${v}">
            ${v ? `<i class="dot ${v}"></i>` : I('users', 14)}${l}${n != null ? ` <b>${num(n)}</b>` : ''}</button>`).join('')}
        </div>
        <div class="toolbar">
          <label class="search">${I('search')}
            <input id="wl-search" placeholder="Search ID, role, department or site" value="${esc(state.search || '')}"
                   aria-label="Search the watchlist"></label>
          <select id="wl-site" aria-label="Filter by site">
            <option value="">All sites</option>
            ${(filters.sites || []).map(s => `<option ${state.site === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          <select id="wl-dept" aria-label="Filter by department">
            <option value="">All departments</option>
            ${(filters.departments || []).map(s => `<option ${state.department === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          ${active ? `<button class="btn btn-sm btn-ghost" id="wl-clear">${I('x', 14)} Clear filters</button>` : ''}
          <div class="spacer"></div>
          <span class="sub">Sort by</span>
          <div class="seg" id="wl-sort">
            ${[['priority_score', 'Priority'], ['risk_30', '30-day'], ['risk_90', '90-day'],
               ['risk_velocity', 'Movement'], ['anomaly_score', 'Anomaly']]
              .map(([v, l]) => `<button data-sort="${v}" class="${state.sort === v ? 'on' : ''}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="table-wrap">
          <table><thead><tr>
            <th>Employee</th><th>Role</th><th>Site</th><th>Type</th><th class="num">Tenure</th>
            <th class="num">7-day</th><th class="num">30-day</th><th class="num">90-day</th>
            <th class="num">Change</th><th class="num">Anomaly</th><th>Band</th><th>Priority</th>
          </tr></thead><tbody>
          ${rows.map(r => `
            <tr class="clickable" data-emp="${esc(r.EmployeeID)}">
              <td><span class="id">${esc(r.EmployeeID)}</span></td>
              <td>${esc(r.Position)}<div class="sub">${esc(r.Department)}</div></td>
              <td>${esc(r.Site)}</td>
              <td><span class="sub">${esc(r.EmploymentType)}</span></td>
              <td class="num">${num(r.TenureDays)}d</td>
              <td class="num">${pct(r.risk_7, 2)}</td>
              <td class="num">${pct(r.risk_30)}</td>
              <td class="num">${riskCell(r.risk_90, r.risk_band)}</td>
              <td class="num">${velocity(r.risk_velocity)}</td>
              <td class="num">${r.anomaly_flag ? `<span class="pill warn">${I('alert', 12)}${num(r.anomaly_score)}</span>` : num(r.anomaly_score)}</td>
              <td>${bandMark(r.risk_band)}</td>
              <td>${bandMark(r.priority_band)}</td>
            </tr>`).join('') || `<tr><td colspan="12">${emptyState('search', 'No one matches these filters',
              'Try another band or clear the filters.')}</td></tr>`}
          </tbody></table>
        </div>
      </section>
    </div>`;
  }

  /* ------------------------------------------------------------ employee */
  function employee(d, canAct) {
    const p = d.profile || {};
    const back = `<button class="btn btn-sm btn-ghost back" id="go-back">${I('arrowLeft', 15)} Back</button>`;
    if (!d.scored) {
      return `${back}<div class="panel anim"><h2>${esc(p.EmployeeID)}</h2>
        <p class="sub" style="margin-top:6px">${esc(p.Position)} · ${esc(p.Department)} · ${esc(p.Site)}</p>
        ${d.exit ? note(`Left on ${esc(d.exit.ExitDate)}: ${esc(d.exit.ExitType)}, ${esc(d.exit.ExitReason)}, after ${num(d.exit.TenureDaysAtExit)} days.`) : ''}
        <div style="margin-top:16px">${timeline(d.timeline)}</div></div>`;
    }
    const hist = (d.history || []).map(h => ({ y: h.risk_30, label: (h.as_of || '').slice(5) }));
    const beh = d.behaviour || [];
    const col = Chart.colors.risk[p.risk_band] || Chart.colors.amber;

    return `
    ${back}
    <div class="stack">
      <section class="panel anim">
        <div class="emp-head">
          ${Chart.ring(p.risk_90, { size: 92, stroke: 9, color: col, text: pct(p.risk_90, 0), label: '90-day leaving risk' })}
          <div>
            <p class="sub">90-day leaving risk · ${esc(p.EmployeeID)}</p>
            <h1>${esc(p.Position)}</h1>
            <div class="meta-line">
              <span>${I('building', 14)}${esc(p.Department)}</span>
              <span>${I('flag', 14)}${esc(p.Site)}</span>
              <span>${I('users', 14)}${esc(p.EmploymentType)}</span>
              <span>${I('compass', 14)}hired via ${esc(p.RecruitmentSource)}</span>
              <span>${I('clock', 14)}${num(p.TenureDays)} days on rolls</span>
            </div>
          </div>
          <div class="row">
            ${bandMark(p.risk_band)}
            ${canAct ? `<button class="btn btn-primary" id="log-action">${I('plus')} Log retention action</button>` : ''}
          </div>
        </div>
      </section>

      <div class="kpis">
        ${kpi({ icon: 'bolt', tone: 'high', k: '7-day risk', v: pct(p.risk_7, 2), s: 'chance of leaving this week',
          help: 'Probability this person leaves within the next 7 days.' })}
        ${kpi({ icon: 'calendar', tone: 'crit', k: '30-day risk', v: pct(p.risk_30),
          s: d.peer_median_risk_90 != null ? `department median 90-day ${pct(d.peer_median_risk_90)}` : '',
          help: 'Probability this person leaves within the next 30 days. The main number for planning a conversation.' })}
        ${kpi({ icon: 'trendUp', tone: 'med', k: 'Change since last run', v: p.risk_velocity == null ? '—' : (p.risk_velocity >= 0 ? '+' : '') + p.risk_velocity.toFixed(1),
          s: 'percentage points', help: 'How much the 30-day risk moved since the previous scoring run. Fast risers deserve attention even if the level is moderate.' })}
        ${kpi({ icon: 'anomaly', tone: 'teal', k: 'Anomaly score', v: num(p.anomaly_score),
          s: p.anomaly_flag ? 'abrupt change detected' : 'behaviour within range',
          help: '0 to 100. Above the threshold means this person\'s recent weeks look unlike their own history.' })}
        ${kpi({ icon: 'shield', tone: 'navy', k: 'Criticality', v: `${p.BusinessCriticality}/5`, s: 'how hard to backfill',
          help: 'How difficult and slow this role is to replace, from 1 (easy) to 5 (very hard).' })}
      </div>

      <div class="grid g-main">
        <section class="panel anim">
          ${head('target', 'What is driving this score', 'Red bars push risk up, green bars pull it down', '',
            'SHAP attributions: how much each factor moved this person\'s 30-day probability compared with an average employee.')}
          ${Chart.contributions(d.drivers || [])}
          ${note('These show what moved the score, not proven causes. Use them to open a conversation, not to settle one.')}
        </section>

        <div class="stack">
          <section class="panel anim">
            ${head('clock', 'Probability of staying', 'Survival curve from this week onward', '',
              'Read it like: "the chance this person is still here after N days". Steeper drops mean higher risk sooner.')}
            ${Chart.survival(d.survival_curve || [], { width: 440 })}
            ${p.expected_days_to_exit ? `<p class="sub" style="margin-top:8px">Expected time on rolls over the
              modelled window: about ${num(p.expected_days_to_exit)} days.</p>` : ''}
          </section>
          <section class="panel anim">
            ${head('trendUp', 'Risk history', 'Every scoring run for this person')}
            ${Chart.line([{ points: hist, color: Chart.colors.amber, area: true }],
              { width: 420, height: 150, fmt: v => (v * 100).toFixed(1) + '%' })}
          </section>
        </div>
      </div>

      <div class="grid g-main">
        <section class="panel anim">
          ${head('anomaly', 'Behaviour, last 26 weeks', 'The weekly signals the model learns from')}
          ${Chart.line([
            { points: beh.map(b => ({ y: b.OvertimeHours7D, label: (b.SnapshotDate || '').slice(5, 10) })), color: Chart.colors.risk.High, dots: false },
            { points: beh.map(b => ({ y: b.EngagementScore, label: '' })), color: Chart.colors.risk.Low, dots: false },
            { points: beh.map(b => ({ y: b.AbsenceDays7D, label: '' })), color: Chart.colors.teal, dots: false }
          ], { width: 680, height: 200 })}
          <div class="legend" style="margin-top:8px">
            <span><i class="dot" style="background:${Chart.colors.risk.High}"></i>overtime hours per week</span>
            <span><i class="dot" style="background:${Chart.colors.risk.Low}"></i>engagement pulse (1-10)</span>
            <span><i class="dot" style="background:${Chart.colors.teal}"></i>absence days per week</span>
          </div>
        </section>

        <div class="stack">
          <section class="panel anim">
            ${head('spark', 'Suggested next steps', 'Based on the top drivers above')}
            ${(d.actions || []).map(a => `<div class="driver">
              <span class="d-ic">${I('check')}</span>
              <div><div class="name">${esc(a.action)}</div><div class="val">because: ${esc(a.because)}</div></div>
              <span class="pill">${esc(a.category)}</span></div>`).join('') ||
              emptyState('check', 'No elevated drivers')}
          </section>
          <section class="panel anim">
            ${head('actions', 'Actions logged')}
            ${(d.interventions || []).map(i => `<div class="driver">
              <span class="d-ic">${I('note')}</span>
              <div><div class="name">${esc(i.action)}</div>
                <div class="val">${esc((i.created_at || '').slice(0, 10))} · ${esc(i.owner || i.created_by || '')}
                ${i.notes ? '· ' + esc(i.notes) : ''}</div></div>
              <span class="pill ${i.status === 'Closed' ? 'good' : 'warn'}">${esc(i.outcome || i.status)}</span>
            </div>`).join('') || emptyState('note', 'No actions logged yet',
              canAct ? 'Use "Log retention action" at the top once you have spoken to them.' : '')}
          </section>
        </div>
      </div>

      <section class="panel anim">
        ${head('calendar', 'Record timeline', 'Joining, moves, leave and other events')}
        ${timeline(d.timeline)}
      </section>
    </div>`;
  }

  function timeline(items) {
    if (!items || !items.length) return emptyState('calendar', 'No events recorded');
    const mark = new Set(['Exit', 'Resignation Submitted', 'Grievance', 'Manager Change', 'Promotion']);
    return `<ul class="timeline">${items.slice(0, 18).map((e, i) => `
      <li class="${mark.has(e.EventType) ? 'mark' : ''}" style="--d:${i}">
        <div class="when">${esc((e.EventDate || '').slice(0, 10))}</div>
        <div class="what"><b>${esc(e.EventType)}</b> <span class="sub">${esc(e.EventDetail)}</span></div>
      </li>`).join('')}</ul>`;
  }

  /* ------------------------------------------------------ early attrition */
  function early(d) {
    const bands = (d.bands || []).slice(0, 6);
    return `
    <div class="stack">
      <div class="kpis kpis-3">
        ${kpi({ icon: 'newjoiner', tone: 'crit', k: 'Exits within 30 days', v: pct(d.early_share),
          s: `of all ${num(d.total_exits)} exits`, help: 'Share of all exits that happened in the first month after joining.' })}
        ${kpi({ icon: 'users', tone: 'teal', k: 'New joiners on rolls', v: num((d.new_joiners || []).length),
          s: 'under 90 days, scored today' })}
        ${kpi({ icon: 'compass', tone: 'navy', k: 'Hiring channels compared', v: num((d.by_source || []).length),
          s: 'see channel quality below' })}
      </div>
      <section class="panel anim">
        ${head('newjoiner', 'When new hires leave', 'Exits by how long they had been with us', '',
          'Red shows people who left without notice (absconding), usually in the first weeks.')}
        ${Chart.columns(bands.map(b => ({ label: b.band, value: b.exits, sub: b.absconding })),
          { width: 680, height: 220 })}
        <div class="legend" style="margin-top:6px">
          <span><i class="dot" style="background:${Chart.colors.navy}"></i>exits</span>
          <span><i class="dot" style="background:${Chart.colors.risk.Critical}"></i>left without notice</span>
        </div>
      </section>

      <div class="grid g-2">
        <section class="panel anim">
          ${head('compass', 'Channel quality', 'Share of each channel\'s hires who left within 30 days')}
          <div class="table-wrap"><table><thead><tr>
            <th>Channel</th><th class="num">Hired</th><th class="num">Left ≤30d</th>
            <th class="num">Early exit rate</th><th class="num">Median tenure at exit</th>
          </tr></thead><tbody>
          ${(d.by_source || []).map(s => `<tr>
            <td>${esc(s.source)}</td>
            <td class="num">${num(s.hired)}</td>
            <td class="num">${num(s.early_exits_30d)}</td>
            <td class="num">${riskCell(s.early_exit_rate, s.early_exit_rate > 0.12 ? 'Critical' : s.early_exit_rate > 0.06 ? 'High' : 'Low')}</td>
            <td class="num">${s.median_tenure_at_exit ? num(s.median_tenure_at_exit) + 'd' : '—'}</td>
          </tr>`).join('')}
          </tbody></table></div>
          ${note('The cheapest hiring channel is not the cheapest if a fifth of its hires leave inside a month.', 'margin-top:12px')}
        </section>

        <section class="panel anim">
          ${head('alert', 'New joiners at risk now', 'On rolls under 90 days, highest 30-day risk first')}
          <div class="table-wrap"><table><thead><tr>
            <th>Employee</th><th>Role</th><th class="num">Day</th>
            <th class="num">Onboarding</th><th class="num">30-day risk</th><th>Band</th>
          </tr></thead><tbody>
          ${(d.new_joiners || []).slice(0, 14).map(r => `
            <tr class="clickable" data-emp="${esc(r.EmployeeID)}">
              <td><span class="id">${esc(r.EmployeeID)}</span><div class="sub">${esc(r.RecruitmentSource)}</div></td>
              <td>${esc(r.Position)}<div class="sub">${esc(r.Site)}</div></td>
              <td class="num">${num(r.TenureDays)}</td>
              <td class="num">${r.OnboardingCompletionPct != null ?
                `<span class="${r.OnboardingCompletionPct < 70 ? 'delta-up' : ''}">${num(r.OnboardingCompletionPct)}%</span>` : '—'}</td>
              <td class="num">${pct(r.risk_30)}</td>
              <td>${bandMark(r.risk_band)}</td>
            </tr>`).join('') || `<tr><td colspan="6">${emptyState('newjoiner', 'No new joiners on rolls')}</td></tr>`}
          </tbody></table></div>
        </section>
      </div>

      <section class="panel anim">
        ${head('note', 'Reasons given for early exits', 'From exit records of people who left within 30 days')}
        ${Chart.bars((d.early_reasons || []).map(r => ({
          label: r.reason, value: r.count, color: Chart.colors.amber })), { width: 620, labelW: 200 })}
      </section>
    </div>`;
  }

  /* ------------------------------------------------------------ segments */
  function segments(rows, by) {
    const options = [['Site', 'Site'], ['Department', 'Department'], ['EmploymentType', 'Employment type'],
                     ['RecruitmentSource', 'Hiring channel'], ['Position', 'Role'], ['tenure_band', 'Tenure']];
    const label = (options.find(o => o[0] === by) || [by, by])[1];
    const top = rows.slice().sort((a, b) => b.mean_risk_90 - a.mean_risk_90).slice(0, 10);
    return `
    <div class="stack">
      <section class="panel anim">
        ${head('segments', 'Compare groups', 'Pick how to slice the workforce',
          `<div class="seg" id="seg-switch">${options.map(([v, l]) =>
            `<button data-by="${v}" class="${by === v ? 'on' : ''}">${l}</button>`).join('')}</div>`)}
        ${Chart.bars(top.map(s => ({
          label: `${s.segment}`.length > 30 ? `${s.segment}`.slice(0, 29) + '…' : `${s.segment}`, value: s.mean_risk_90,
          display: pct(s.mean_risk_90) + ` · ${num(s.headcount)} people`,
          color: s.mean_risk_90 > 0.09 ? Chart.colors.risk.Critical : s.mean_risk_90 > 0.06 ? Chart.colors.risk.High : Chart.colors.navy
        })), { width: 680, labelW: 230 })}
      </section>
      <section class="panel anim">
        ${head('overview', `Every ${label.toLowerCase()} in detail`, 'Forward-looking risk beside what actually happened', '',
          'Expected exits = sum of 90-day probabilities in the group. Early exits = people who left within 30 days of joining.')}
        <div class="table-wrap"><table><thead><tr>
          <th>${esc(label)}</th><th class="num">Headcount</th><th class="num">Avg 90-day risk</th>
          <th class="num">Critical</th><th class="num">Accelerating</th>
          <th class="num">Expected exits 90d</th><th class="num">Exits 12m</th>
          <th class="num">Early exits</th><th class="num">Attrition 12m</th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr>
          <td>${esc(r.segment)}</td>
          <td class="num">${num(r.headcount)}</td>
          <td class="num">${riskCell(r.mean_risk_90, r.mean_risk_90 > 0.09 ? 'Critical' : r.mean_risk_90 > 0.06 ? 'High' : 'Low')}</td>
          <td class="num">${num(r.critical)}</td>
          <td class="num">${num(r.accelerating)}</td>
          <td class="num">${num(r.expected_exits_90d, 1)}</td>
          <td class="num">${num(r.exits_12m)}</td>
          <td class="num">${num(r.early_exits_12m)}</td>
          <td class="num">${pct(r.attrition_12m)}</td>
        </tr>`).join('') || `<tr><td colspan="9">${emptyState('segments', 'No segments')}</td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
  }

  /* ----------------------------------------------------------- anomalies */
  function anomalies(d) {
    return `
    <div class="grid g-2">
      <section class="panel anim">
        ${head('anomaly', 'Sudden behaviour changes', 'Found by a separate model watching week-to-week change', '',
          'Isolation Forest over week-on-week deltas in overtime, absence, engagement and more. Independent of the risk model.')}
        <div class="table-wrap"><table><thead><tr>
          <th>Employee</th><th>Role</th><th class="num">Anomaly</th><th class="num">30-day risk</th><th>Band</th>
        </tr></thead><tbody>
        ${(d.items || []).map(r => `<tr class="clickable" data-emp="${esc(r.EmployeeID)}">
          <td><span class="id">${esc(r.EmployeeID)}</span><div class="sub">${num(r.TenureDays)} days</div></td>
          <td>${esc(r.Position)}<div class="sub">${esc(r.Site)}</div></td>
          <td class="num"><span class="pill warn">${I('alert', 12)}${num(r.anomaly_score)}</span></td>
          <td class="num">${pct(r.risk_30)}</td>
          <td>${bandMark(r.risk_band)}</td>
        </tr>`).join('') || `<tr><td colspan="5">${emptyState('check', 'Nothing unusual this run')}</td></tr>`}
        </tbody></table></div>
        ${note('A high anomaly score with low risk is still worth a call: the risk model only knows patterns that led to exits before, so a new pattern shows up here first.', 'margin-top:12px')}
      </section>

      <section class="panel anim">
        ${head('trendUp', 'Risk rising fastest', 'Biggest movers since the previous run')}
        <div class="table-wrap"><table><thead><tr>
          <th>Employee</th><th>Role</th><th class="num">Previous</th><th class="num">Now</th><th class="num">Change</th>
        </tr></thead><tbody>
        ${(d.movers || []).map(r => `<tr class="clickable" data-emp="${esc(r.EmployeeID)}">
          <td><span class="id">${esc(r.EmployeeID)}</span></td>
          <td>${esc(r.Position)}<div class="sub">${esc(r.Site)}</div></td>
          <td class="num">${pct(r.prev_risk_30)}</td>
          <td class="num">${pct(r.risk_30)}</td>
          <td class="num">${velocity(r.risk_velocity)}</td>
        </tr>`).join('') || `<tr><td colspan="5">${emptyState('clock', 'Needs at least two scoring runs')}</td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
  }

  /* ------------------------------------------------------- interventions */
  function interventions(d, canAct) {
    const e = d.effectiveness || {};
    const retained = (e.summary || []).reduce((a, r) => a + r.retained, 0);
    return `
    <div class="stack">
      <div class="kpis kpis-3">
        ${kpi({ icon: 'actions', tone: 'navy', k: 'Actions logged', v: num(e.total), s: 'all time' })}
        ${kpi({ icon: 'clock', tone: 'med', k: 'Still open', v: num(e.open), s: canAct ? 'close them below when you know the outcome' : 'waiting for an outcome' })}
        ${kpi({ icon: 'check', tone: 'low', k: 'Closed as retained', v: num(retained), s: 'person stayed after the action' })}
      </div>

      <section class="panel anim">
        ${head('target', 'What has worked', 'Outcomes grouped by action type', '',
          'Mean risk change = average movement in 30-day risk between logging the action and closing it. Negative is good.')}
        <div class="table-wrap"><table><thead><tr>
          <th>Action</th><th class="num">Closed</th><th class="num">Retained</th>
          <th class="num">Exited</th><th class="num">Avg risk change</th>
        </tr></thead><tbody>
        ${(e.summary || []).map(r => `<tr>
          <td>${esc(r.action)}</td><td class="num">${num(r.closed)}</td>
          <td class="num">${num(r.retained)}</td><td class="num">${num(r.exited)}</td>
          <td class="num">${r.mean_risk_change_pts == null ? '—' :
            `<span class="${r.mean_risk_change_pts > 0 ? 'delta-up' : 'delta-down'}">${r.mean_risk_change_pts > 0 ? '+' : ''}${r.mean_risk_change_pts}</span>`}</td>
        </tr>`).join('') || `<tr><td colspan="5">${emptyState('target', 'No closed actions yet')}</td></tr>`}
        </tbody></table></div>
        ${e.note ? note(esc(e.note), 'margin-top:12px') : ''}
      </section>

      <section class="panel anim">
        ${head('note', 'Action log', canAct ? 'Every conversation and follow-up. Close an action once you know the outcome.' : 'Every conversation and follow-up')}
        <div class="table-wrap"><table><thead><tr>
          <th>Employee</th><th>Action</th><th>Owner</th><th>Raised</th>
          <th class="num">Risk then</th><th>Status</th>${canAct ? '<th></th>' : ''}
        </tr></thead><tbody>
        ${(d.items || []).map(i => `<tr>
          <td><span class="id clickable" data-emp="${esc(i.EmployeeID)}">${esc(i.EmployeeID)}</span></td>
          <td>${esc(i.action)}<div class="sub">${esc(i.notes || '')}</div></td>
          <td>${esc(i.owner || i.created_by || '')}</td>
          <td>${esc((i.created_at || '').slice(0, 10))}</td>
          <td class="num">${pct(i.risk_at_creation)}</td>
          <td><span class="pill ${i.status === 'Closed' ? 'good' : 'warn'}">${esc(i.outcome || i.status)}</span></td>
          ${canAct ? `<td>${i.status === 'Open' ?
            `<button class="btn btn-sm close-int" data-id="${i.id}" data-emp-id="${esc(i.EmployeeID)}">${I('check', 14)} Record outcome</button>` : ''}</td>` : ''}
        </tr>`).join('') || `<tr><td colspan="7">${emptyState('actions', 'Nothing logged yet',
          'Open anyone on the watchlist and press "Log retention action".')}</td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
  }

  /* ---------------------------------------------------------- governance */
  function governance(d) {
    if (d.status === 'no_model') return notScored();
    const c = d.current || {};
    const metrics = c.metrics || {};
    const horizons = Object.keys(metrics).sort((a, b) => a - b);
    const drift = c.drift || [];
    const fair = (metrics['30'] || {}).fairness || [];
    const calib = (metrics['30'] || {}).calibration || [];
    const m30 = metrics['30'] || {};

    return `
    <div class="stack">
      <div class="kpis kpis-4">
        ${kpi({ icon: 'shield', tone: 'navy', k: 'Live model', v: `<span style="font-size:18px">${esc(c.version)}</span>`,
          s: esc(c.algorithm) })}
        ${kpi({ icon: 'target', tone: 'low', k: 'Lift in top 10%', v: m30.lift_at_10 != null ? num(m30.lift_at_10, 1) + '×' : '—',
          s: '30-day model, held-out data', help: 'How many times more real leavers are in the model\'s top 10% than in a random 10%. Higher is better.' })}
        ${kpi({ icon: 'calendar', tone: 'teal', k: 'Trained', v: `<span style="font-size:18px">${esc((c.trained_at || '').slice(0, 10))}</span>`,
          s: `${num(c.training_seconds, 1)}s on ${num((c.rows || {}).train)} rows` })}
        ${kpi({ icon: 'alert', tone: 'high', k: 'Drifted features', v: num(drift.filter(x => x.psi > 0.25).length),
          s: `of ${num(c.n_features)} features`, help: 'Features whose recent distribution moved far from training (PSI above 0.25). Several drifted features means it is time to retrain.' })}
      </div>

      <section class="panel anim">
        ${head('target', 'How accurate is it?', 'Measured on a later time window the model never saw in training', '',
          'PR-AUC suits rare events like exits. Brier measures how close the probabilities are to reality (lower is better). Recall @10% = share of real leavers caught in the top 10%.')}
        <div class="table-wrap"><table><thead><tr>
          <th>Horizon</th><th class="num">Events</th><th class="num">Base rate</th>
          <th class="num">PR-AUC</th><th class="num">ROC-AUC</th><th class="num">Brier</th>
          <th class="num">Recall @ top 10%</th><th class="num">Lift @ top 10%</th><th>Split</th>
        </tr></thead><tbody>
        ${horizons.map(h => { const m = metrics[h]; return `<tr>
          <td><b>${h} days</b></td>
          <td class="num">${num(m.positives)}</td>
          <td class="num">${pct(m.base_rate, 2)}</td>
          <td class="num"><b>${num(m.pr_auc, 3)}</b></td>
          <td class="num">${num(m.roc_auc, 3)}</td>
          <td class="num">${num(m.brier, 4)}</td>
          <td class="num">${pct(m.recall_at_10)}</td>
          <td class="num">${num(m.lift_at_10, 1)}×</td>
          <td><span class="sub">${esc(m.evaluated_on)}</span></td>
        </tr>`; }).join('')}
        </tbody></table></div>
        ${note('PR-AUC leads because exits are rare, and ROC-AUC flatters rare-event models. Lift is the number that matters day to day: how much denser the top 10% is with real leavers than a random list of the same length.', 'margin-top:12px')}
      </section>

      <div class="grid g-main">
        <section class="panel anim">
          ${head('alert', 'Has the data changed?', 'Feature drift between training and recent weeks', '',
            'Population Stability Index. Below 0.10 is stable, 0.10 to 0.25 is worth watching, above 0.25 means retrain.')}
          ${Chart.bars(drift.slice(0, 12).map(x => ({
            label: x.feature.length > 30 ? x.feature.slice(0, 29) + '…' : x.feature,
            value: x.psi, display: x.psi.toFixed(3),
            color: x.psi > 0.25 ? Chart.colors.risk.Critical : x.psi > 0.1 ? Chart.colors.risk.Medium : Chart.colors.risk.Low
          })), { width: 620, labelW: 230 })}
          <div class="legend" style="margin-top:8px">
            <span><i class="dot Low"></i>stable</span><span><i class="dot Medium"></i>watch (0.10+)</span>
            <span><i class="dot Critical"></i>retrain (0.25+)</span>
          </div>
        </section>
        <section class="panel anim">
          ${head('check', 'Are the percentages honest?', 'Predicted against observed, 30-day model', '',
            'Each dot is a tenth of employees. Dots on the dashed line mean "a 10% prediction really does leave about 10% of the time".')}
          ${Chart.calibration(calib, { width: 330, height: 290 })}
        </section>
      </div>

      <section class="panel anim">
        ${head('users', 'Is it fair across groups?', 'Flag rate and accuracy by site, department, contract type and channel')}
        <div class="table-wrap"><table><thead><tr>
          <th>Attribute</th><th>Group</th><th class="num">n</th><th class="num">Observed exit rate</th>
          <th class="num">Mean score</th><th class="num">PR-AUC</th><th class="num">Selection ratio</th>
        </tr></thead><tbody>
        ${fair.slice(0, 22).map(f => `<tr>
          <td><span class="sub">${esc(f.attribute)}</span></td>
          <td>${esc(f.group)}</td><td class="num">${num(f.n)}</td>
          <td class="num">${pct(f.base_rate, 2)}</td>
          <td class="num">${pct(f.mean_score, 2)}</td>
          <td class="num">${num(f.pr_auc, 3)}</td>
          <td class="num">${f.selection_ratio == null ? '—' : num(f.selection_ratio, 2)}</td>
        </tr>`).join('') || `<tr><td colspan="7">${emptyState('users', 'No group met the minimum sample size')}</td></tr>`}
        </tbody></table></div>
        ${note('A group flagged more often than others is not automatically unfair, because site conditions genuinely differ. It should always be explained before scores drive decisions about people.', 'margin-top:12px')}
      </section>

      <div class="grid g-2">
        <section class="panel anim">
          ${head('shield', 'Version history')}
          <div class="table-wrap"><table><thead><tr>
            <th>Version</th><th>Trained</th><th class="num">Features</th>
            <th class="num">Train rows</th><th>Data fingerprint</th><th></th>
          </tr></thead><tbody>
          ${(d.versions || []).map(v => `<tr>
            <td><span class="id">${esc(v.version)}</span></td>
            <td>${esc((v.trained_at || '').slice(0, 16).replace('T', ' '))}</td>
            <td class="num">${num(v.n_features)}</td>
            <td class="num">${num((v.rows || {}).train)}</td>
            <td><span class="id">${esc(v.data_fingerprint)}</span></td>
            <td>${v.is_current ? `<span class="pill good">${I('check', 12)}live</span>` : ''}</td>
          </tr>`).join('')}
          </tbody></table></div>
        </section>

        <section class="panel anim">
          ${head('refresh', 'Scoring runs')}
          <div class="table-wrap"><table><thead><tr>
            <th>As of</th><th class="num">Scored</th><th class="num">Avg 30-day risk</th>
            <th class="num">Critical</th><th>Model</th>
          </tr></thead><tbody>
          ${(d.runs || []).map(r => `<tr>
            <td>${esc(r.as_of)}</td><td class="num">${num(r.n_scored)}</td>
            <td class="num">${pct(r.mean_risk_30, 2)}</td><td class="num">${num(r.n_critical)}</td>
            <td><span class="id">${esc(r.model_version)}</span></td>
          </tr>`).join('')}
          </tbody></table></div>
        </section>
      </div>
    </div>`;
  }

  /* -------------------------------------------------------------- copilot */
  function copilot() {
    const prompts = [
      'Who should I call today?',
      'Which recruitment channel has the worst early attrition?',
      'Why is risk rising at Port Terminal Project?',
      'Which site needs attention this month?',
      'How accurate is the model?',
      'What are the most common risk drivers right now?'
    ];
    return `
    <section class="panel anim">
      ${head('chat', 'Ask about the workforce', 'Every answer is built from live queries on the current scoring run, so it cannot invent a number')}
      <div class="chat" id="chat">
        <div class="msg bot"><span class="who">${I('spark')}</span><div class="body"><pre>Hi! Ask me about risk, sites, hiring channels, new joiners, a specific employee ID, or the model itself.
Not sure where to start? Tap one of the suggestions below.</pre></div></div>
      </div>
      <div class="suggests">${prompts.map(p => `<button data-q="${esc(p)}">${I('spark', 13)}${esc(p)}</button>`).join('')}</div>
      <form class="ask" id="ask-form">
        <input id="ask-input" placeholder="Type a question, e.g. Who joined last month and is at risk?" autocomplete="off" aria-label="Your question">
        <button class="btn btn-primary" type="submit">${I('send')} Ask</button>
      </form>
    </section>`;
  }

  /* ---------------------------------------------------------------- guide */
  function help(routes, groups) {
    const gloss = [
      ['Leaving risk (7, 30, 90-day)', 'The chance, from 0 to 100%, that a person leaves within that many days.'],
      ['Risk band', 'Critical, High, Medium or Low. Bands rank people against each other in the same run.'],
      ['Priority', 'Risk weighted by how hard the role is to replace. Decides the order of the watchlist.'],
      ['Change / velocity', 'How many percentage points the 30-day risk moved since the last scoring run.'],
      ['Anomaly score', 'How unusual someone\'s recent weeks look compared with their own history (0 to 100).'],
      ['Drivers', 'The factors that pushed a person\'s score up (red) or down (green).'],
      ['Survival curve', 'The chance someone is still employed after a given number of days.'],
      ['Scoring run', 'One pass of the model over everyone. Numbers on every page come from the latest run.'],
      ['PR-AUC and lift', 'Accuracy measures for rare events. Lift 4× means the top 10% holds 4× more leavers than chance.'],
      ['Drift (PSI)', 'Whether today\'s data still looks like the data the model learned from.']
    ];
    return `
    <div class="stack">
      <section class="panel hero anim">
        <div>
          <p class="hello">${I('book', 14)} Guide</p>
          <h2>This tool helps you <b>spot</b> people likely to leave, <b>understand</b> why, and <b>act</b> before they go.</h2>
          <div class="row">
            <button class="btn btn-primary" id="start-tour">${I('play')} Take the 1-minute tour</button>
            <a class="btn" href="#/watchlist">${I('watchlist')} Go to the watchlist</a>
          </div>
        </div>
      </section>

      <section class="panel anim">
        ${head('compass', 'A simple routine', 'Three steps, about ten minutes a week')}
        <div class="steps3">
          <div class="step3"><span class="num">1</span><span class="h-ic">${I('watchlist', 18)}</span>
            <h3>Spot</h3><p>Open the <b>Watchlist</b>. Start with the Critical band, top to bottom.</p></div>
          <div class="step3"><span class="num">2</span><span class="h-ic">${I('target', 18)}</span>
            <h3>Understand</h3><p>Click a person. Read the red drivers and the suggested next steps.</p></div>
          <div class="step3"><span class="num">3</span><span class="h-ic">${I('actions', 18)}</span>
            <h3>Act and record</h3><p>Talk to them, then press <b>Log retention action</b>. Record the outcome later under <b>Actions</b>.</p></div>
        </div>
      </section>

      <section class="panel anim">
        ${head('overview', 'What each page is for')}
        <div class="pages">
          ${groups.map(g => g.items.map(p => { const r = routes.find(x => x.path === p); return r ? `
            <a class="page-card" href="#${r.path}"><span class="h-ic">${I(r.icon, 18)}</span>
              <div><span class="grp">${esc(g.name)}</span><b>${esc(r.label)}</b><p>${esc(r.help)}</p></div></a>` : ''; }).join('')).join('')}
        </div>
      </section>

      <div class="grid g-main">
        <section class="panel anim">
          ${head('note', 'Words used here')}
          <dl class="gloss">${gloss.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl>
        </section>
        <section class="panel anim">
          ${head('keyboard', 'Shortcuts')}
          <div class="keys">
            <div>Find employee or page <span><kbd>Ctrl</kbd> <kbd>K</kbd></span></div>
            <div>Quick search <kbd>/</kbd></div>
            <div>Open this guide <kbd>?</kbd></div>
            <div>Close any window <kbd>Esc</kbd></div>
          </div>
          ${note('Hover or tap any <b>(i)</b> icon on a page to see what that number means.')}
        </section>
      </div>
    </div>`;
  }

  return { overview, watchlist, employee, early, segments, anomalies, interventions, governance, copilot, help, notScored };
})();
