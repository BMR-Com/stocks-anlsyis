/* Seasonality: average / median seasonal path, current and past years overlaid, % of years up,
   monthly heatmap with stats, day-of-week stats, custom date-window table and a scan of the
   strongest seasonal windows. Works for any symbol or formula (spreads use point changes). */
"use strict";
const SEAS = (() => {
  const L = LightweightCharts;
  const BASE = Date.UTC(2001, 0, 1) / 1000, DAY = 86400;
  const PAL = ["#B98CD0", "#4FB0A5", "#E0975A", "#8C7BE0", "#E36FA8", "#9BC53D", "#6EC1E4", "#F2C14E"];
  let built = false, root, chart = null;
  let S = { sym: null, look: 10, start: 0, avg: true, med: true, detrend: false, cur: true, prev: false, extra: [] };
  let D = null; // { s, yp, years, curY, sa }

  const $ = id => document.getElementById(id);
  const startDoyOf = m => m ? BMR.doy(`2001-${String(m + 1).padStart(2, "0")}-01`) : 0;
  function build() {
    if (built) return; built = true;
    root = $("tab-season");
    root.innerHTML = `
    <div class="ctrls">
      <input id="sSym" class="pc-in" list="sList" placeholder="Symbol or formula" spellcheck="false"><datalist id="sList"></datalist>
      <span class="lbl">Lookback</span>
      <div class="seg sm" id="sLook">${[5, 10, 15, 20, 0].map(n => `<button data-n="${n}">${n || "All"}</button>`).join("")}</div>
      <span class="lbl">Year starts</span>
      <select id="sStart">${BMR.MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join("")}</select>
      <span class="chip" data-o="avg">Average</span><span class="chip" data-o="med">Median</span>
      <span class="chip" data-o="cur">This year</span><span class="chip" data-o="prev">Last year</span>
      <span class="chip" data-o="detrend" title="Remove the average yearly drift so only the seasonal shape is left">Detrend</span>
      <span class="srcbadge" id="sCap" style="margin-left:auto"></span>
    </div>
    <div class="fgrid" id="sTiles" style="margin-bottom:12px"></div>
    <div class="panel">
      <h2 id="sTitle">Seasonal path</h2><p class="cap" id="sCapt"></p>
      <div class="pc-chart" id="sChart" style="height:460px;position:relative"></div>
      <div class="ctrls" id="sYears" style="margin-top:10px"></div>
    </div>
    <div class="panel"><h2>Monthly returns</h2><p class="cap" id="sMCap"></p><div style="overflow-x:auto"><table id="sMonth" class="heat"></table></div></div>
    <div class="two">
      <div class="panel"><h2>Date window</h2><p class="cap">Return from the first close on or after the start date to the last close on or before the end date, each year. The end can fall in the next year.</p>
        <div class="ctrls"><span class="lbl">From</span><input id="sFrom" class="pc-in sm" placeholder="MM-DD"><span class="lbl">To</span><input id="sTo" class="pc-in sm" placeholder="MM-DD"><button class="chip" id="sGo">Run</button></div>
        <div id="sWinSum" class="fgrid" style="grid-template-columns:repeat(4,1fr);margin-bottom:8px"></div>
        <div style="max-height:420px;overflow:auto"><table id="sWin"></table></div></div>
      <div class="panel"><h2>Strongest seasonal windows</h2><p class="cap">Windows of 2 to 13 weeks with the most consistent direction over the lookback. Click a row to load it into the date window.</p>
        <div style="max-height:520px;overflow:auto"><table id="sScan"></table></div></div>
    </div>
    <div class="two">
      <div class="panel"><h2>Day of week</h2><p class="cap" id="sDowCap"></p><table id="sDow"></table></div>
      <div class="panel"><h2>Month statistics</h2><p class="cap">Over the lookback years.</p><table id="sMStat"></table></div>
    </div>`;
    BMR.index().then(() => { $("sList").innerHTML = BMR.symbolList().map(x => `<option value="${BMR.esc(x.s)}">${BMR.esc(x.n || x.g)}</option>`).join(""); });
    const go = () => { const v = $("sSym").value.trim(); if (v) open(v); };
    $("sSym").addEventListener("change", go); $("sSym").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    root.querySelectorAll("#sLook button").forEach(b => b.onclick = () => { S.look = +b.dataset.n; refresh(); });
    $("sStart").onchange = e => { S.start = +e.target.value; compute(); refresh(); };
    root.querySelectorAll("[data-o]").forEach(c => c.onclick = () => { const k = c.dataset.o; S[k] = !S[k]; if (k === "detrend") compute(); refresh(); });
    $("sGo").onclick = runWindow;
    [$("sFrom"), $("sTo")].forEach(x => x.addEventListener("keydown", e => { if (e.key === "Enter") runWindow(); }));
    const t = new Date(), t2 = new Date(Date.now() + 30 * 864e5), md = d => d.toISOString().slice(5, 10);
    $("sFrom").value = md(t); $("sTo").value = md(t2);
  }
  function sync() {
    root.querySelectorAll("#sLook button").forEach(b => b.classList.toggle("on", +b.dataset.n === S.look));
    root.querySelectorAll("[data-o]").forEach(c => c.classList.toggle("on", !!S[c.dataset.o]));
    $("sStart").value = S.start;
  }
  async function open(sym) {
    build();
    sym = sym.trim();
    if (!/[+*\/()\s]/.test(sym) && (!sym.includes("-") || BMR.known().has(sym.toUpperCase()))) sym = sym.toUpperCase();
    S.sym = sym; S.extra = []; $("sSym").value = sym;
    try { if (typeof seasSym !== "undefined") seasSym = sym; if (location.hash.startsWith("#season")) history.replaceState(null, "", "#season/" + encodeURIComponent(sym)); } catch (e) { }
    $("sCap").textContent = "loading…";
    try { D = { s: await BMR.evaluate(sym) }; }
    catch (e) { $("sCap").textContent = String(e.message || e); D = null; return; }
    compute(); refresh();
  }
  function compute() {
    if (!D) return;
    D.yp = BMR.yearPaths(D.s, { startDoy: startDoyOf(S.start) });
    const ys = Object.keys(D.yp.paths).map(Number).sort((a, b) => a - b);
    D.curY = ys.at(-1);
    D.complete = ys.filter(y => y !== D.curY && D.yp.paths[y].lastDay >= 300);
  }
  const lookYears = () => S.look ? D.complete.slice(-S.look) : D.complete;
  const unit = () => D.yp.additive ? "" : "%";
  const f = (x, d = 2) => D.yp.additive ? BMR.sgn(x, d) : BMR.pct(x, d === 2 ? 1 : d);
  const chg = (a, b) => D.yp.additive ? b - a : ((1 + b / 100) / (1 + a / 100) - 1) * 100;
  const tl = d => BASE + d * DAY;
  const lab = d => BMR.doyLabel((d + startDoyOf(S.start)) % 365);
  function yLabel(y) { return S.start ? `${y}/${String((y + 1) % 100).padStart(2, "0")}` : String(y); }

  function refresh() {
    if (!D) return;
    sync();
    const years = lookYears();
    const sa = BMR.seasonalAverage(D.yp, years, { detrend: S.detrend });
    D.sa = sa;
    const m = BMR.meta(S.sym);
    $("sCap").textContent = `${D.s.t[0]} → ${D.s.t.at(-1)} · ${D.s.src}${D.s.expr ? " · formula" : ""}`;
    $("sTitle").textContent = `${S.sym}${m && m.n ? " · " + m.n : ""} — seasonal path`;
    $("sCapt").textContent = `${D.yp.additive ? "Change in points" : "% change"} from the last close before ${BMR.MONTHS[S.start]} 1 · ${sa.years.length} complete years (${sa.years[0] ?? "—"}–${sa.years.at(-1) ?? "—"})${S.detrend ? " · detrended" : ""}. Lower pane: share of those years trading above the start level on each day.`;
    drawChart(sa);
    tiles(sa);
    yearChips(years);
    monthly(years);
    dow(years);
    runWindow();
    scan(years);
  }
  function drawChart(sa) {
    if (chart) { chart.remove(); chart = null; }
    const el = $("sChart");
    chart = L.createChart(el, {
      autoSize: true, layout: { background: { type: "solid", color: "#0F1713" }, textColor: "#7C8E85", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11, panes: { separatorColor: "#22302A" } },
      grid: { vertLines: { color: "rgba(255,255,255,.045)" }, horzLines: { color: "rgba(255,255,255,.045)" } },
      rightPriceScale: { borderColor: "#22302A" }, timeScale: { borderColor: "#22302A", fixLeftEdge: true, fixRightEdge: true, tickMarkFormatter: t => lab(Math.round((t - BASE) / DAY)) },
      localization: { timeFormatter: t => lab(Math.round((t - BASE) / DAY)), priceFormatter: p => D.yp.additive ? BMR.fmt(p, Math.abs(p) < 10 ? 3 : 2) : p.toFixed(1) + "%" },
      crosshair: { mode: L.CrosshairMode.Normal }
    });
    const line = (arr, o, upto = 365, pane = 0) => { const s = chart.addSeries(L.LineSeries, { priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3, ...o }, pane); s.setData(arr.slice(0, upto + 1).map((v, d) => v == null ? null : { time: tl(d), value: v }).filter(Boolean)); return s; };
    const zero = line(Array(366).fill(0), { color: "rgba(255,255,255,.12)", lineWidth: 1, lastValueVisible: false, crosshairMarkerVisible: false });
    if (S.avg) line(sa.avg, { color: "#D2A93F", lineWidth: 2.5, title: "avg" });
    if (S.med) line(sa.med, { color: "#5AA9E6", lineWidth: 1.6, lineStyle: 2, title: "median" });
    S.extra.forEach((y, k) => { const p = D.yp.paths[y]; if (p) line(p.v, { color: PAL[k % PAL.length], lineWidth: 1.2, title: yLabel(y) }, p.lastDay); });
    if (S.prev && D.yp.paths[D.curY - 1]) line(D.yp.paths[D.curY - 1].v, { color: "#7C8E85", lineWidth: 1.3, title: yLabel(D.curY - 1) }, D.yp.paths[D.curY - 1].lastDay);
    if (S.cur && D.yp.paths[D.curY]) {
      const p = D.yp.paths[D.curY];
      line(p.v, { color: "#E7EDE9", lineWidth: 2.2, title: yLabel(D.curY) }, p.lastDay);
      // average path projected from today, anchored at today's level
      const base = sa.avg[p.lastDay];
      if (S.avg && base != null && p.lastDay < 365) {
        const proj = sa.avg.map((v, d) => d < p.lastDay || v == null ? null : p.v[p.lastDay] + (D.yp.additive ? v - base : ((1 + v / 100) / (1 + base / 100) * (1 + p.v[p.lastDay] / 100) - 1) * 100 - p.v[p.lastDay]));
        const s = chart.addSeries(L.LineSeries, { color: "rgba(210,169,63,.55)", lineWidth: 1.4, lineStyle: 1, priceLineVisible: false, lastValueVisible: false, title: "" });
        s.setData(proj.map((v, d) => v == null ? null : { time: tl(d), value: v }).filter(Boolean));
      }
    }
    const h = chart.addSeries(L.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "custom", formatter: x => x.toFixed(0) + "%" } }, 1);
    h.setData(sa.up.map((v, d) => v == null ? null : { time: tl(d), value: v, color: v >= 50 ? `rgba(52,194,137,${0.25 + (v - 50) / 90})` : `rgba(224,106,80,${0.25 + (50 - v) / 90})` }).filter(Boolean));
    h.createPriceLine({ price: 50, color: "rgba(255,255,255,.25)", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
    try { chart.panes()[1].setStretchFactor(0.28); } catch (e) { }
    chart.timeScale().fitContent();
  }
  function tiles(sa) {
    const p = D.yp.paths[D.curY], t = [];
    if (p) {
      const dd = p.lastDay, cur = p.v[dd], av = sa.avg[dd];
      const rest = sa.years.map(y => chg(D.yp.paths[y].v[dd], D.yp.paths[y].v[365] ?? D.yp.paths[y].v[D.yp.paths[y].lastDay]));
      const st = BMR.stats(rest);
      // correlation of this year's path with the average so far
      const xs = [], ys = []; for (let d = 0; d <= dd; d++) if (sa.avg[d] != null) { xs.push(p.v[d]); ys.push(sa.avg[d]); }
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sxx = 0, syy = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
      const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
      t.push(["This year to date", f(cur), BMR.cls(cur)], ["Seasonal avg to date", f(av), BMR.cls(av)],
        ["Avg rest of year", f(st && st.mean), BMR.cls(st && st.mean)], ["Years up, rest of year", st ? st.win.toFixed(0) + "%" : "—", st ? (st.win >= 60 ? "pos" : st.win <= 40 ? "neg" : "flat") : "flat"],
        ["Median rest of year", f(st && st.med), BMR.cls(st && st.med)], ["Track vs avg (corr.)", r == null ? "—" : r.toFixed(2), r > 0.6 ? "pos" : r < 0 ? "neg" : "flat"],
        ["Years used", String(sa.years.length), "flat"], ["As of", p.last, "flat"]);
    }
    $("sTiles").innerHTML = t.map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join("");
  }
  function yearChips(years) {
    const all = Object.keys(D.yp.paths).map(Number).filter(y => y !== D.curY).sort((a, b) => b - a).slice(0, 40);
    $("sYears").innerHTML = `<span class="lbl">Overlay years</span>` + all.map(y => `<span class="chip ${S.extra.includes(y) ? "on" : ""} ${years.includes(y) ? "" : "dim"}" data-y="${y}">${yLabel(y)}</span>`).join("") +
      (S.extra.length ? `<span class="chip" id="sClrY">Clear</span>` : "");
    $("sYears").querySelectorAll("[data-y]").forEach(c => c.onclick = () => { const y = +c.dataset.y; S.extra = S.extra.includes(y) ? S.extra.filter(x => x !== y) : [...S.extra, y]; refresh(); });
    const c = $("sClrY"); if (c) c.onclick = () => { S.extra = []; refresh(); };
  }
  function monthly(years) {
    const mt = BMR.monthlyTable(D.s), all = Object.keys(mt.mm).map(Number).sort((a, b) => b - a);
    const sc = (() => { const v = []; all.forEach(y => Object.values(mt.mm[y]).forEach(x => v.push(Math.abs(x.r)))); v.sort((a, b) => a - b); return v[Math.floor(v.length * 0.9)] || 1; })();
    const look = new Set(years.length ? years.concat([D.curY]) : all);
    const showY = all.filter(y => look.has(y) || !S.look);
    const ff = x => x == null ? "" : D.yp.additive ? BMR.sgn(x, Math.abs(x) < 10 ? 2 : 1) : (x > 0 ? "+" : "") + x.toFixed(1);
    let h = `<thead><tr><th>Year</th>${BMR.MONTHS.map(m => `<th>${m}</th>`).join("")}<th>Year</th></tr></thead><tbody>`;
    showY.forEach(y => {
      h += `<tr><td>${y}</td>` + BMR.MONTHS.map((_, i) => { const c = mt.mm[y] && mt.mm[y][i + 1]; return c ? `<td style="background:${BMR.heat(c.r, sc)}" class="${c.partial ? "part" : ""}">${ff(c.r)}</td>` : "<td></td>"; }).join("") +
        `<td style="background:${BMR.heat(mt.yr[y], sc * 3)}"><b>${ff(mt.yr[y])}</b></td></tr>`;
    });
    const ys = years.length ? years : all;
    const col = (i, fn) => { const st = BMR.stats(ys.map(y => mt.mm[y] && mt.mm[y][i] && !mt.mm[y][i].partial ? mt.mm[y][i].r : NaN)); return st ? fn(st) : null; };
    const yst = BMR.stats(ys.map(y => mt.yr[y]).filter(x => x != null));
    const row = (name, fn, fmtf, heat) => `<tr class="srow"><td>${name}</td>` + BMR.MONTHS.map((_, i) => { const v = col(i + 1, fn); return `<td ${heat ? `style="background:${BMR.heat(v, sc * 0.6)}"` : ""}>${v == null ? "" : fmtf(v)}</td>`; }).join("") + `<td>${yst ? fmtf(fn(yst)) : ""}</td></tr>`;
    h += `</tbody><tfoot>` + row("Average", s => s.mean, ff, 1) + row("Median", s => s.med, ff, 1) + row("% up", s => s.win, v => v.toFixed(0) + "%", 0) + row("Std dev", s => s.sd, v => (D.yp.additive ? v.toFixed(2) : v.toFixed(1)), 0) + row("Best", s => s.best, ff, 0) + row("Worst", s => s.worst, ff, 0) + `</tfoot>`;
    $("sMonth").innerHTML = h;
    $("sMCap").textContent = `${D.yp.additive ? "Point change" : "% change"} by calendar month · stats rows use the ${ys.length} lookback years · italic = month in progress`;
    // month stats table
    $("sMStat").innerHTML = `<thead><tr><th>Month</th><th>Avg</th><th>Median</th><th>% up</th><th>Std dev</th><th>Best</th><th>Worst</th></tr></thead><tbody>` +
      BMR.MONTHS.map((m, i) => { const st = col(i + 1, s => s); return st ? `<tr><td>${m}</td><td class="${BMR.cls(st.mean)}">${ff(st.mean)}</td><td class="${BMR.cls(st.med)}">${ff(st.med)}</td><td>${st.win.toFixed(0)}%</td><td>${D.yp.additive ? st.sd.toFixed(2) : st.sd.toFixed(1)}</td><td class="pos">${ff(st.best)}</td><td class="neg">${ff(st.worst)}</td></tr>` : ""; }).join("") + `</tbody>`;
  }
  function dow(years) {
    const ys = years.length ? years.concat([D.curY]) : null;
    const g = BMR.dowStats(D.s, ys);
    const ff = x => D.yp.additive ? BMR.sgn(x, 3) : BMR.pct(x, 3);
    $("sDowCap").textContent = `Close-to-close change by weekday · ${ys ? ys.length + " years" : "all history"}`;
    $("sDow").innerHTML = `<thead><tr><th>Day</th><th>Days</th><th>Avg</th><th>Median</th><th>% up</th><th>Std dev</th></tr></thead><tbody>` +
      ["Mon", "Tue", "Wed", "Thu", "Fri"].map((d, i) => { const s = g[i]; return s ? `<tr><td>${d}</td><td>${s.n}</td><td class="${BMR.cls(s.mean)}">${ff(s.mean)}</td><td class="${BMR.cls(s.med)}">${ff(s.med)}</td><td>${s.win.toFixed(1)}%</td><td>${s.sd.toFixed(D.yp.additive ? 3 : 2)}</td></tr>` : ""; }).join("") + `</tbody>`;
  }
  function runWindow() {
    if (!D) return;
    const a = $("sFrom").value.trim(), b = $("sTo").value.trim();
    if (!/^\d\d-\d\d$/.test(a) || !/^\d\d-\d\d$/.test(b)) { $("sWin").innerHTML = `<tbody><tr><td class="flat">Enter dates as MM-DD.</td></tr></tbody>`; return; }
    const ys = lookYears(); const w = BMR.windowReturns(D.s, a, b, ys.concat([D.curY, D.curY + 1]));
    const done = w.rows.filter(r => r.complete && ys.includes(r.year)), st = BMR.stats(done.map(r => r.r));
    const ff = x => D.yp.additive ? BMR.sgn(x, 2) : BMR.pct(x, 2);
    $("sWinSum").innerHTML = st ? [["Avg", ff(st.mean), BMR.cls(st.mean)], ["Median", ff(st.med), BMR.cls(st.med)], ["% up", st.win.toFixed(0) + "%", st.win >= 60 ? "pos" : st.win <= 40 ? "neg" : "flat"], ["Years", String(st.n), "flat"]].map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join("") : "";
    $("sWin").innerHTML = `<thead><tr><th>Year</th><th>From</th><th>To</th><th>Start</th><th>End</th><th>Change</th><th>Max up</th><th>Max down</th></tr></thead><tbody>` +
      w.rows.slice().reverse().map(r => `<tr class="${r.complete ? "" : "part"}"><td>${r.year}${r.complete ? "" : " ·"}</td><td>${r.from}</td><td>${r.to}</td><td>${BMR.fmt(r.start)}</td><td>${BMR.fmt(r.end)}</td><td class="${BMR.cls(r.r)}">${ff(r.r)}</td><td class="pos">${ff(r.maxUp)}</td><td class="neg">${ff(r.maxDn)}</td></tr>`).join("") + `</tbody>`;
  }
  function scan(years) {
    const ys = years.filter(y => D.yp.paths[y].lastDay >= 360);
    if (ys.length < 5) { $("sScan").innerHTML = `<tbody><tr><td class="flat">Needs at least 5 complete years.</td></tr></tbody>`; return; }
    const res = [];
    for (let s = 0; s < 360; s += 2) for (const len of [14, 21, 30, 45, 60, 90]) {
      const e = s + len; if (e > 364) continue;
      const v = ys.map(y => chg(D.yp.paths[y].v[s], D.yp.paths[y].v[e]));
      const st = BMR.stats(v); if (!st || !st.sd) continue;
      const dir = st.mean >= 0 ? 1 : -1, hit = dir > 0 ? st.win : 100 - st.win;
      res.push({ s, e, len, st, dir, hit, score: hit + 10 * Math.abs(st.mean) / st.sd });
    }
    res.sort((a, b) => b.score - a.score);
    const pick = dir => { const out = []; for (const r of res) { if (r.dir !== dir) continue; if (out.some(o => Math.min(o.e, r.e) - Math.max(o.s, r.s) > 0.4 * Math.min(o.len, r.len))) continue; out.push(r); if (out.length >= 8) break; } return out; };
    const ff = x => D.yp.additive ? BMR.sgn(x, 2) : BMR.pct(x, 1);
    const md = d => { const dt = new Date(Date.UTC(2001, 0, 1) + ((d + startDoyOf(S.start)) % 365) * 864e5); return dt.toISOString().slice(5, 10); };
    const rows = (arr, name) => `<tr class="srow"><td colspan="6">${name}</td></tr>` + arr.map(r => `<tr class="click" data-a="${md(r.s)}" data-b="${md(r.e)}"><td>${lab(r.s)} → ${lab(r.e)}</td><td>${r.len}d</td><td class="${BMR.cls(r.st.mean)}">${ff(r.st.mean)}</td><td class="${BMR.cls(r.st.med)}">${ff(r.st.med)}</td><td>${r.hit.toFixed(0)}% ${r.dir > 0 ? "up" : "down"}</td><td>${ff(r.dir > 0 ? r.st.worst : r.st.best)}</td></tr>`).join("");
    $("sScan").innerHTML = `<thead><tr><th>Window</th><th>Length</th><th>Avg</th><th>Median</th><th>Hit rate</th><th>Worst year</th></tr></thead><tbody>${rows(pick(1), "Rising windows")}${rows(pick(-1), "Falling windows")}</tbody>`;
    $("sScan").querySelectorAll("tr.click").forEach(tr => tr.onclick = () => { $("sFrom").value = tr.dataset.a; $("sTo").value = tr.dataset.b; runWindow(); $("sWin").scrollIntoView({ behavior: "smooth", block: "nearest" }); });
  }
  return { open, current: () => S.sym };
})();
