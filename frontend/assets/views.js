/* Page renderers. Each returns HTML; App handles routing, fetching and events. */

const Views = (() => {
  const esc = Chart.esc;
  const pct = (v, d = 1) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(d) + '%';
  const num = (v, d = 0) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString(undefined,
    { minimumFractionDigits: d, maximumFractionDigits: d });
  const bandMark = b => `<span class="band b-${esc(b)}"><i class="dot"></i>${esc(b)}</span>`;
  const velocity = v => v == null || isNaN(v) ? '<span class="sub">first run</span>'
    : `<span class="${v >= 0 ? 'delta-up' : 'delta-down'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}</span>`;

  function riskCell(p, band) {
    const col = Chart.colors.risk[band] || Chart.colors.navy;
    const width = Math.min(Math.max((p || 0) * 260, 2), 100);
    return `<div class="bar-cell"><span style="min-width:44px">${pct(p)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${width}%;background:${col}"></span></span></div>`;
  }

  /* ------------------------------------------------------------ overview */
  function overview(d) {
    const k = d.kpis || {};
    if (k.status === 'not_scored') return notScored();
    const ladder = [['Critical', k.critical], ['High', k.high],
                    ['Medium', k.medium], ['Low', k.low]];
    const trend = (d.trend || []).map(t => ({ y: t.mean_risk_30, label: t.as_of.slice(5) }));
    const actual = (d.trend || []).map(t => ({ y: t.actual_exits_14d, label: t.as_of.slice(5) }));

    return `
    <div class="stack">
      <section class="panel">
        <header>
          <div><h2>Where the workforce stands today</h2>
            <p>${num(k.headcount)} active employees, ranked against each other in this scoring run</p></div>
          <a class="btn btn-sm" href="#/watchlist">Open watchlist</a>
        </header>
        <div class="ladder">
          ${ladder.map(([band, n]) => `
            <button data-band="${band}" style="flex:${Math.max(n, 1)} 1 0;background:${Chart.colors.risk[band]}"
              title="${n} employees in the ${band} band">
              <span class="n">${num(n)}</span><span class="l">${band}</span>
            </button>`).join('')}
        </div>
        <p class="sub" style="margin-top:10px">Bands are relative standing within this run. A "Critical" employee
          sits in the top 5% of 90-day risk — the calibrated probability is shown next to every name.</p>
      </section>

      <div class="strip">
        <div><div class="k">Expected exits, next 90 days</div><div class="v">${num(k.expected_exits_90d)}</div>
          <div class="s">sum of individual probabilities</div></div>
        <div><div class="k">Risk accelerating</div><div class="v">${num(k.accelerating)}</div>
          <div class="s">up more than 5 points since last run</div></div>
        <div><div class="k">Behaviour anomalies</div><div class="v">${num(k.anomalies)}</div>
          <div class="s">abrupt change, independent of risk</div></div>
        <div><div class="k">In first 30 days</div><div class="v">${num(k.in_first_30_days)}</div>
          <div class="s">${pct(k.early_exit_share)} of exits happen in this window</div></div>
        <div><div class="k">Attrition, last 12 months</div><div class="v">${pct(k.annualised_attrition, 1)}</div>
          <div class="s">${num(k.exits_last_90d)} exits in the last quarter</div></div>
      </div>

      <div class="grid g-main">
        <section class="panel">
          <header><div><h2>Retention priority queue</h2>
            <p>Risk weighted by how hard the role is to backfill</p></div></header>
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
              </tr>`).join('') || `<tr><td colspan="7" class="empty">Nothing scored yet.</td></tr>`}
            </tbody></table>
          </div>
        </section>

        <div class="stack">
          <section class="panel">
            <header><div><h2>Risk against reality</h2>
              <p>Mean 30-day risk per run, with exits that followed</p></div></header>
            ${Chart.line([
              { points: trend, color: Chart.colors.amber, area: true },
            ], { height: 150, fmt: v => (v * 100).toFixed(1) + '%' })}
            ${Chart.line([{ points: actual, color: Chart.colors.teal, dots: false }],
              { height: 110, fmt: v => Math.round(v) })}
            <div class="legend" style="margin-top:8px">
              <span><i class="dot" style="background:${Chart.colors.amber}"></i>mean predicted risk</span>
              <span><i class="dot" style="background:${Chart.colors.teal}"></i>exits in the 14 days before each run</span>
            </div>
          </section>

          <section class="panel">
            <header><div><h2>Moving fastest</h2><p>Largest jump since the previous run</p></div></header>
            <div class="table-wrap"><table><tbody>
            ${(d.movers || []).slice(0, 7).map(m => `
              <tr class="clickable" data-emp="${esc(m.EmployeeID)}">
                <td><span class="id">${esc(m.EmployeeID)}</span><div class="sub">${esc(m.Position)}, ${esc(m.Site)}</div></td>
                <td class="num">${pct(m.prev_risk_30)} → <b>${pct(m.risk_30)}</b></td>
                <td class="num">${velocity(m.risk_velocity)}</td>
              </tr>`).join('') || `<tr><td class="empty">No prior run to compare against.</td></tr>`}
            </tbody></table></div>
          </section>
        </div>
      </div>

      <section class="panel">
        <header><div><h2>Risk by site</h2><p>Mean 90-day risk and last 12 months of exits</p></div>
          <a class="btn btn-sm" href="#/segments">All segments</a></header>
        ${Chart.bars((d.segments || []).map(s => ({
          label: `${s.segment} (${s.headcount})`, value: s.mean_risk_90,
          display: pct(s.mean_risk_90) + ` · ${s.exits_12m} exits`,
          color: s.mean_risk_90 > 0.08 ? Chart.colors.risk.High : Chart.colors.navy
        })), { width: 640, labelW: 220 })}
      </section>
    </div>`;
  }

  function notScored() {
    return `<div class="panel empty">
      <h2>No scoring run found</h2>
      <p style="margin-top:8px">Build the data and model first:</p>
      <pre style="margin-top:12px;text-align:left;display:inline-block">python -m attrition.cli pipeline</pre>
    </div>`;
  }

  /* ----------------------------------------------------------- watchlist */
  function watchlist(rows, filters, state) {
    return `
    <div class="stack">
      <section class="panel">
        <header><div><h2>Watchlist</h2><p>${rows.length} employees, highest retention priority first</p></div>
          <a class="btn btn-sm" href="/api/export/watchlist.csv">Download CSV</a></header>
        <div class="row" style="margin-bottom:14px">
          <input id="wl-search" placeholder="Search ID, role, department or site" style="max-width:280px"
                 value="${esc(state.search || '')}">
          <select id="wl-band" style="max-width:150px">
            <option value="">All bands</option>
            ${['Critical', 'High', 'Medium', 'Low'].map(b =>
              `<option ${state.band === b ? 'selected' : ''}>${b}</option>`).join('')}
          </select>
          <select id="wl-site" style="max-width:200px">
            <option value="">All sites</option>
            ${(filters.sites || []).map(s => `<option ${state.site === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          <select id="wl-dept" style="max-width:220px">
            <option value="">All departments</option>
            ${(filters.departments || []).map(s => `<option ${state.department === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          <div class="spacer"></div>
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
              <td class="num">${r.anomaly_flag ? `<span class="pill warn">${num(r.anomaly_score)}</span>` : num(r.anomaly_score)}</td>
              <td>${bandMark(r.risk_band)}</td>
              <td>${bandMark(r.priority_band)}</td>
            </tr>`).join('') || `<tr><td colspan="12" class="empty">No employees match these filters.</td></tr>`}
          </tbody></table>
        </div>
      </section>
    </div>`;
  }

  /* ------------------------------------------------------------ employee */
  function employee(d, canAct) {
    const p = d.profile || {};
    if (!d.scored) {
      return `<div class="panel"><h2>${esc(p.EmployeeID)}</h2>
        <p class="sub" style="margin-top:6px">${esc(p.Position)} · ${esc(p.Department)} · ${esc(p.Site)}</p>
        ${d.exit ? `<div class="note" style="margin-top:14px">Left on ${esc(d.exit.ExitDate)} —
          ${esc(d.exit.ExitType)}, ${esc(d.exit.ExitReason)}, after ${num(d.exit.TenureDaysAtExit)} days.</div>` : ''}
        ${timeline(d.timeline)}</div>`;
    }
    const hist = (d.history || []).map(h => ({ y: h.risk_30, label: (h.as_of || '').slice(5) }));
    const beh = d.behaviour || [];

    return `
    <div class="stack">
      <section class="panel">
        <header>
          <div>
            <h1>${esc(p.EmployeeID)} · ${esc(p.Position)}</h1>
            <p>${esc(p.Department)} · ${esc(p.Site)} · ${esc(p.EmploymentType)} ·
               hired via ${esc(p.RecruitmentSource)} · ${num(p.TenureDays)} days on rolls</p>
          </div>
          <div class="row">
            ${bandMark(p.risk_band)}
            ${canAct ? `<button class="btn btn-primary btn-sm" id="log-action">Log retention action</button>` : ''}
          </div>
        </header>
        <div class="strip" style="border:0">
          <div><div class="k">7-day risk</div><div class="v">${pct(p.risk_7, 2)}</div></div>
          <div><div class="k">30-day risk</div><div class="v">${pct(p.risk_30)}</div>
            <div class="s">${d.peer_median_risk_90 != null ? `department median 90-day ${pct(d.peer_median_risk_90)}` : ''}</div></div>
          <div><div class="k">90-day risk</div><div class="v">${pct(p.risk_90)}</div></div>
          <div><div class="k">Change since last run</div><div class="v">${velocity(p.risk_velocity)}</div>
            <div class="s">percentage points</div></div>
          <div><div class="k">Anomaly score</div><div class="v">${num(p.anomaly_score)}</div>
            <div class="s">${p.anomaly_flag ? 'abrupt change detected' : 'behaviour within range'}</div></div>
          <div><div class="k">Criticality</div><div class="v">${p.BusinessCriticality}/5</div>
            <div class="s">backfill difficulty</div></div>
        </div>
      </section>

      <div class="grid g-main">
        <section class="panel">
          <header><div><h2>What is driving this score</h2>
            <p>Contribution of each factor to the 30-day probability</p></div></header>
          ${Chart.contributions(d.drivers || [])}
          <div class="note" style="margin-top:14px">These are model attributions, not proven causes.
            They show what moved the score, and should open a conversation rather than settle one.</div>
        </section>

        <div class="stack">
          <section class="panel">
            <header><div><h2>Probability of staying</h2>
              <p>Survival curve from the current week</p></div></header>
            ${Chart.survival(d.survival_curve || [], { width: 440 })}
            ${p.expected_days_to_exit ? `<p class="sub" style="margin-top:8px">Expected time on rolls over the
              modelled window: about ${num(p.expected_days_to_exit)} days.</p>` : ''}
          </section>
          <section class="panel">
            <header><div><h2>Risk history</h2><p>Every scoring run for this employee</p></div></header>
            ${Chart.line([{ points: hist, color: Chart.colors.amber, area: true }],
              { width: 420, height: 150, fmt: v => (v * 100).toFixed(1) + '%' })}
          </section>
        </div>
      </div>

      <div class="grid g-main">
        <section class="panel">
          <header><div><h2>Behaviour, last 26 weeks</h2>
            <p>The series the trend features are built from</p></div></header>
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
          <section class="panel">
            <header><div><h2>Suggested next steps</h2><p>Derived from the top drivers above</p></div></header>
            ${(d.actions || []).map(a => `<div class="driver">
              <div><div class="name">${esc(a.action)}</div><div class="val">because: ${esc(a.because)}</div></div>
              <span class="pill">${esc(a.category)}</span></div>`).join('') ||
              '<p class="empty">No elevated drivers.</p>'}
          </section>
          <section class="panel">
            <header><div><h2>Actions logged</h2></div></header>
            ${(d.interventions || []).map(i => `<div class="driver">
              <div><div class="name">${esc(i.action)}</div>
                <div class="val">${esc((i.created_at || '').slice(0, 10))} · ${esc(i.owner || i.created_by || '')}
                ${i.notes ? '· ' + esc(i.notes) : ''}</div></div>
              <span class="pill ${i.status === 'Closed' ? 'good' : ''}">${esc(i.outcome || i.status)}</span>
            </div>`).join('') || '<p class="empty">No actions logged for this employee.</p>'}
          </section>
        </div>
      </div>

      <section class="panel">
        <header><div><h2>Record timeline</h2></div></header>
        ${timeline(d.timeline)}
      </section>
    </div>`;
  }

  function timeline(items) {
    if (!items || !items.length) return '<p class="empty">No events recorded.</p>';
    const mark = new Set(['Exit', 'Resignation Submitted', 'Grievance', 'Manager Change', 'Promotion']);
    return `<ul class="timeline">${items.slice(0, 18).map(e => `
      <li class="${mark.has(e.EventType) ? 'mark' : ''}">
        <div class="when">${esc((e.EventDate || '').slice(0, 10))}</div>
        <div class="what">${esc(e.EventType)} — <span class="sub">${esc(e.EventDetail)}</span></div>
      </li>`).join('')}</ul>`;
  }

  /* ------------------------------------------------------ early attrition */
  function early(d) {
    const bands = (d.bands || []).slice(0, 6);
    return `
    <div class="stack">
      <section class="panel">
        <header><div><h2>Where new hires are lost</h2>
          <p>${pct(d.early_share)} of all ${num(d.total_exits)} exits happened within 30 days of joining</p></div></header>
        ${Chart.columns(bands.map(b => ({ label: b.band, value: b.exits, sub: b.absconding })),
          { width: 680, height: 220 })}
        <div class="legend" style="margin-top:6px">
          <span><i class="dot" style="background:${Chart.colors.navy}"></i>exits</span>
          <span><i class="dot" style="background:${Chart.colors.risk.Critical}"></i>left without notice</span>
        </div>
      </section>

      <div class="grid g-2">
        <section class="panel">
          <header><div><h2>Channel quality</h2>
            <p>Share of each channel's hires who left within 30 days</p></div></header>
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
          <div class="note" style="margin-top:12px">Channel differences here connect recruitment analytics to
            attrition: the cheapest source is not the cheapest if a fifth of its hires leave inside a month.</div>
        </section>

        <section class="panel">
          <header><div><h2>New joiners at risk now</h2>
            <p>On rolls under 90 days, ranked by 30-day risk</p></div></header>
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
            </tr>`).join('') || `<tr><td colspan="6" class="empty">No new joiners on rolls.</td></tr>`}
          </tbody></table></div>
        </section>
      </div>

      <section class="panel">
        <header><div><h2>Stated reasons for early exits</h2>
          <p>From exit records of people who left within 30 days</p></div></header>
        ${Chart.bars((d.early_reasons || []).map(r => ({
          label: r.reason, value: r.count, color: Chart.colors.amber })), { width: 620, labelW: 200 })}
      </section>
    </div>`;
  }

  /* ------------------------------------------------------------ segments */
  function segments(rows, by) {
    const options = [['Site', 'Site'], ['Department', 'Department'], ['EmploymentType', 'Employment type'],
                     ['RecruitmentSource', 'Hiring channel'], ['Position', 'Role'], ['tenure_band', 'Tenure']];
    return `
    <div class="stack">
      <section class="panel">
        <header><div><h2>Segment risk</h2><p>Forward-looking risk beside what actually happened</p></div>
          <div class="seg" id="seg-switch">${options.map(([v, l]) =>
            `<button data-by="${v}" class="${by === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        </header>
        <div class="table-wrap"><table><thead><tr>
          <th>${esc(by)}</th><th class="num">Headcount</th><th class="num">Mean 90-day risk</th>
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
        </tr>`).join('') || `<tr><td colspan="9" class="empty">No segments.</td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
  }

  /* ----------------------------------------------------------- anomalies */
  function anomalies(d) {
    return `
    <div class="grid g-2">
      <section class="panel">
        <header><div><h2>Abrupt behaviour changes</h2>
          <p>Isolation Forest over week-on-week deltas, independent of the risk model</p></div></header>
        <div class="table-wrap"><table><thead><tr>
          <th>Employee</th><th>Role</th><th class="num">Anomaly</th><th class="num">30-day risk</th><th>Band</th>
        </tr></thead><tbody>
        ${(d.items || []).map(r => `<tr class="clickable" data-emp="${esc(r.EmployeeID)}">
          <td><span class="id">${esc(r.EmployeeID)}</span><div class="sub">${num(r.TenureDays)} days</div></td>
          <td>${esc(r.Position)}<div class="sub">${esc(r.Site)}</div></td>
          <td class="num"><span class="pill warn">${num(r.anomaly_score)}</span></td>
          <td class="num">${pct(r.risk_30)}</td>
          <td>${bandMark(r.risk_band)}</td>
        </tr>`).join('') || `<tr><td colspan="5" class="empty">Nothing unusual this run.</td></tr>`}
        </tbody></table></div>
        <div class="note" style="margin-top:12px">A high anomaly score with low risk is still worth a call:
          the risk model only knows patterns that produced exits before, so a new pattern shows up here first.</div>
      </section>

      <section class="panel">
        <header><div><h2>Risk velocity</h2><p>Biggest movers since the previous run</p></div></header>
        <div class="table-wrap"><table><thead><tr>
          <th>Employee</th><th>Role</th><th class="num">Previous</th><th class="num">Now</th><th class="num">Change</th>
        </tr></thead><tbody>
        ${(d.movers || []).map(r => `<tr class="clickable" data-emp="${esc(r.EmployeeID)}">
          <td><span class="id">${esc(r.EmployeeID)}</span></td>
          <td>${esc(r.Position)}<div class="sub">${esc(r.Site)}</div></td>
          <td class="num">${pct(r.prev_risk_30)}</td>
          <td class="num">${pct(r.risk_30)}</td>
          <td class="num">${velocity(r.risk_velocity)}</td>
        </tr>`).join('') || `<tr><td colspan="5" class="empty">Needs at least two scoring runs.</td></tr>`}
        </tbody></table></div>
      </section>
    </div>`;
  }

  /* ------------------------------------------------------- interventions */
  function interventions(d, canAct) {
    const e = d.effectiveness || {};
    return `
    <div class="stack">
      <div class="strip">
        <div><div class="k">Actions logged</div><div class="v">${num(e.total)}</div></div>
        <div><div class="k">Still open</div><div class="v">${num(e.open)}</div></div>
        <div><div class="k">Closed as retained</div>
          <div class="v">${num((e.summary || []).reduce((a, r) => a + r.retained, 0))}</div></div>
      </div>

      <section class="panel">
        <header><div><h2>What has been tried</h2><p>Grouped by action type</p></div></header>
        <div class="table-wrap"><table><thead><tr>
          <th>Action</th><th class="num">Closed</th><th class="num">Retained</th>
          <th class="num">Exited</th><th class="num">Mean risk change</th>
        </tr></thead><tbody>
        ${(e.summary || []).map(r => `<tr>
          <td>${esc(r.action)}</td><td class="num">${num(r.closed)}</td>
          <td class="num">${num(r.retained)}</td><td class="num">${num(r.exited)}</td>
          <td class="num">${r.mean_risk_change_pts == null ? '—' :
            `<span class="${r.mean_risk_change_pts > 0 ? 'delta-up' : 'delta-down'}">${r.mean_risk_change_pts > 0 ? '+' : ''}${r.mean_risk_change_pts}</span>`}</td>
        </tr>`).join('') || `<tr><td colspan="5" class="empty">No closed actions yet.</td></tr>`}
        </tbody></table></div>
        <div class="note" style="margin-top:12px">${esc(e.note || '')}</div>
      </section>

      <section class="panel">
        <header><div><h2>Action log</h2></div></header>
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
            `<button class="btn btn-sm close-int" data-id="${i.id}">Close</button>` : ''}</td>` : ''}
        </tr>`).join('') || `<tr><td colspan="7" class="empty">Nothing logged yet. Open an employee and record an action.</td></tr>`}
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

    return `
    <div class="stack">
      <div class="strip">
        <div><div class="k">Live version</div><div class="v" style="font-size:18px">${esc(c.version)}</div>
          <div class="s">${esc(c.algorithm)}</div></div>
        <div><div class="k">Trained</div><div class="v" style="font-size:18px">${esc((c.trained_at || '').slice(0, 10))}</div>
          <div class="s">${num(c.training_seconds, 1)}s on ${num((c.rows || {}).train)} rows</div></div>
        <div><div class="k">Features</div><div class="v">${num(c.n_features)}</div>
          <div class="s">data through ${esc((c.window || {}).data_cutoff)}</div></div>
        <div><div class="k">Drifted features</div>
          <div class="v">${num(drift.filter(x => x.psi > 0.25).length)}</div>
          <div class="s">PSI above 0.25</div></div>
      </div>

      <section class="panel">
        <header><div><h2>Performance by horizon</h2>
          <p>Measured on the held-out window after the training period</p></div></header>
        <div class="table-wrap"><table><thead><tr>
          <th>Horizon</th><th class="num">Events</th><th class="num">Base rate</th>
          <th class="num">PR-AUC</th><th class="num">ROC-AUC</th><th class="num">Brier</th>
          <th class="num">Recall @ top 10%</th><th class="num">Lift @ top 10%</th><th>Split</th>
        </tr></thead><tbody>
        ${horizons.map(h => { const m = metrics[h]; return `<tr>
          <td>${h} days</td>
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
        <div class="note" style="margin-top:12px">PR-AUC leads because exits are rare — ROC-AUC flatters
          rare-event models. Lift is the number that matters operationally: how much denser the top decile is
          with real leavers than a random list of the same length.</div>
      </section>

      <div class="grid g-main">
        <section class="panel">
          <header><div><h2>Feature drift</h2>
            <p>Population Stability Index, training window against the recent window</p></div></header>
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
        <section class="panel">
          <header><div><h2>Calibration, 30-day model</h2>
            <p>Predicted against observed, by decile</p></div></header>
          ${Chart.calibration(calib, { width: 330, height: 290 })}
        </section>
      </div>

      <section class="panel">
        <header><div><h2>Fairness across groups</h2>
          <p>Flag rate and accuracy by site, department, contract type and channel</p></div></header>
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
        </tr>`).join('') || `<tr><td colspan="7" class="empty">No group met the minimum sample size.</td></tr>`}
        </tbody></table></div>
        <div class="note" style="margin-top:12px">A group flagged far more often than others is not automatically
          unfair — site conditions genuinely differ — but it is always worth explaining before the scores drive
          decisions about people.</div>
      </section>

      <section class="panel">
        <header><div><h2>Version history</h2></div></header>
        <div class="table-wrap"><table><thead><tr>
          <th>Version</th><th>Trained</th><th>Algorithm</th><th class="num">Features</th>
          <th class="num">Train rows</th><th>Data fingerprint</th><th></th>
        </tr></thead><tbody>
        ${(d.versions || []).map(v => `<tr>
          <td><span class="id">${esc(v.version)}</span></td>
          <td>${esc((v.trained_at || '').slice(0, 16).replace('T', ' '))}</td>
          <td>${esc(v.algorithm)}</td>
          <td class="num">${num(v.n_features)}</td>
          <td class="num">${num((v.rows || {}).train)}</td>
          <td><span class="id">${esc(v.data_fingerprint)}</span></td>
          <td>${v.is_current ? '<span class="pill good">live</span>' : ''}</td>
        </tr>`).join('')}
        </tbody></table></div>
      </section>

      <section class="panel">
        <header><div><h2>Scoring runs</h2></div></header>
        <div class="table-wrap"><table><thead><tr>
          <th>As of</th><th class="num">Scored</th><th class="num">Mean 30-day risk</th>
          <th class="num">Critical</th><th>Model</th>
        </tr></thead><tbody>
        ${(d.runs || []).map(r => `<tr>
          <td>${esc(r.as_of)}</td><td class="num">${num(r.n_scored)}</td>
          <td class="num">${pct(r.mean_risk_30, 2)}</td><td class="num">${num(r.n_critical)}</td>
          <td><span class="id">${esc(r.model_version)}</span></td>
        </tr>`).join('')}
        </tbody></table></div>
      </section>
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
    <section class="panel">
      <header><div><h2>Ask about the workforce</h2>
        <p>Answers are built from the scored warehouse — the assistant cannot invent a number</p></div></header>
      <div class="chat" id="chat">
        <div class="msg bot"><pre>Ask about risk, sites, channels, new joiners, a specific employee ID, or the model itself.
Every answer is assembled from live queries against the current scoring run.</pre></div>
      </div>
      <div class="suggests">${prompts.map(p => `<button data-q="${esc(p)}">${esc(p)}</button>`).join('')}</div>
      <form class="ask" id="ask-form">
        <input id="ask-input" placeholder="Ask a question" autocomplete="off">
        <button class="btn btn-primary" type="submit">Ask</button>
      </form>
    </section>`;
  }

  return { overview, watchlist, employee, early, segments, anomalies, interventions, governance, copilot, notScored };
})();
