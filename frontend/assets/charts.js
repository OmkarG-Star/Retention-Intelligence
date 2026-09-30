/* Hand-built SVG charts.
   No charting library: the whole UI ships as three static files with nothing to
   fetch from a CDN, which matters when this runs on a site network behind a
   corporate proxy. Each function returns an SVG string. */

const Chart = (() => {
  /* The palette is read from the stylesheet rather than repeated here, so the
     charts follow whichever theme is active instead of drifting out of step
     with it. Chart.syncPalette() is called again whenever the theme changes. */
  const C = {
    grid: '#D3DBE3', axis: '#6C7E8E', text: '#46586A',
    amber: '#E0A526', navy: '#2E3C96', teal: '#1C7688',
    risk: { Critical: '#B4232A', High: '#B2541F', Medium: '#9A7212', Low: '#1C7A56', Watch: '#1C7688' }
  };

  function syncPalette() {
    const css = getComputedStyle(document.documentElement);
    const read = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
    C.grid = read('--rule', C.grid);
    C.axis = read('--muted', C.axis);
    C.text = read('--text-2', C.text);
    C.amber = read('--amber', C.amber);
    C.navy = read('--navy-lit', C.navy);
    C.teal = read('--teal', C.teal);
    C.risk.Critical = read('--r-crit', C.risk.Critical);
    C.risk.High = read('--r-high', C.risk.High);
    C.risk.Medium = read('--r-med', C.risk.Medium);
    C.risk.Low = read('--r-low', C.risk.Low);
    C.risk.Watch = C.teal;
    return C;
  }

  const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const nice = (v, d = 0) => Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

  function frame(w, h, body, label) {
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${esc(label || 'chart')}"
      preserveAspectRatio="xMidYMid meet">${body}</svg>`;
  }

  function scale(domain, range) {
    const [d0, d1] = domain, [r0, r1] = range;
    const span = (d1 - d0) || 1;
    return v => r0 + ((v - d0) / span) * (r1 - r0);
  }

  /* line / multi-line ------------------------------------------------- */
  function line(series, opts = {}) {
    const w = opts.width || 620, h = opts.height || 190;
    const m = { t: 14, r: 14, b: 26, l: 44 };
    const all = series.flatMap(s => s.points.map(p => p.y)).filter(v => v != null);
    if (!all.length) return empty(w, h);
    const yMax = opts.yMax ?? (Math.max(...all) * 1.15 || 1);
    const yMin = opts.yMin ?? Math.min(0, Math.min(...all));
    const n = Math.max(...series.map(s => s.points.length));
    const x = scale([0, Math.max(n - 1, 1)], [m.l, w - m.r]);
    const y = scale([yMin, yMax], [h - m.b, m.t]);
    let body = '';
    for (let i = 0; i <= 4; i++) {
      const v = yMin + (yMax - yMin) * i / 4, yy = y(v);
      body += `<line x1="${m.l}" x2="${w - m.r}" y1="${yy}" y2="${yy}" stroke="${C.grid}" stroke-width="1"/>
        <text x="${m.l - 7}" y="${yy + 4}" fill="${C.text}" font-size="10" text-anchor="end">${opts.fmt ? opts.fmt(v) : nice(v, 1)}</text>`;
    }
    series.forEach(s => {
      const pts = s.points.map((p, i) => `${x(i)},${y(p.y)}`).join(' ');
      if (s.area) {
        body += `<polygon class="area" points="${x(0)},${y(yMin)} ${pts} ${x(s.points.length - 1)},${y(yMin)}"
          fill="${s.color || C.amber}" opacity=".12"/>`;
      }
      body += `<polyline class="ln" pathLength="1" points="${pts}" fill="none" stroke="${s.color || C.amber}"
        stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"
        ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`;
      if (s.dots !== false) s.points.forEach((p, i) => {
        body += `<circle class="pt" style="--d:${i}" cx="${x(i)}" cy="${y(p.y)}" r="2.6" fill="${s.color || C.amber}"><title>${esc(p.label || '')}: ${nice(p.y, 3)}</title></circle>`;
      });
    });
    const labels = series[0].points;
    const step = Math.ceil(labels.length / 7);
    labels.forEach((p, i) => {
      if (i % step) return;
      body += `<text x="${x(i)}" y="${h - 8}" fill="${C.text}" font-size="10" text-anchor="middle">${esc(p.label || i)}</text>`;
    });
    return frame(w, h, body, opts.label);
  }

  /* survival step curve ------------------------------------------------ */
  function survival(points, opts = {}) {
    const w = opts.width || 480, h = opts.height || 210;
    const m = { t: 14, r: 16, b: 28, l: 42 };
    if (!points || !points.length) return empty(w, h);
    const maxDay = points[points.length - 1].day || 180;
    const x = scale([0, maxDay], [m.l, w - m.r]);
    const lo = Math.min(0.4, Math.min(...points.map(p => p.survival)) - 0.05);
    const y = scale([lo, 1], [h - m.b, m.t]);
    let body = '', d = `M ${x(0)} ${y(1)}`;
    points.forEach(p => { d += ` L ${x(p.day)} ${y(p.survival)}`; });
    for (let i = 0; i <= 4; i++) {
      const v = lo + (1 - lo) * i / 4, yy = y(v);
      body += `<line x1="${m.l}" x2="${w - m.r}" y1="${yy}" y2="${yy}" stroke="${C.grid}"/>
        <text x="${m.l - 7}" y="${yy + 4}" fill="${C.text}" font-size="10" text-anchor="end">${Math.round(v * 100)}%</text>`;
    }
    body += `<path class="area" d="${d} L ${x(maxDay)} ${y(lo)} L ${x(0)} ${y(lo)} Z" fill="${C.teal}" opacity=".12"/>`;
    body += `<path class="ln" pathLength="1" d="${d}" fill="none" stroke="${C.teal}" stroke-width="2.2"/>`;
    [30, 90, 180].filter(dd => dd <= maxDay).forEach(dd => {
      const pt = points.reduce((a, b) => Math.abs(b.day - dd) < Math.abs(a.day - dd) ? b : a);
      body += `<line x1="${x(dd)}" x2="${x(dd)}" y1="${m.t}" y2="${h - m.b}" stroke="${C.grid}" stroke-dasharray="3 3"/>
        <circle class="pt" style="--d:${dd / 10}" cx="${x(pt.day)}" cy="${y(pt.survival)}" r="3.4" fill="${C.amber}"/>
        <text x="${x(dd)}" y="${h - 9}" fill="${C.text}" font-size="10" text-anchor="middle">${dd}d</text>
        <text x="${x(dd)}" y="${y(pt.survival) - 9}" fill="${C.amber}" font-size="10.5" text-anchor="middle">${Math.round(pt.survival * 100)}%</text>`;
    });
    return frame(w, h, body, 'Survival curve');
  }

  /* diverging contribution bars (SHAP) -------------------------------- */
  function contributions(drivers, opts = {}) {
    const rows = drivers.slice(0, opts.limit || 8);
    if (!rows.length) return `<p class="empty">No contributions recorded.</p>`;
    const w = opts.width || 520, rowH = 30, h = rows.length * rowH + 26;
    const max = Math.max(...rows.map(d => Math.abs(d.impact_pct))) || 1;
    const mid = w * 0.52, half = w * 0.40;
    let body = `<line x1="${mid}" x2="${mid}" y1="4" y2="${h - 20}" stroke="${C.grid}"/>`;
    rows.forEach((d, i) => {
      const yy = 6 + i * rowH;
      const len = (Math.abs(d.impact_pct) / max) * half;
      const pos = d.impact_pct >= 0;
      const col = pos ? C.risk.High : C.risk.Low;
      body += `<rect class="bar ${pos ? '' : 'bar-r'}" style="--d:${i}" x="${pos ? mid : mid - len}" y="${yy}" width="${Math.max(len, 1.5)}" height="13" rx="2" fill="${col}"/>`;
      body += `<text x="${pos ? mid - 8 : mid + 8}" y="${yy + 11}" fill="${C.text}" font-size="11.5"
        text-anchor="${pos ? 'end' : 'start'}">${esc(d.label)}</text>`;
      body += `<text x="${pos ? mid + len + 6 : mid - len - 6}" y="${yy + 11}" fill="${col}" font-size="11.5"
        text-anchor="${pos ? 'start' : 'end'}">${d.impact_pct > 0 ? '+' : ''}${d.impact_pct.toFixed(1)}</text>`;
      if (d.value != null) body += `<text x="${pos ? mid - 8 : mid + 8}" y="${yy + 24}" fill="${C.axis}" font-size="10"
        text-anchor="${pos ? 'end' : 'start'}">${esc(d.value)}</text>`;
    });
    body += `<text x="${mid + 6}" y="${h - 4}" fill="${C.axis}" font-size="10">raises risk</text>
      <text x="${mid - 6}" y="${h - 4}" fill="${C.axis}" font-size="10" text-anchor="end">lowers risk</text>`;
    return frame(w, h, body, 'Risk contributions');
  }

  /* horizontal bars ---------------------------------------------------- */
  function bars(rows, opts = {}) {
    if (!rows.length) return `<p class="empty">Nothing to show.</p>`;
    const w = opts.width || 520, rowH = opts.rowH || 26, h = rows.length * rowH + 10;
    const max = Math.max(...rows.map(r => r.value)) || 1;
    const labelW = opts.labelW || 170;
    let body = '';
    rows.forEach((r, i) => {
      const yy = 6 + i * rowH;
      const len = (r.value / max) * (w - labelW - 60);
      body += `<text x="0" y="${yy + 11}" fill="${C.text}" font-size="11.5">${esc(r.label)}</text>`;
      body += `<rect class="bar" style="--d:${i}" x="${labelW}" y="${yy + 1}" width="${Math.max(len, 2)}" height="12" rx="2"
        fill="${r.color || C.navy}"><title>${esc(r.label)}: ${esc(r.display || r.value)}</title></rect>`;
      body += `<text x="${labelW + len + 7}" y="${yy + 11}" fill="${C.text}" font-size="11">${esc(r.display ?? nice(r.value, 0))}</text>`;
    });
    return frame(w, h, body, opts.label);
  }

  /* calibration ------------------------------------------------------- */
  function calibration(bins, opts = {}) {
    const w = opts.width || 320, h = opts.height || 300, m = 38;
    if (!bins || !bins.length) return empty(w, h);
    const max = Math.max(...bins.map(b => Math.max(b.predicted, b.observed)), 0.05) * 1.1;
    const x = scale([0, max], [m, w - 14]);
    const y = scale([0, max], [h - m, 14]);
    let body = `<line x1="${x(0)}" y1="${y(0)}" x2="${x(max)}" y2="${y(max)}" stroke="${C.grid}" stroke-dasharray="4 4"/>`;
    bins.forEach(b => {
      body += `<circle class="pt" style="--d:${bins.indexOf(b)}" cx="${x(b.predicted)}" cy="${y(b.observed)}" r="${Math.min(3 + Math.sqrt(b.n) / 9, 9)}"
        fill="${C.amber}" opacity=".8"><title>predicted ${(b.predicted * 100).toFixed(1)}% · observed ${(b.observed * 100).toFixed(1)}% · n=${b.n}</title></circle>`;
    });
    body += `<text x="${w / 2}" y="${h - 6}" fill="${C.text}" font-size="10.5" text-anchor="middle">predicted</text>
      <text x="12" y="${h / 2}" fill="${C.text}" font-size="10.5" text-anchor="middle" transform="rotate(-90 12 ${h / 2})">observed</text>
      <line x1="${m}" y1="${h - m}" x2="${w - 14}" y2="${h - m}" stroke="${C.axis}" opacity=".5"/>
      <line x1="${m}" y1="${h - m}" x2="${m}" y2="14" stroke="${C.axis}" opacity=".5"/>`;
    return frame(w, h, body, 'Calibration');
  }

  /* sparkline ---------------------------------------------------------- */
  function spark(values, opts = {}) {
    const w = opts.width || 90, h = opts.height || 22;
    if (!values || values.length < 2) return '';
    const max = Math.max(...values), min = Math.min(...values);
    const x = scale([0, values.length - 1], [1, w - 1]);
    const y = scale([min, max === min ? min + 1 : max], [h - 2, 2]);
    const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const rising = values[values.length - 1] >= values[0];
    return frame(w, h, `<polyline class="ln" pathLength="1" points="${pts}" fill="none" stroke="${rising ? C.risk.High : C.risk.Low}" stroke-width="1.5"/>`, 'trend');
  }

  /* stacked cohort columns --------------------------------------------- */
  function columns(rows, opts = {}) {
    if (!rows.length) return `<p class="empty">Nothing to show.</p>`;
    const w = opts.width || 560, h = opts.height || 200, m = { t: 12, b: 42, l: 34, r: 8 };
    const max = Math.max(...rows.map(r => r.value)) || 1;
    const bw = (w - m.l - m.r) / rows.length;
    const y = scale([0, max], [h - m.b, m.t]);
    let body = '';
    for (let i = 0; i <= 3; i++) {
      const v = max * i / 3, yy = y(v);
      body += `<line x1="${m.l}" x2="${w - m.r}" y1="${yy}" y2="${yy}" stroke="${C.grid}"/>
        <text x="${m.l - 6}" y="${yy + 4}" fill="${C.text}" font-size="10" text-anchor="end">${nice(v)}</text>`;
    }
    rows.forEach((r, i) => {
      const bx = m.l + i * bw + bw * 0.18, bwidth = bw * 0.64;
      body += `<rect class="col" style="--d:${i}" x="${bx}" y="${y(r.value)}" width="${bwidth}" height="${Math.max(h - m.b - y(r.value), 1)}"
        rx="2" fill="${r.color || C.navy}"><title>${esc(r.label)}: ${nice(r.value)}</title></rect>`;
      if (r.sub != null) body += `<rect class="col" style="--d:${i + 1}" x="${bx}" y="${y(r.sub)}" width="${bwidth}" height="${Math.max(h - m.b - y(r.sub), 1)}"
        rx="2" fill="${C.risk.Critical}" opacity=".85"><title>${esc(r.label)} absconding: ${nice(r.sub)}</title></rect>`;
      body += `<text x="${bx + bwidth / 2}" y="${y(r.value) - 5}" fill="${C.text}" font-size="10.5" text-anchor="middle">${nice(r.value)}</text>`;
      const words = String(r.label).split(' ');
      body += `<text x="${bx + bwidth / 2}" y="${h - 24}" fill="${C.text}" font-size="10" text-anchor="middle">${esc(words[0])}</text>
        <text x="${bx + bwidth / 2}" y="${h - 12}" fill="${C.axis}" font-size="10" text-anchor="middle">${esc(words.slice(1).join(' '))}</text>`;
    });
    return frame(w, h, body, opts.label);
  }

  /* ring gauge ---------------------------------------------------------- */
  function ring(value, opts = {}) {
    const size = opts.size || 96, sw = opts.stroke || 9, r = (size - sw) / 2, c = size / 2;
    const v = Math.max(0, Math.min(1, (value || 0) / (opts.max || 1)));
    const col = opts.color || C.amber;
    return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
      aria-label="${esc(opts.label || 'gauge')}">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${C.grid}" stroke-width="${sw}" opacity=".6"/>
      <circle class="ring-arc" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="${sw}"
        stroke-linecap="round" pathLength="100" stroke-dasharray="${(v * 100).toFixed(2)} 100"
        transform="rotate(-90 ${c} ${c})"/>
      <text x="${c}" y="${c + 1}" text-anchor="middle" dominant-baseline="middle" fill="currentColor"
        font-size="${size * 0.21}" font-weight="700">${esc(opts.text ?? Math.round(v * 100) + '%')}</text>
    </svg>`;
  }

  function empty(w, h) {
    return frame(w, h, `<text x="${w / 2}" y="${h / 2}" fill="${C.axis}" font-size="12" text-anchor="middle">No data yet</text>`, 'empty');
  }

  return { line, survival, contributions, bars, calibration, spark, columns, ring,
           colors: C, syncPalette, esc, nice };
})();
