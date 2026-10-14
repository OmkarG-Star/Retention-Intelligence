/* Model Lab: three ways to play with the live model.

   1. Call-list size: drag the cut-off and see, from the held-out test window,
      how many people that means calling each week, what share of resignations
      the list catches, and how many calls it takes per future leaver.
   2. What it relies on: a treemap of mean |SHAP| share by area. Click an area
      to see the measures inside it.
   3. How it responds: the live 90-day model's projected risk across each
      lever's range for a sample of real employees (median and middle half).

   Everything is computed server-side at training time or by
   `attrition.cli response-curves`; this file only draws and listens. */

const Lab = (() => {
  const esc = Chart.esc, pct = Chart.pct, num = Chart.nice;
  const I = (n, s = 16) => Icons.get(n, s);
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const AREA_VAR = c => `--a-${String(c || 'other').toLowerCase()}`;
  const areaColor = c => css(AREA_VAR(c)) || css('--a-other');
  const LEVER_AREA = { overtime: 'Workload', night_shift: 'Workload', absence: 'Attendance', pay_delay: 'Pay',
    raise: 'Pay', training: 'Career', promote: 'Career', engagement: 'Sentiment', accommodation: 'Logistics' };
  const LEVER_ORDER = ['overtime', 'night_shift', 'absence', 'pay_delay', 'raise', 'training', 'promote', 'engagement', 'accommodation'];
  const tipRow = (a, b) => `<div class='t-row'><span>${esc(a)}</span><b>${esc(b)}</b></div>`;

  let st = null, ro = null;

  /* ------------------------------------------------------------ helpers */
  const H = () => st.d.horizons[st.h] || {};
  const curve = () => H().operating_curve || [];
  const point = () => curve()[st.ki] || {};

  function seg(items, on, attr) {
    return `<div class="seg lab-seg">${items.map(([v, l]) => `<button ${attr}="${v}" class="${String(v) === String(on) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  }

  /* ------------------------------------------------------------ 1. operating point */
  function opTiles() {
    const p = point(), k = p.k, hc = st.d.headcount || 0;
    const people = Math.round(hc * k / 100);
    const per = p.precision > 0 ? 1 / p.precision : null;
    const ring = (v, color) => {
      const r = 22, c = 2 * Math.PI * r;
      return `<svg width="56" height="56" viewBox="0 0 56 56" class="ring"><circle cx="28" cy="28" r="${r}" fill="none" stroke="var(--sunken)" stroke-width="6"/>
        <circle cx="28" cy="28" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"
          stroke-dasharray="${(c * Math.min(v, 1)).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 28 28)"/></svg>`;
    };
    return `
      <div class="lab-tile" style="--tone:var(--accent)"><span class="lt-ic">${I('users', 18)}</span>
        <div><span class="lt-k">People to call each week</span><b class="lt-v">${num(people)}</b>
        <span class="lt-s">top ${num(k, k % 1 ? 1 : 0)}% of ${num(hc)} on rolls</span></div></div>
      <div class="lab-tile" style="--tone:var(--good-mark)">${ring(p.recall || 0, css('--good-mark'))}
        <div><span class="lt-k">Resignations caught</span><b class="lt-v">${pct(p.recall, 0)}</b>
        <span class="lt-s">a random list of this size: ${num(k, k % 1 ? 1 : 0)}%</span></div></div>
      <div class="lab-tile" style="--tone:var(--a-workload)"><span class="lt-ic">${I('target', 18)}</span>
        <div><span class="lt-k">Calls per future leaver</span><b class="lt-v">${per ? num(per, per < 10 ? 1 : 0) : '—'}</b>
        <span class="lt-s">${pct(p.precision, 0)} of the list resign within ${esc(st.h)} days</span></div></div>
      <div class="lab-tile" style="--tone:var(--a-career)"><span class="lt-ic">${I('trendUp', 18)}</span>
        <div><span class="lt-k">Better than random</span><b class="lt-v">${num(p.lift, 1)}×</b>
        <span class="lt-s">hit rate against the ${pct(H().base_rate, 1)} base rate</span></div></div>`;
  }

  function opChart(w) {
    const pts = curve();
    if (!pts.length) return '<p class="sub">No operating curve for this model. Retrain to add it.</p>';
    const h = 250, l = 44, r = 16, t = 14, b = 34, maxK = 50;
    const x = k => l + (k / maxK) * (w - l - r), y = v => t + (1 - v) * (h - t - b);
    const line = key => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.k).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    const area = `${line('recall')}L${x(pts[pts.length - 1].k)},${y(0)}L${x(pts[0].k)},${y(0)}Z`;
    const cur = point(), cx = x(cur.k);
    let g = '';
    for (const v of [0, .25, .5, .75, 1]) g += `<line x1="${l}" x2="${w - r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>
      <text x="${l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v * 100}%</text>`;
    for (const k of [0, 10, 20, 30, 40, 50]) g += `<text x="${x(k)}" y="${h - 12}" text-anchor="middle" font-size="11" fill="var(--muted)">${k}%</text>`;
    g += `<text x="${(l + w - r) / 2}" y="${h}" text-anchor="middle" font-size="11" fill="var(--muted)">call-list size (share of workforce each week)</text>`;
    return `<svg class="chart lab-op" viewBox="0 0 ${w} ${h}" width="100%" style="max-height:${h}px" role="img" aria-label="Recall and hit rate by call-list size">
      <defs><linearGradient id="rc-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--good-mark)" stop-opacity=".22"/><stop offset="1" stop-color="var(--good-mark)" stop-opacity="0"/></linearGradient></defs>
      ${g}
      <line x1="${x(0)}" y1="${y(0)}" x2="${x(maxK)}" y2="${y(maxK / 100)}" stroke="var(--axis)" stroke-dasharray="4 4"/>
      <text x="${x(maxK) - 4}" y="${y(maxK / 100) + 14}" text-anchor="end" font-size="11" fill="var(--muted)">random list</text>
      <path d="${area}" fill="url(#rc-fill)"/>
      <path d="${line('recall')}" fill="none" stroke="var(--good-mark)" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="${line('precision')}" fill="none" stroke="var(--a-workload)" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="${cx}" x2="${cx}" y1="${t - 4}" y2="${h - b}" stroke="var(--accent)" stroke-width="1.5"/>
      <circle cx="${cx}" cy="${y(cur.recall)}" r="6" fill="#fff" stroke="var(--good-mark)" stroke-width="3"/>
      <circle cx="${cx}" cy="${y(cur.precision)}" r="6" fill="#fff" stroke="var(--a-workload)" stroke-width="3"/>
      <rect class="op-hit" x="${l}" y="${t}" width="${w - l - r}" height="${h - t - b}" fill="transparent" data-l="${l}" data-w="${w - l - r}" data-max="${maxK}"/>
    </svg>`;
  }

  function opSection() {
    const ks = curve().map(p => p.k);
    return `
      <section class="panel lab-card" id="lab-op">
        <div class="panel-head"><div><h2><span class="h-dot" style="--tone:var(--good-mark)"></span>How big should the call list be?</h2>
          <p>Drag to choose how many people HR calls each week. Every number comes from the ${esc(st.h)}-day model on a held-out period it never saw${H().windows ? ` (${esc(H().windows.test[0])} to ${esc(H().windows.test[1])})` : ''}.</p></div>
          ${seg([7, 15, 30, 90, 180].filter(h => st.d.horizons[h]).map(h => [h, `${h} days`]), st.h, 'data-h')}</div>
        <div class="op-slider">
          <input type="range" id="op-k" min="0" max="${ks.length - 1}" step="1" value="${st.ki}" aria-label="Call-list size"
            style="--fill:${(st.ki / Math.max(ks.length - 1, 1)) * 100}%">
          <div class="op-ticks">${ks.map((k, i) => `<button data-ki="${i}" class="${i === st.ki ? 'on' : ''} ${k === 15 ? 'live' : ''}">${k}%</button>`).join('')}</div>
        </div>
        <div class="lab-tiles" id="op-tiles">${opTiles()}</div>
        <div class="op-chart" id="op-chart"></div>
        <div class="legend"><span><i class="line" style="background:var(--good-mark)"></i>Resignations caught (recall)</span>
          <span><i class="line" style="background:var(--a-workload)"></i>Hit rate (precision)</span>
          <span><i class="line dash"></i>Random list</span><span class="sub">The live watchlist uses 15%.</span></div>
      </section>`;
  }

  /* ------------------------------------------------------------ 2. importance treemap */
  function squarify(items, x, y, w, h) {
    // classic squarified treemap (Bruls et al.), items sorted by value desc
    const out = [], total = items.reduce((a, b) => a + b.v, 0) || 1;
    let rest = items.map(it => ({ ...it, a: (it.v / total) * w * h }));
    const worst = (row, side) => {
      const s = row.reduce((a, b) => a + b.a, 0), mx = Math.max(...row.map(r => r.a)), mn = Math.min(...row.map(r => r.a));
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    };
    while (rest.length) {
      const side = Math.min(w, h);
      let row = [rest[0]], i = 1;
      while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
      const s = row.reduce((a, b) => a + b.a, 0);
      if (w >= h) {
        const cw = s / h; let cy = y;
        row.forEach(r => { const rh = r.a / cw; out.push({ ...r, x, y: cy, w: cw, h: rh }); cy += rh; });
        x += cw; w -= cw;
      } else {
        const ch = s / w; let cx = x;
        row.forEach(r => { const rw = r.a / ch; out.push({ ...r, x: cx, y, w: rw, h: ch }); cx += rw; });
        y += ch; h -= ch;
      }
      rest = rest.slice(row.length);
    }
    return out;
  }

  function treemap(w) {
    const areas = ((H().importance || {}).areas || []).filter(a => a.share > 0.002);
    if (!areas.length) return '<p class="sub">No importance recorded for this model. Retrain to add it.</p>';
    const h = Math.max(260, Math.min(360, w * 0.5)), gap = 4;
    const cells = squarify(areas.map(a => ({ ...a, v: a.share })), 0, 0, w, h);
    return `<div class="tm" style="height:${h}px">${cells.map(c => {
      const both = c.w > 96 && c.h > 74, label = !both && c.w > 110 && c.h > 30, value = !both && !label && c.w > 40 && c.h > 30;
      return `<button class="tm-cell ${st.area === c.area ? 'on' : ''}" data-area="${esc(c.area)}"
        style="left:${c.x + gap / 2}px;top:${c.y + gap / 2}px;width:${Math.max(c.w - gap, 2)}px;height:${Math.max(c.h - gap, 2)}px;--tone:${areaColor(c.area)}"
        data-tip-h="${esc(`<b>${c.label}</b>${tipRow('Share of what the model relies on', pct(c.share, 1))}`)}">
        ${both || label ? `<span class="tm-l">${esc(c.label)}</span>` : ''}${both || value ? `<span class="tm-v">${pct(c.share, 0)}</span>` : ''}</button>`;
    }).join('')}</div>`;
  }

  // "OvertimeHours7D_mean_13w" -> "Overtime hours, 13-week average"
  function measure(f) {
    const parts = { cur: 'this week', mean_4w: '4-week average', mean_8w: '8-week average', mean_13w: '13-week average',
      max_13w: '13-week peak', std_8w: '8-week variability', slope_8w: '8-week trend', delta_4w: 'change over 4 weeks',
      ratio_cur_13w: 'this week vs 13-week average' };
    const m = f.match(/^([A-Za-z0-9]+?)(?:7D)?_(cur|mean_4w|mean_8w|mean_13w|max_13w|std_8w|slope_8w|delta_4w|ratio_cur_13w)$/);
    const words = x => x.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\bis\b /, '').toLowerCase()
      .replace(/^./, c => c.toUpperCase());
    return m ? `${words(m[1])}, ${parts[m[2]]}` : words(f);
  }

  function areaDetail() {
    const imp = H().importance || {};
    const area = st.area || (imp.areas && imp.areas[0] && imp.areas[0].area);
    const a = (imp.areas || []).find(x => x.area === area);
    if (!a) return '';
    const feats = (imp.features || []).filter(f => f.area === area);
    const max = Math.max(...feats.map(f => f.share), 0.001);
    // several measures can share one plain-English label; name the measure itself then
    const seen = {}; feats.forEach(f => { seen[f.label] = (seen[f.label] || 0) + 1; });
    const nice = f => seen[f.label] > 1 ? measure(f.feature) : f.label;
    return `<div class="ad-head" style="--tone:${areaColor(area)}"><span class="ad-dot"></span><div><b>${esc(a.label)}</b>
        <span class="sub">${pct(a.share, 1)} of everything the ${esc(st.h)}-day model relies on</span></div></div>
      ${feats.length ? `<div class="ad-list">${feats.map(f => `<div class="ad-row" style="--tone:${areaColor(area)}">
        <span class="nm" title="${esc(f.feature)}">${esc(nice(f))}</span><span class="tr"><i style="width:${(f.share / max) * 100}%"></i></span>
        <b>${pct(f.share, 1)}</b></div>`).join('')}</div>`
        : `<p class="sub">Each measure in this area is small; none is in the model's top 40.</p>`}
      <p class="sub" style="margin-top:12px">Share of mean absolute SHAP on the held-out window. It says what the model leans on, not what causes resignations.</p>`;
  }

  function impSection() {
    return `
      <section class="panel lab-card" id="lab-imp">
        <div class="panel-head"><div><h2><span class="h-dot" style="--tone:var(--a-sentiment)"></span>What the model relies on</h2>
          <p>Each tile is an area, sized by its share of the model's attention. Click a tile to look inside.</p></div></div>
        <div class="imp-grid"><div id="lab-tm"></div><div class="area-detail" id="lab-area">${areaDetail()}</div></div>
      </section>`;
  }

  /* ------------------------------------------------------------ 3. response curves */
  function respChart(w) {
    const rc = st.d.response_curves, L = rc && rc.levers[st.lever];
    if (!L) return '';
    const pts = L.points, color = areaColor(LEVER_AREA[st.lever]);
    const h = 280, l = 48, r = 18, t = 16, b = 40;
    const toggle = pts.length === 2 && ['promote', 'accommodation'].includes(st.lever);
    const top = Math.max(...pts.map(p => p.q3), rc.baseline.q3) * 1.08 || 0.1;
    const step = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2].find(s2 => top / s2 <= 5) || 0.25;
    const ticks = Math.ceil(top / step), ymax = ticks * step;
    const y = v => t + (1 - v / ymax) * (h - t - b);
    let g = '';
    for (let i = 0; i <= ticks; i++) {
      const v = step * i;
      g += `<line x1="${l}" x2="${w - r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${+(v * 100).toFixed(1)}%</text>`;
    }
    const by = y(rc.baseline.mean);
    g += `<line x1="${l}" x2="${w - r}" y1="${by}" y2="${by}" stroke="var(--ink-2)" stroke-dasharray="5 4" opacity=".6"/>
      <text x="${w - r}" y="${by - 6}" text-anchor="end" font-size="11" fill="var(--ink-2)">if this week repeats: ${pct(rc.baseline.mean, 1)}</text>`;
    if (toggle) {
      const bw = Math.min(120, (w - l - r) / 4), xs = [l + (w - l - r) * 0.3, l + (w - l - r) * 0.7];
      pts.forEach((p, i) => {
        const cx = xs[i];
        g += `<g class="mark" data-tip-h="${esc(`<b>${L.label}: ${i ? 'yes' : 'no'}</b>${tipRow('Average risk', pct(p.mean, 1))}${tipRow('Middle half', `${pct(p.q1, 1)} to ${pct(p.q3, 1)}`)}`)}">
          <rect x="${cx - bw / 2}" y="${y(p.q3)}" width="${bw}" height="${Math.max(y(p.q1) - y(p.q3), 2)}" rx="10" fill="${color}" opacity="${i ? .28 : .14}"/>
          <line x1="${cx - bw / 2}" x2="${cx + bw / 2}" y1="${y(p.mean)}" y2="${y(p.mean)}" stroke="${color}" stroke-width="4" stroke-linecap="round" opacity="${i ? 1 : .55}"/>
          <text x="${cx}" y="${y(p.q3) - 8}" text-anchor="middle" font-size="12.5" font-weight="600" fill="var(--ink)">${pct(p.mean, 1)}</text>
          <text x="${cx}" y="${h - 14}" text-anchor="middle" font-size="12" fill="var(--ink-2)">${i ? 'Yes, for everyone' : 'As today'}</text></g>`;
      });
    } else {
      const xs = pts.map(p => p.value), x0 = Math.min(...xs), x1 = Math.max(...xs);
      const x = v => l + ((v - x0) / ((x1 - x0) || 1)) * (w - l - r);
      const band = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.value)},${y(p.q3)}`).join('') +
        [...pts].reverse().map(p => `L${x(p.value)},${y(p.q1)}`).join('') + 'Z';
      const med = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.value)},${y(p.mean)}`).join('');
      g += `<path d="${band}" fill="${color}" opacity=".16"/><path d="${med}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
      pts.forEach(p => {
        g += `<g class="mark" data-tip-h="${esc(`<b>${L.label} = ${num(p.value)}${L.unit === '%' ? '%' : ' ' + L.unit}</b>${tipRow('Average 90-day risk', pct(p.mean, 1))}${tipRow('Middle half of people', `${pct(p.q1, 1)} to ${pct(p.q3, 1)}`)}${tipRow('Expected resignations per 100', num(p.mean * 100, 1))}`)}">
          <rect x="${x(p.value) - 14}" y="${t}" width="28" height="${h - t - b}" fill="transparent"/>
          <circle cx="${x(p.value)}" cy="${y(p.mean)}" r="5" fill="#fff" stroke="${color}" stroke-width="2.5"/></g>
          <text x="${x(p.value)}" y="${h - 22}" text-anchor="middle" font-size="11" fill="var(--muted)">${num(p.value)}</text>`;
      });
      g += `<text x="${(l + w - r) / 2}" y="${h - 4}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(L.label)}${L.unit ? ` (${esc(L.unit)})` : ''}, set for everyone in the sample</text>`;
      if (L.today_median != null && L.today_median >= x0 && L.today_median <= x1) {
        const tx = x(L.today_median);
        g += `<line x1="${tx}" x2="${tx}" y1="${t}" y2="${h - b}" stroke="var(--ink)" stroke-width="1" stroke-dasharray="2 3" opacity=".5"/>
          <text x="${tx + 5}" y="${t + 10}" font-size="11" fill="var(--ink-2)">typical today: ${num(L.today_median, 1)}</text>`;
      }
    }
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" style="max-height:${h}px" role="img" aria-label="Risk response to ${esc(L.label)}">${g}</svg>`;
  }

  function respSentence() {
    const rc = st.d.response_curves, L = rc && rc.levers[st.lever];
    if (!L) return '';
    const a = L.points[0], z = L.points[L.points.length - 1];
    const d = (z.mean - a.mean) * 100;
    const verb = Math.abs(d) < 0.2 ? 'barely changes' : d > 0 ? 'rises' : 'falls';
    const u = L.unit === '%' || (L.unit || '').startsWith('/') ? esc(L.unit) : L.unit ? ' ' + esc(L.unit) : '';
    return `From ${num(a.value)}${u.startsWith('/') ? u : ''} to ${num(z.value)}${u}, the average 90-day risk ${verb}
      ${Math.abs(d) < 0.2 ? '' : `from <b>${pct(a.mean, 1)}</b> to <b>${pct(z.mean, 1)}</b>`}.`
      .replace('From 0 to 1, ', L.points.length === 2 ? `With ${esc(L.label.toLowerCase())} for everyone, ` : 'From 0 to 1, ');
  }

  function respSection() {
    const rc = st.d.response_curves;
    if (!rc) return `<section class="panel lab-card"><div class="panel-head"><div><h2><span class="h-dot" style="--tone:var(--a-workload)"></span>How the model responds</h2>
      <p>Run <code>python -m attrition.cli response-curves</code> to compute the response curves for the live model.</p></div></div></section>`;
    return `
      <section class="panel lab-card" id="lab-resp">
        <div class="panel-head"><div><h2><span class="h-dot" style="--tone:var(--a-workload)"></span>How the model responds</h2>
          <p>${num(rc.people)} real employees, projected ${rc.weeks} weeks ahead with one lever set to each value for everyone. The line is the average 90-day risk (expected resignations per 100 people), the band the middle half of people.</p></div></div>
        <div class="lever-chips">${LEVER_ORDER.filter(k => rc.levers[k]).map(k => `<button data-lever="${k}" class="${k === st.lever ? 'on' : ''}" style="--tone:${areaColor(LEVER_AREA[k])}">
          <i></i>${esc(rc.levers[k].label)}</button>`).join('')}</div>
        <div id="resp-chart"></div>
        <p class="resp-say" id="resp-say">${respSentence()}</p>
        <p class="sub">The model's expectation with everything else held at each person's latest week. Use the what-if panel on an employee page to try this for one person.</p>
      </section>`;
  }

  /* ------------------------------------------------------------ paint + events */
  function paintCharts() {
    const oc = st.root.querySelector('#op-chart'), tm = st.root.querySelector('#lab-tm'), rc = st.root.querySelector('#resp-chart');
    if (oc) oc.innerHTML = opChart(Math.max(oc.clientWidth, 280));
    if (tm) tm.innerHTML = treemap(Math.max(tm.clientWidth, 260));
    if (rc) rc.innerHTML = respChart(Math.max(rc.clientWidth, 280));
  }

  function paint() {
    const d = st.d, m = H();
    const model = { lgbm: 'gradient boosting', logistic: 'logistic regression', blend: 'a blend of gradient boosting and logistic regression' }[m.champion] || m.champion;
    st.root.innerHTML = `
      <div class="stack lab">
        <section class="lab-hero">
          <div class="lh-text"><span class="lh-eyebrow">${I('flask', 14)} Model lab · ${esc(d.version)}</span>
            <h2>Play with the model before you trust it.</h2>
            <p>The ${esc(st.h)}-day model is ${esc(model)}. On a period it never saw it ranked people ${num(m.pr_auc / (m.base_rate || 1), 1)}× better than chance (PR-AUC ${num(m.pr_auc, 3)}). Change the list size, look inside, and watch how it responds.</p></div>
          <div class="lh-stats">
            <div style="--tone:var(--accent)"><b>${pct(m.recall_at_15, 0)}</b><span>of resignations on a 15% list</span></div>
            <div style="--tone:var(--a-workload)"><b>${num(m.roc_auc, 2)}</b><span>ROC-AUC</span></div>
            <div style="--tone:var(--good-mark)"><b>${num(m.positives)}</b><span>resignations in the test period</span></div>
          </div>
        </section>
        ${opSection()}
        <div class="grid lab-two">${impSection()}</div>
        ${respSection()}
      </div>`;
    paintCharts();
  }

  function setK(i) {
    const n = curve().length;
    st.ki = Math.max(0, Math.min(n - 1, i));
    const r = st.root.querySelector('#op-k');
    if (r) { r.value = st.ki; r.style.setProperty('--fill', (st.ki / Math.max(n - 1, 1)) * 100 + '%'); }
    st.root.querySelectorAll('[data-ki]').forEach(b => b.classList.toggle('on', +b.dataset.ki === st.ki));
    st.root.querySelector('#op-tiles').innerHTML = opTiles();
    const oc = st.root.querySelector('#op-chart'); oc.innerHTML = opChart(Math.max(oc.clientWidth, 280));
  }

  function kFromPointer(e) {
    const hit = e.target.closest('.op-hit'); if (!hit) return;
    const svg = hit.ownerSVGElement, box = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal, sx = vb.width / box.width;
    const xv = (e.clientX - box.left) * sx, k = ((xv - +hit.dataset.l) / +hit.dataset.w) * +hit.dataset.max;
    const ks = curve().map(p => p.k);
    let best = 0; ks.forEach((kk, i) => { if (Math.abs(kk - k) < Math.abs(ks[best] - k)) best = i; });
    if (best !== st.ki) setK(best);
  }

  let dragging = false;
  window.addEventListener('pointerup', () => { dragging = false; });

  function mount(host, d) {
    if (d.status !== 'ok') { host.innerHTML = '<div class="panel"><p class="sub">No trained model yet. Run the pipeline first.</p></div>'; return; }
    // a fresh element per visit, so listeners never pile up on the shared view
    host.innerHTML = '<div class="lab-root"></div>';
    const root = host.firstElementChild;
    const h = String(d.band_horizon || 90);
    st = { root, d, h: d.horizons[h] ? h : Object.keys(d.horizons).pop(), ki: 0, area: null,
           lever: d.response_curves ? (LEVER_ORDER.find(k => d.response_curves.levers[k]) || null) : null };
    const ks = curve().map(p => p.k); st.ki = Math.max(ks.indexOf(15), 0);
    paint();
    root.addEventListener('input', e => { if (e.target.id === 'op-k') setK(+e.target.value); });
    root.addEventListener('pointerdown', e => { if (e.target.closest('.op-hit')) { dragging = true; kFromPointer(e); } });
    root.addEventListener('pointermove', e => { if (dragging && st) kFromPointer(e); });
    root.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.ki != null) setK(+b.dataset.ki);
      else if (b.dataset.h) {
        const prevK = point().k; st.h = b.dataset.h; st.area = null;
        const ks2 = curve().map(p => p.k); st.ki = Math.max(ks2.indexOf(prevK), 0); paint();
      } else if (b.dataset.area) {
        st.area = b.dataset.area;
        st.root.querySelectorAll('.tm-cell').forEach(c => c.classList.toggle('on', c.dataset.area === st.area));
        st.root.querySelector('#lab-area').innerHTML = areaDetail();
      } else if (b.dataset.lever) {
        st.lever = b.dataset.lever;
        st.root.querySelectorAll('[data-lever]').forEach(c => c.classList.toggle('on', c === b));
        const rc = st.root.querySelector('#resp-chart'); rc.innerHTML = respChart(Math.max(rc.clientWidth, 280));
        st.root.querySelector('#resp-say').innerHTML = respSentence();
      }
    });
    ro = new ResizeObserver(() => { if (st) paintCharts(); });
    ro.observe(root);
  }

  function unmount() { if (ro) ro.disconnect(); ro = null; st = null; }

  return { mount, unmount, areaColor };
})();
