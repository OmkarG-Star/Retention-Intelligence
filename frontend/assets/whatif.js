/* What-if simulator on the employee page.

   Every slider change is debounced and sent to POST /api/employees/{id}/whatif,
   which re-projects the person's own weekly history 4 to 13 weeks forward twice
   (unchanged, and with the levers) and scores both with the live models. The
   panel compares the two projections, never "today" against "changed", so the
   gap is the effect of the levers alone and not of the person ageing. */

const WhatIf = (() => {
  const esc = Chart.esc, pct = Chart.pct, num = Chart.nice;
  const I = (n, s = 16) => Icons.get(n, s);
  const HZ = [7, 15, 30, 90, 180];
  const GROUPS = [
    ['Workload', ['overtime', 'night_shift', 'absence']],
    ['Pay', ['raise', 'pay_delay']],
    ['Growth', ['promote', 'training']],
    ['Wellbeing', ['engagement', 'accommodation']],
  ];
  // what "Suggested plan" sets, per area flagged by the person's own drivers
  const PLAN = {
    Workload: c => ({ overtime: Math.min(c.overtime, 30), night_shift: Math.min(c.night_shift, 20) }),
    Pay: c => ({ pay_delay: 0, raise: 8 }),
    Career: () => ({ training: 1, promote: 1 }),
    Logistics: c => (c.accommodation ? {} : { accommodation: 1 }),
    Attendance: c => ({ absence: Math.min(c.absence, 0.5) }),
    Sentiment: c => ({ engagement: Math.max(c.engagement, 7) }),
  };

  let st = null;

  function fmtVal(lv, v) {
    if (lv.kind === 'promote' || lv.kind === 'toggle') return v >= 0.5 ? 'Yes' : 'No';
    const d = lv.step < 1 ? 1 : 0;
    return `${num(v, d)}${lv.unit === '%' ? '%' : ''}`;
  }

  function leverRow(lv) {
    const v = st.values[lv.key], cur = lv.current, changed = Math.abs(v - cur) > 1e-9;
    const unit = lv.unit && lv.unit !== '%' ? `<small>${esc(lv.unit)}</small>` : '';
    if (lv.kind === 'promote' || lv.kind === 'toggle') {
      const disabled = lv.kind === 'toggle' && cur >= 1;
      return `<div class="lever ${changed ? 'changed' : ''}" data-lever="${lv.key}">
        <div class="lv-top"><label for="lv-${lv.key}">${esc(lv.label)}</label>
          <span class="lv-val">${disabled ? '<span class="sub">already provided</span>' : ''}</span></div>
        <label class="switch ${disabled ? 'off' : ''}"><input type="checkbox" id="lv-${lv.key}" ${v >= 0.5 ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <span class="knob"></span><span class="sw-text">${esc(lv.hint)}</span></label>
      </div>`;
    }
    const at = ((cur - lv.lo) / (lv.hi - lv.lo)) * 100;
    return `<div class="lever ${changed ? 'changed' : ''}" data-lever="${lv.key}">
      <div class="lv-top"><label for="lv-${lv.key}">${esc(lv.label)}</label>
        <span class="lv-val"><b>${fmtVal(lv, v)}</b>${unit}${changed ? `<button class="lv-reset" data-reset="${lv.key}" title="Back to current (${fmtVal(lv, cur)})" aria-label="Reset ${esc(lv.label)}">${I('x', 12)}</button>` : ''}</span></div>
      <div class="range-wrap" style="--at:${Math.max(0, Math.min(100, at))}%">
        <input type="range" id="lv-${lv.key}" min="${lv.lo}" max="${lv.hi}" step="${lv.step}" value="${v}"
          style="--fill:${((v - lv.lo) / (lv.hi - lv.lo)) * 100}%" aria-describedby="lv-${lv.key}-hint">
        ${lv.kind === 'level' ? `<span class="now-tick" title="Today: ${fmtVal(lv, cur)}"></span>` : ''}
      </div>
      <div class="lv-hint" id="lv-${lv.key}-hint">${esc(lv.hint)}${lv.kind === 'level' ? ` · today ${fmtVal(lv, cur)}` : ''}</div>
    </div>`;
  }

  function resultHtml(r) {
    const b = r.baseline['90'], s = r.scenario['90'], d = (s - b) * 100;
    const rel = b > 0 ? (s - b) / b : 0;
    const any = Object.keys(changes()).length > 0;
    const cls = !any || Math.abs(d) < 0.05 ? 'flat' : d < 0 ? 'down' : 'up';
    const maxH = Math.max(...HZ.map(h => Math.max(r.baseline[h] || 0, r.scenario[h] || 0)), 0.01);
    const moved = (r.moved || []).filter(m => Math.abs(m.logodds) >= 0.01);
    const maxM = Math.max(...moved.map(m => Math.abs(m.logodds)), 0.01);
    const strength = a => a >= 0.4 ? 'strongly' : a >= 0.12 ? 'moderately' : 'slightly';
    return `
      <div class="wi-headline ${cls}">
        <div class="wi-k">90-day risk in ${r.weeks} weeks</div>
        <div class="wi-nums"><span class="from">${pct(b, 1)}</span>${I('arrowRight', 18)}<span class="to">${pct(s, 1)}</span></div>
        <div class="wi-delta">${!any ? 'Move a lever to see its effect' :
          Math.abs(d) < 0.05 ? 'No meaningful change' :
          `${d < 0 ? '−' : '+'}${num(Math.abs(d), 1)} points <span>(${d < 0 ? '' : '+'}${num(rel * 100, 0)}% relative)</span>`}</div>
      </div>
      <div class="wi-ref sub">Today ${pct(st.today, 1)}. If this week simply repeats for ${r.weeks} weeks: ${pct(b, 1)}.${
        Math.abs(st.today - b) >= 0.05 ? ` <span class="wi-why" data-tip="The model reads recent trends as well as levels. Repeating this week holds every signal flat, so a recent slide (or recovery) stops counting. The gap between today and this line is that trend; the gap between this line and the result is your change alone.">${I('info', 13)} Why different from today?</span>` : ''}</div>
      <div class="wi-sec"><h4>Every horizon</h4>
        <div class="wi-bars">${HZ.map(h => `
          <div class="wi-bar" data-tip-h="${esc(`<b>${h} days</b><div class='t-row'><span>If this week repeats</span><b>${pct(r.baseline[h])}</b></div><div class='t-row'><span>With the plan</span><b>${pct(r.scenario[h])}</b></div>`)}">
            <span class="lbl">${h}d</span>
            <span class="pair"><i class="base" style="width:${(r.baseline[h] / maxH) * 100}%"></i><i class="scen" style="width:${(r.scenario[h] / maxH) * 100}%"></i></span>
            <b>${pct(r.scenario[h], 1)}</b></div>`).join('')}
        </div>
        <div class="wi-key"><span><i class="base"></i>If this week repeats</span><span><i class="scen"></i>With the plan</span></div>
      </div>
      <div class="wi-sec"><h4>What moved, in the 90-day model</h4>
        ${moved.length ? `<div class="wi-moved">${moved.slice(0, 6).map(m => `
          <div class="mv ${m.logodds < 0 ? 'down' : 'up'}" data-tip-h="${esc(`<b>${m.area}</b><div class='t-row'><span>Change in log-odds</span><b>${m.logodds > 0 ? '+' : ''}${m.logodds.toFixed(3)}</b></div>`)}">
            <span class="nm">${esc(m.area)}</span>
            <span class="track"><i style="width:${(Math.abs(m.logodds) / maxM) * 100}%"></i></span>
            <span class="how">${m.logodds < 0 ? 'lowers' : 'raises'} ${strength(Math.abs(m.logodds))}</span></div>`).join('')}</div>`
          : `<p class="sub">${any ? 'The model barely reacts to this change for this person.' : 'Nothing changed yet.'}</p>`}
      </div>
      <p class="wi-caveat">${I('info', 14)}<span>${esc(r.caveat)}</span></p>`;
  }

  function changes() {
    const out = {};
    if (!st.levers) return out;
    for (const lv of st.levers) if (Math.abs(st.values[lv.key] - lv.current) > 1e-9) out[lv.key] = st.values[lv.key];
    return out;
  }

  function paintLevers() {
    const box = st.root.querySelector('.wi-levers');
    const byKey = Object.fromEntries(st.levers.map(l => [l.key, l]));
    box.innerHTML = GROUPS.map(([g, keys]) => `<fieldset><legend>${g}</legend>${keys.map(k => byKey[k] ? leverRow(byKey[k]) : '').join('')}</fieldset>`).join('');
    const n = Object.keys(changes()).length;
    st.root.querySelector('[data-wi="count"]').textContent = n ? `${n} change${n > 1 ? 's' : ''}` : 'No changes';
    st.root.querySelector('[data-wi="reset"]').disabled = !n;
  }

  function paintResult(r) {
    const out = st.root.querySelector('.wi-result');
    out.classList.remove('busy');
    out.innerHTML = resultHtml(r);
    // narrow screens: the result sits below the levers, so a sticky pill keeps it in view
    const b = r.baseline['90'], s = r.scenario['90'], d = (s - b) * 100, any = Object.keys(changes()).length > 0;
    const pill = st.root.querySelector('.wi-float');
    pill.className = 'wi-float ' + (!any || Math.abs(d) < 0.05 ? 'flat' : d < 0 ? 'down' : 'up');
    pill.innerHTML = `<span>90-day risk</span><b>${pct(b, 1)}</b>${I('arrowRight', 14)}<b class="to">${pct(s, 1)}</b>${any && Math.abs(d) >= 0.05 ? `<em>${d < 0 ? '−' : '+'}${num(Math.abs(d), 1)} pts</em>` : ''}`;
  }

  let timer = null, seq = 0;
  function schedule(delay = 220) {
    clearTimeout(timer);
    st.root.querySelector('.wi-result').classList.add('busy');
    timer = setTimeout(run, delay);
  }
  async function run() {
    const my = ++seq;
    try {
      const r = await App.api(`/api/employees/${encodeURIComponent(st.id)}/whatif`, {
        method: 'POST', body: JSON.stringify({ changes: changes(), weeks: st.weeks }) });
      if (my !== seq || !st) return;            // a newer request superseded this one
      if (!st.levers) { st.levers = r.levers; st.values = Object.fromEntries(r.levers.map(l => [l.key, l.current])); paintLevers(); }
      st.last = r;
      paintResult(r);
    } catch (e) {
      if (my !== seq || !st) return;
      st.root.querySelector('.wi-result').innerHTML = `<p class="sub">The simulator could not run: ${esc(e.message || e)}</p>`;
    }
  }

  function applyPlan() {
    const cur = Object.fromEntries(st.levers.map(l => [l.key, l.current]));
    let next = {};
    for (const a of st.actions || []) if (PLAN[a.category]) next = { ...next, ...PLAN[a.category](cur) };
    if (!Object.keys(next).length) { App.toast('No factor is pushing risk up, so there is no plan to suggest.'); return; }
    st.values = { ...cur };
    for (const [k, v] of Object.entries(next)) st.values[k] = v;
    paintLevers(); schedule(0);
  }

  function mount(root, id, actions, today) {
    st = { root, id, actions, today, weeks: 8, levers: null, values: {} };
    root.innerHTML = `
      <div class="panel-head"><div><h2>${I('sliders', 16)} Plan a retention move</h2>
        <p>Try changes to workload, pay and growth and see how the model expects this person's risk to respond.</p></div>
        <div class="row">
          <div class="seg" role="group" aria-label="How long the change holds">${[4, 8, 13].map(w => `<button data-weeks="${w}" class="${w === 8 ? 'on' : ''}">${w} weeks</button>`).join('')}</div>
          ${(actions || []).length ? `<button class="btn btn-sm" data-wi="plan">${I('spark', 15)} Suggested plan</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-wi="reset" disabled>${I('refresh', 15)} Reset</button>
        </div></div>
      <div class="wi-grid">
        <div><div class="wi-count sub" data-wi="count">No changes</div><div class="wi-levers"><div class="sk" style="height:320px;grid-column:1/-1"></div></div></div>
        <div class="wi-result busy"><div class="sk" style="height:320px"></div></div>
      </div>
      <div class="wi-float flat" aria-live="polite"></div>`;

    root.addEventListener('input', e => {
      const row = e.target.closest('[data-lever]');
      if (!row || !st.levers || e.target.type !== 'range') return;
      st.values[row.dataset.lever] = Number(e.target.value);
      // update this row in place so the thumb is not re-created under the pointer
      const lv = st.levers.find(l => l.key === row.dataset.lever);
      e.target.style.setProperty('--fill', ((e.target.value - lv.lo) / (lv.hi - lv.lo)) * 100 + '%');
      row.querySelector('.lv-val b').textContent = fmtVal(lv, st.values[lv.key]);
      row.classList.toggle('changed', Math.abs(st.values[lv.key] - lv.current) > 1e-9);
      const n = Object.keys(changes()).length;
      root.querySelector('[data-wi="count"]').textContent = n ? `${n} change${n > 1 ? 's' : ''}` : 'No changes';
      root.querySelector('[data-wi="reset"]').disabled = !n;
      schedule();
    });
    root.addEventListener('change', e => {
      const row = e.target.closest('[data-lever]');
      if (!row || !st.levers) return;
      if (e.target.type === 'checkbox') st.values[row.dataset.lever] = e.target.checked ? 1 : 0;
      paintLevers(); schedule(0);
    });
    root.addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t || !st.levers) return;
      if (t.dataset.reset) { const lv = st.levers.find(l => l.key === t.dataset.reset); st.values[lv.key] = lv.current; paintLevers(); schedule(0); }
      else if (t.dataset.weeks) { st.weeks = +t.dataset.weeks; root.querySelectorAll('[data-weeks]').forEach(b => b.classList.toggle('on', b === t)); schedule(0); }
      else if (t.dataset.wi === 'reset') { st.values = Object.fromEntries(st.levers.map(l => [l.key, l.current])); paintLevers(); schedule(0); }
      else if (t.dataset.wi === 'plan') applyPlan();
    });
    run();
  }

  function unmount() { st = null; clearTimeout(timer); }

  return { mount, unmount };
})();
