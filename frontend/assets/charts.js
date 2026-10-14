/* Hand-built SVG charts.
   No charting library: the UI ships as static files with nothing fetched from a
   CDN, which matters on a site network behind a corporate proxy.

   Rules every chart here follows:
   - one y-axis per chart (two scales -> two charts);
   - colours come from the stylesheet tokens, read at draw time, so light and
     dark each get their own validated steps;
   - text is set in ink tokens, never in the series colour;
   - every mark answers hover: elements carry data-tip-h (trusted HTML built
     here with esc()) and App shows it in the shared tooltip, near the pointer. */

const Chart = (() => {
  const C = {};
  const TOKENS = {
    ink: '--ink', ink2: '--ink-2', muted: '--muted', grid: '--grid', axis: '--axis', surface: '--surface',
    s1: '--series-1', s2: '--series-2', cat1: '--cat-1', cat2: '--cat-2', cat3: '--cat-3',
    low: '--r-low', med: '--r-med', high: '--r-high', crit: '--r-crit', good: '--good-mark', bad: '--bad'
  };

  function syncPalette() {
    const css = getComputedStyle(document.documentElement);
    for (const [k, v] of Object.entries(TOKENS)) C[k] = css.getPropertyValue(v).trim();
    C.risk = { Critical: C.crit, High: C.high, Medium: C.med, Low: C.low, Watch: C.low };
    return C;
  }

  const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const nice = (v, d = 0) => v == null || isNaN(v) ? '—' :
    Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 1) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(d) + '%';
  const tip = html => `data-tip-h="${esc(html)}"`;
  const row = (label, value, color) =>
    `<div class="t-row"><span>${color ? `<i style="background:${color}"></i>` : ''}${esc(label)}</span><b>${esc(value)}</b></div>`;

  function svg(w, h, body, label) {
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(label || 'chart')}"
      preserveAspectRatio="xMinYMin meet" style="max-height:${h}px">${body}</svg>`;
  }
  const scale = ([d0, d1], [r0, r1]) => v => r0 + ((v - d0) / ((d1 - d0) || 1)) * (r1 - r0);

  /* round-number ticks so axes read 0, 5, 10% rather than 0, 4.3, 8.6% */
  function ticks(lo, hi, n = 4) {
    const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function empty(w, h, text = 'No data yet') {
    return svg(w, h, `<text x="${w / 2}" y="${h / 2}" fill="${C.muted}" font-size="13" text-anchor="middle">${esc(text)}</text>`, 'empty');
  }

  /* ---------------------------------------------------------------- line
     series: [{ name, color, points: [{ x: label, y }], dash, area }] */
  function line(series, opts = {}) {
    const w = opts.width || 640, h = opts.height || 220;
    const m = { t: 12, r: opts.right ?? 16, b: 26, l: opts.left ?? 44 };
    const all = series.flatMap(s => s.points.map(p => p.y)).filter(v => v != null && !isNaN(v));
    if (!all.length) return empty(w, h);
    const fmt = opts.fmt || (v => nice(v, 1));
    const hi0 = opts.yMax ?? Math.max(...all) * 1.12;
    const lo0 = opts.yMin ?? Math.min(0, ...all);
    const yt = ticks(lo0, hi0 || 1, opts.ticks || 4);
    const yMax = Math.max(hi0, yt[yt.length - 1]), yMin = Math.min(lo0, yt[0]);
    const n = Math.max(...series.map(s => s.points.length));
    const x = scale([0, Math.max(n - 1, 1)], [m.l, w - m.r]);
    const y = scale([yMin, yMax], [h - m.b, m.t]);
    let body = '';
    yt.forEach(v => {
      body += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? C.axis : C.grid}"/>
        <text x="${m.l - 8}" y="${y(v) + 4}" fill="${C.muted}" font-size="11" text-anchor="end" class="tnum">${esc(fmt(v))}</text>`;
    });
    series.forEach(s => {
      const pts = s.points.map((p, i) => p.y == null ? null : [x(i), y(p.y)]).filter(Boolean);
      if (!pts.length) return;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      if (s.area) body += `<path d="${d} L${pts[pts.length - 1][0]} ${y(yMin)} L${pts[0][0]} ${y(yMin)} Z" fill="${s.color}" opacity=".1"/>`;
      body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
        ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`;
      if (s.label) {
        const last = pts[pts.length - 1];
        body += `<text x="${last[0] + 6}" y="${last[1] + 4}" fill="${C.ink2}" font-size="11.5">${esc(s.label)}</text>`;
      }
    });
    const labels = series[0].points, step = Math.max(1, Math.ceil(labels.length / (opts.xTicks || 6)));
    labels.forEach((p, i) => {
      if (i % step && i !== labels.length - 1) return;
      if (i !== labels.length - 1 && labels.length - 1 - i < step * 0.6) return;
      body += `<text x="${x(i)}" y="${h - 7}" fill="${C.muted}" font-size="11" text-anchor="middle">${esc(p.x)}</text>`;
    });
    // hover columns: a crosshair and every series' value at that x
    const bw = (w - m.l - m.r) / Math.max(n - 1, 1);
    for (let i = 0; i < n; i++) {
      const rows = series.map(s => s.points[i] && s.points[i].y != null ?
        row(s.name || '', fmt(s.points[i].y), s.color) : '').join('');
      const dots = series.map(s => s.points[i] && s.points[i].y != null ?
        `<circle cx="${x(i)}" cy="${y(s.points[i].y)}" r="4" fill="${s.color}" stroke="${C.surface}" stroke-width="2"/>` : '').join('');
      body += `<g class="col"><rect class="hit" x="${x(i) - bw / 2}" y="${m.t}" width="${bw}" height="${h - m.t - m.b}"
        ${tip(`<b>${esc(series[0].points[i] ? series[0].points[i].x : '')}</b>${rows}`)}/>
        <g class="xh"><line x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${h - m.b}" stroke="${C.axis}"/>${dots}</g></g>`;
    }
    return svg(w, h, body, opts.label);
  }

  /* ---------------------------------------------------------- retention
     The chance this person has not resigned after N days. Points come from
     the horizon models, so they agree with every number on the page. */
  function retention(points, opts = {}) {
    const w = opts.width || 460, h = opts.height || 220, m = { t: 26, r: 18, b: 26, l: 42 };
    if (!points || points.length < 2) return empty(w, h);
    const maxDay = points[points.length - 1].day;
    const minS = Math.min(...points.map(p => p.survival));
    const lo = Math.max(0, Math.floor((minS - 0.08) * 10) / 10);
    const x = scale([0, maxDay], [m.l, w - m.r]), y = scale([lo, 1], [h - m.b, m.t]);
    let body = '';
    ticks(lo, 1, 4).forEach(v => {
      body += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/>
        <text x="${m.l - 8}" y="${y(v) + 4}" fill="${C.muted}" font-size="11" text-anchor="end">${Math.round(v * 100)}%</text>`;
    });
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${y(p.survival).toFixed(1)}`).join(' ');
    body += `<path d="${d} L${x(maxDay)} ${y(lo)} L${x(0)} ${y(lo)} Z" fill="${C.s1}" opacity=".08"/>
      <path d="${d}" fill="none" stroke="${C.s1}" stroke-width="2" stroke-linejoin="round"/>`;
    let lastX = -1e9;
    points.forEach(p => {
      if (!p.day) return;
      const label = (opts.labelDays || [30, 90, 180]).includes(p.day);
      const axisLbl = x(p.day) - lastX >= 30;
      if (axisLbl) lastX = x(p.day);
      body += `${axisLbl ? `<text x="${x(p.day)}" y="${h - 7}" fill="${C.muted}" font-size="11" text-anchor="middle">${p.day}d</text>` : ''}
        <circle class="mark" cx="${x(p.day)}" cy="${y(p.survival)}" r="${label ? 5 : 4}" fill="${C.s1}" stroke="${C.surface}" stroke-width="2"
          ${tip(`<b>Day ${p.day}</b>${row('Still here', pct(p.survival, 1))}${row('Resigned by then', pct(1 - p.survival, 1))}`)}/>`;
      if (label) body += `<text x="${x(p.day)}" y="${y(p.survival) - 10}" fill="${C.ink}" font-size="11.5" font-weight="500"
        text-anchor="${p.day === maxDay ? 'end' : 'middle'}">${Math.round(p.survival * 100)}%</text>`;
    });
    return svg(w, h, body, 'Chance of still being here, by day');
  }

  /* ------------------------------------------------------ contributions
     Diverging bars: what pushed this person's risk up (ember) or down (blue). */
  function contributions(drivers, opts = {}) {
    const rows = drivers.slice(0, opts.limit || 8);
    if (!rows.length) return `<p class="sub">No contributions recorded.</p>`;
    const w = opts.width || 560, rowH = 34, h = rows.length * rowH + 28;
    const labelW = Math.min(210, Math.round(w * 0.42)), plot = w - labelW - 16, lblChars = Math.max(12, Math.floor(labelW / 6.6));
    const max = Math.max(...rows.map(d => Math.abs(d.impact_pct))) || 1;
    const hasNeg = rows.some(d => d.impact_pct < 0);
    const mid = labelW + (hasNeg ? plot * 0.42 : 8);
    const half = hasNeg ? plot * 0.5 : plot - 56;
    let body = `<line x1="${mid}" x2="${mid}" y1="0" y2="${h - 24}" stroke="${C.axis}"/>`;
    rows.forEach((d, i) => {
      const yy = 4 + i * rowH, up = d.impact_pct >= 0;
      const len = Math.max((Math.abs(d.impact_pct) / max) * half * 0.86, 2);
      const col = up ? C.high : C.s1;
      const val = d.value == null ? '' : typeof d.value === 'number' ? nice(d.value, Math.abs(d.value) >= 100 ? 0 : 2) : d.value;
      const sub = (d.detail || d.category) + (val !== '' ? `: ${val}` : '');
      const t = `<b>${esc(d.label)}</b>${row(up ? 'Adds to risk' : 'Takes off risk', `${Math.abs(d.impact_pct).toFixed(1)} points`)}${row('Strongest factor', d.detail || '')}${val !== '' ? row('Its value', val) : ''}${d.n_features > 1 ? row('Measures combined', d.n_features) : ''}`;
      body += `<g class="mark" ${tip(t)}><rect x="0" y="${yy - 3}" width="${w}" height="${rowH}" fill="transparent"/>
        <text x="0" y="${yy + 11}" fill="${C.ink}" font-size="12.5">${esc(d.label.length > lblChars ? d.label.slice(0, lblChars - 1) + '…' : d.label)}</text>
        <text x="0" y="${yy + 25}" fill="${C.muted}" font-size="11">${esc(sub.length > lblChars + 6 ? sub.slice(0, lblChars + 5) + '…' : sub)}</text>
        <rect x="${up ? mid : mid - len}" y="${yy + 3}" width="${len}" height="12" rx="2" fill="${col}"/>
        <text x="${up ? mid + len + 6 : mid - len - 6}" y="${yy + 13}" fill="${C.ink2}" font-size="11.5" class="tnum"
          text-anchor="${up ? 'start' : 'end'}">${up ? '+' : '−'}${Math.abs(d.impact_pct).toFixed(1)}</text></g>`;
    });
    body += `<text x="${mid + 6}" y="${h - 6}" fill="${C.muted}" font-size="11">raises risk (points)</text>`;
    if (hasNeg) body += `<text x="${mid - 6}" y="${h - 6}" fill="${C.muted}" font-size="11" text-anchor="end">lowers risk</text>`;
    return svg(w, h, body, 'What moved this score');
  }

  /* ---------------------------------------------------------------- hbars
     rows: [{ label, value, display, color, flag, tip }] */
  function hbars(rows, opts = {}) {
    if (!rows.length) return `<p class="sub">Nothing to show.</p>`;
    const w = opts.width || 620, rowH = opts.rowH || 30, h = rows.length * rowH + 4;
    const labelW = Math.min(opts.labelW || 210, Math.round(w * 0.36)), valW = Math.min(opts.valW || 120, Math.round(w * 0.3));
    const maxChars = Math.max(10, Math.floor(labelW / 7));
    const max = opts.max || Math.max(...rows.map(r => r.value)) || 1;
    const x = scale([0, max], [labelW, w - valW]);
    let body = '';
    if (opts.ref != null) body += `<line x1="${x(opts.ref)}" x2="${x(opts.ref)}" y1="0" y2="${h}" stroke="${C.ink2}" stroke-dasharray="3 3"/>`;
    rows.forEach((r, i) => {
      const yy = i * rowH, len = Math.max(x(r.value) - labelW, 2);
      const lbl = r.label.length > maxChars ? r.label.slice(0, maxChars - 1) + '…' : r.label;
      body += `<g class="mark" ${tip(r.tip || `<b>${esc(r.label)}</b>${row('Value', r.display ?? nice(r.value, 2))}`)}>
        <rect x="0" y="${yy}" width="${w}" height="${rowH}" fill="transparent"/>
        <text x="0" y="${yy + rowH / 2 + 4}" fill="${C.ink}" font-size="12.5">${esc(lbl)}</text>
        <rect x="${labelW}" y="${yy + rowH / 2 - 6}" width="${len}" height="12" rx="2" fill="${r.color || C.s1}"/>
        <text x="${labelW + len + 8}" y="${yy + rowH / 2 + 4}" fill="${C.ink2}" font-size="12" class="tnum">${esc(r.display ?? nice(r.value))}${r.flag ? `<tspan dx="10" fill="${C.bad}" font-size="11.5">${esc(r.flag)}</tspan>` : ''}</text></g>`;
    });
    return svg(w, h, body, opts.label);
  }

  /* --------------------------------------------------------------- columns
     Stacked: notice given (series 1) on top of left without notice (series 2). */
  function columns(rows, opts = {}) {
    if (!rows.length) return `<p class="sub">Nothing to show.</p>`;
    const w = opts.width || 640, h = opts.height || 230, m = { t: 18, b: 40, l: 40, r: 8 };
    const max = Math.max(...rows.map(r => r.value)) || 1;
    const yt = ticks(0, max, 4), top = Math.max(max, yt[yt.length - 1]);
    const bw = (w - m.l - m.r) / rows.length, y = scale([0, top], [h - m.b, m.t]);
    let body = '';
    yt.forEach(v => body += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? C.grid : C.axis}"/>
      <text x="${m.l - 8}" y="${y(v) + 4}" fill="${C.muted}" font-size="11" text-anchor="end">${nice(v)}</text>`);
    rows.forEach((r, i) => {
      const bx = m.l + i * bw + bw * 0.2, bwidth = bw * 0.6, sub = r.sub || 0;
      const yS = y(sub), yT = y(r.value);
      const t = `<b>${esc(r.label)}</b>${row('All exits', nice(r.value), null)}${row('Gave notice', nice(r.value - sub), C.s1)}${row('Left without notice', nice(sub), C.s2)}`;
      body += `<g class="mark" ${tip(t)}><rect x="${m.l + i * bw}" y="${m.t}" width="${bw}" height="${h - m.t - m.b}" fill="transparent"/>
        ${sub ? `<rect x="${bx}" y="${yS}" width="${bwidth}" height="${Math.max(h - m.b - yS, 0)}" fill="${C.s2}"/>` : ''}
        <rect x="${bx}" y="${yT}" width="${bwidth}" height="${Math.max(yS - yT - (sub ? 2 : 0), 0)}" rx="2" fill="${C.s1}"/>
        <text x="${bx + bwidth / 2}" y="${yT - 6}" fill="${C.ink2}" font-size="11.5" text-anchor="middle" class="tnum">${nice(r.value)}</text>
        <text x="${bx + bwidth / 2}" y="${h - 22}" fill="${C.ink2}" font-size="11.5" text-anchor="middle">${esc(r.label)}</text></g>`;
    });
    body += `<text x="${m.l}" y="${h - 4}" fill="${C.muted}" font-size="11">tenure at exit</text>`;
    return svg(w, h, body, opts.label);
  }

  /* ----------------------------------------------------------- calibration */
  function calibration(bins, opts = {}) {
    const w = opts.width || 360, h = opts.height || 300, m = { t: 12, r: 14, b: 40, l: 46 };
    if (!bins || !bins.length) return empty(w, h);
    const hi = Math.max(...bins.map(b => Math.max(b.predicted, b.observed))) * 1.08;
    const tk = ticks(0, hi, 4), top = Math.max(hi, tk[tk.length - 1]);
    const x = scale([0, top], [m.l, w - m.r]), y = scale([0, top], [h - m.b, m.t]);
    let body = '';
    tk.forEach(v => body += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/>
      <text x="${m.l - 8}" y="${y(v) + 4}" fill="${C.muted}" font-size="11" text-anchor="end">${Math.round(v * 100)}%</text>
      <text x="${x(v)}" y="${h - m.b + 16}" fill="${C.muted}" font-size="11" text-anchor="middle">${Math.round(v * 100)}%</text>`);
    body += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(top)}" y2="${y(top)}" stroke="${C.ink2}" stroke-dasharray="4 4"/>
      <text x="${x(top) - 4}" y="${y(top) + 14}" fill="${C.muted}" font-size="11" text-anchor="end">perfect</text>`;
    bins.forEach(b => {
      body += `<circle class="mark" cx="${x(b.predicted)}" cy="${y(b.observed)}" r="5.5" fill="${C.s1}" stroke="${C.surface}" stroke-width="2"
        ${tip(`<b>A tenth of the test rows</b>${row('Predicted', pct(b.predicted, 1))}${row('Actually resigned', pct(b.observed, 1))}${row('Rows', nice(b.n))}`)}/>`;
    });
    body += `<text x="${(m.l + w - m.r) / 2}" y="${h - 6}" fill="${C.ink2}" font-size="11.5" text-anchor="middle">predicted probability</text>
      <text x="12" y="${(m.t + h - m.b) / 2}" fill="${C.ink2}" font-size="11.5" text-anchor="middle" transform="rotate(-90 12 ${(m.t + h - m.b) / 2})">observed rate</text>`;
    return svg(w, h, body, 'Predicted against observed');
  }

  /* ------------------------------------------------------------- lead time
     Share of resigners already flagged k weeks before they resigned. */
  function leadTime(curve, random, opts = {}) {
    const w = opts.width || 620, h = opts.height || 240, m = { t: 16, r: 70, b: 34, l: 44 };
    const pts = (curve || []).filter(c => c.caught != null).sort((a, b) => b.weeks_before - a.weeks_before);
    if (!pts.length) return empty(w, h);
    const maxW = pts[0].weeks_before;
    const x = scale([maxW, 1], [m.l, w - m.r]), y = scale([0, 1], [h - m.b, m.t]);
    let body = '';
    [0, .25, .5, .75, 1].forEach(v => body += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${v ? C.grid : C.axis}"/>
      <text x="${m.l - 8}" y="${y(v) + 4}" fill="${C.muted}" font-size="11" text-anchor="end">${v * 100}%</text>`);
    body += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(random)}" y2="${y(random)}" stroke="${C.ink2}" stroke-dasharray="4 4"/>
      <text x="${w - m.r + 6}" y="${y(random) + 4}" fill="${C.ink2}" font-size="11.5">random list</text>`;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.weeks_before).toFixed(1)} ${y(p.caught).toFixed(1)}`).join(' ');
    body += `<path d="${d} L${x(1)} ${y(random)} L${x(maxW)} ${y(random)} Z" fill="${C.s1}" opacity=".08"/>
      <path d="${d}" fill="none" stroke="${C.s1}" stroke-width="2" stroke-linejoin="round"/>`;
    const last = pts[pts.length - 1];
    body += `<text x="${w - m.r + 6}" y="${y(last.caught) + 4}" fill="${C.ink}" font-size="11.5" font-weight="500">this model</text>`;
    pts.forEach(p => {
      body += `<text x="${x(p.weeks_before)}" y="${h - m.b + 16}" fill="${C.muted}" font-size="11" text-anchor="middle">${p.weeks_before}</text>
        <circle class="mark" cx="${x(p.weeks_before)}" cy="${y(p.caught)}" r="4.5" fill="${C.s1}" stroke="${C.surface}" stroke-width="2"
          ${tip(`<b>${p.weeks_before} week${p.weeks_before > 1 ? 's' : ''} before resigning</b>${row('On the watchlist', pct(p.caught, 0))}${row('Random list', pct(random, 0))}${row('Resignations checked', nice(p.n))}`)}/>`;
    });
    body += `<text x="${(m.l + w - m.r) / 2}" y="${h - 2}" fill="${C.ink2}" font-size="11.5" text-anchor="middle">weeks before the resignation</text>`;
    return svg(w, h, body, 'Lead time');
  }

  /* --------------------------------------------------------------- forest
     PR-AUC with 95% interval for each candidate model, per horizon. */
  function forest(metrics, opts = {}) {
    const hs = Object.keys(metrics).sort((a, b) => a - b);
    const kinds = ['lgbm', 'logistic', 'blend'];
    const color = { lgbm: C.cat1, logistic: C.cat2, blend: C.cat3 };
    const w = opts.width || 640, rowH = 48, h = hs.length * rowH + 30, m = { l: 66, r: 16 };
    const vals = hs.flatMap(h => kinds.map(k => metrics[h].candidates?.[k]?.pr_auc_ci || [])).flat().filter(v => v != null);
    if (!vals.length) return empty(w, 120);
    const vmax = Math.max(...vals), tk = ticks(0, vmax, w < 420 ? 3 : 5);
    let step = tk.length > 1 ? tk[1] - tk[0] : vmax;
    while (tk[tk.length - 1] < vmax) tk.push(+(tk[tk.length - 1] + step).toFixed(10));
    const top = tk[tk.length - 1];
    const x = scale([0, top], [m.l, w - m.r]);
    let body = '';
    tk.forEach(v => body += `<line x1="${x(v)}" x2="${x(v)}" y1="0" y2="${h - 24}" stroke="${v ? C.grid : C.axis}"/>
      <text x="${x(v)}" y="${h - 8}" fill="${C.muted}" font-size="11" text-anchor="middle">${v.toFixed(2)}</text>`);
    hs.forEach((hz, i) => {
      const y0 = i * rowH + 8;
      body += `<text x="0" y="${y0 + 18}" fill="${C.ink}" font-size="12.5">${hz} days</text>`;
      kinds.forEach((k, j) => {
        const c = metrics[hz].candidates?.[k];
        if (!c) return;
        const yy = y0 + 6 + j * 10, [lo, hi] = c.pr_auc_ci;
        const t = `<b>${hz}-day · ${k}${c.champion ? ' (champion)' : ''}</b>${row('PR-AUC on test', c.pr_auc.toFixed(3))}${row('95% interval', `${lo.toFixed(3)} – ${hi.toFixed(3)}`)}${row('Validation PR-AUC', c.valid_pr_auc.toFixed(3))}${row('Recall in top 15%', pct(c.recall_at_15, 0))}`;
        body += `<g class="mark" ${tip(t)}><rect x="${m.l}" y="${yy - 5}" width="${w - m.l - m.r}" height="10" fill="transparent"/>
          <line x1="${x(lo)}" x2="${x(hi)}" y1="${yy}" y2="${yy}" stroke="${color[k]}" stroke-width="2"/>
          <circle cx="${x(c.pr_auc)}" cy="${yy}" r="${c.champion ? 5 : 3.5}" fill="${c.champion ? color[k] : C.surface}" stroke="${color[k]}" stroke-width="2"/></g>`;
      });
    });
    return svg(w, h, body, 'Model comparison');
  }

  /* ---------------------------------------------------------------- spark */
  function spark(values, opts = {}) {
    const w = opts.width || 120, h = opts.height || 28;
    const v = (values || []).filter(x => x != null);
    if (v.length < 2) return '';
    const max = Math.max(...v), min = Math.min(...v);
    const x = scale([0, v.length - 1], [1, w - 3]), y = scale([min, max === min ? min + 1 : max], [h - 3, 3]);
    const d = v.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join(' ');
    return svg(w, h, `<path d="${d}" fill="none" stroke="${opts.color || C.s1}" stroke-width="1.6"/>
      <circle cx="${x(v.length - 1)}" cy="${y(v[v.length - 1])}" r="2.5" fill="${opts.color || C.s1}"/>`, 'trend');
  }

  /* Charts are drawn at their container's real pixel width, so 11px axis text
     stays 11px on a phone instead of being scaled down with the drawing.
     Views emit slot(fn); App calls mount() after inserting the HTML. */
  let slots = new Map(), seq = 0;
  function reset() { slots = new Map(); }
  function slot(fn, cls = '') {
    const id = 'c' + (++seq);
    slots.set(id, fn);
    return `<div class="cslot ${cls}" data-cslot="${id}"></div>`;
  }
  function mount(root = document) {
    root.querySelectorAll('[data-cslot]').forEach(el => {
      const fn = slots.get(el.dataset.cslot);
      const w = Math.floor(el.clientWidth);
      if (!fn || !w || el._w === w) return;
      el._w = w;
      el.innerHTML = fn(w);
    });
  }

  return { line, retention, contributions, hbars, columns, calibration, leadTime, forest, spark,
           slot, mount, reset, colors: C, syncPalette, esc, nice, pct };
})();
