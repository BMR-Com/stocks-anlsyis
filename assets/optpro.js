/* Options analytics from the daily Yahoo snapshot (data/options/*):
   IV monitor across the universe, term structure (today vs 1 week / 1 month ago), smile by expiry,
   implied vs realised vol history, put/call history and an expiry table with max pain.
   Expiries under the minimum DTE are shown but left out of every IV reading. */
"use strict";
const OPTA = (() => {
  const L = LightweightCharts;
  const VOLIX = { SPY: "^VIX", QQQ: "^VXN", IWM: "^RVX", GLD: "^GVZ", USO: "^OVX", SLV: "^VXSLV", AAPL: "^VXAPL", AMZN: "^VXAZN", GOOGL: "^VXGOG" };
  let built = false, MON = null, sym = null, sort = { k: "ivRank", dir: -1 }, filt = "all", J = {}, hChart = null, pChart = null;
  const $ = id => document.getElementById(id);
  const P = x => x == null || !Number.isFinite(x) ? "—" : (x * 100).toFixed(1);
  const COLS = [["symbol", "Symbol"], ["spot", "Spot"], ["iv30", "IV30"], ["ivRank", "IV rank"], ["ivPct", "IV pctile"], ["rv20", "RV20"], ["ivRv", "IV−RV"],
    ["termSlope", "90−30"], ["putSkew", "25Δ P−C"], ["pcOI", "P/C OI"], ["pcVol", "P/C vol"], ["oi", "Open int."], ["vol", "Volume"], ["mp", "Max pain vs spot"]];
  const FILTERS = { all: () => true, rich: r => r.ivRank != null && r.ivRank >= 70, cheap: r => r.ivRank != null && r.ivRank <= 20,
    inv: r => r.termSlope != null && r.termSlope < 0, prem: r => r.ivRv != null && r.ivRv > 0.05, disc: r => r.ivRv != null && r.ivRv < -0.02, puts: r => r.pcVol != null && r.pcVol > 1.2 };

  function build() {
    if (built) return; built = true;
    $("tab-optan").innerHTML = `
    <div class="ctrls"><span class="lbl">Filter</span>
      <span class="chip on" data-of="all">All</span><span class="chip" data-of="rich">IV rank ≥ 70</span><span class="chip" data-of="cheap">IV rank ≤ 20</span>
      <span class="chip" data-of="inv">Inverted term</span><span class="chip" data-of="prem">IV over RV</span><span class="chip" data-of="disc">IV under RV</span><span class="chip" data-of="puts">Heavy put volume</span>
      <span class="srcbadge" id="oaCap" style="margin-left:auto"></span></div>
    <div class="panel" style="padding:0;overflow:hidden"><div style="overflow-x:auto;max-height:46vh;overflow-y:auto"><table id="oaMon"></table></div></div>
    <p class="note" id="oaNote"></p>
    <div class="ctrls" style="margin-top:14px"><span class="lbl">Symbol</span><select id="oaSym"></select><span class="srcbadge" id="oaSymCap"></span></div>
    <div class="fgrid" id="oaTiles" style="grid-template-columns:repeat(8,1fr);margin-bottom:12px"></div>
    <div class="two">
      <div class="panel"><h2>IV term structure</h2><p class="cap" id="oaTermCap"></p><div class="chartbox lg"><canvas id="oaTerm"></canvas></div></div>
      <div class="panel"><h2>Volatility smile</h2><div class="ctrls"><select id="oaExp"></select><span class="cap" style="margin:0" id="oaSmileCap"></span></div><div class="chartbox lg"><canvas id="oaSmile"></canvas></div></div>
    </div>
    <div class="two">
      <div class="panel"><h2>Implied vs realised volatility</h2><p class="cap" id="oaHCap"></p><div id="oaHist" style="height:280px;position:relative"></div></div>
      <div class="panel"><h2>Put / call ratios and skew</h2><p class="cap">From the daily snapshot. History builds up one point per trading day.</p><div id="oaPC" style="height:280px;position:relative"></div></div>
    </div>
    <div class="panel"><h2>By expiry</h2><p class="cap" id="oaExpCap"></p><div style="overflow-x:auto"><table id="oaExpTbl"></table></div></div>`;
    $("tab-optan").querySelectorAll("[data-of]").forEach(c => c.onclick = () => { filt = c.dataset.of; $("tab-optan").querySelectorAll("[data-of]").forEach(x => x.classList.toggle("on", x === c)); monitor(); });
    $("oaSym").onchange = e => detail(e.target.value);
    $("oaExp").onchange = smile;
  }
  async function show(want) {
    build();
    if (!MON) {
      try { MON = await BMR.json("data/options/monitor.json"); }
      catch (e) { $("oaCap").textContent = "Options analytics haven't been generated yet. They arrive with the next daily update after the US close."; return; }
      MON.rows.forEach(r => r.mp = r.monthMaxPain && r.spot ? (r.monthMaxPain / r.spot - 1) * 100 : null);
      $("oaCap").textContent = `Snapshot of ${MON.date} · ${MON.rows.length} symbols${MON.failed && MON.failed.length ? " · no chain: " + MON.failed.join(", ") : ""}`;
      $("oaNote").textContent = `IV readings use options with at least ${MON.minDteIV} days to expiry. IV30/60/90 are interpolated in total variance across expiries. IV rank and percentile compare with the last year of the matching CBOE volatility index where one exists, otherwise with this site's own IV30 history, which builds up daily. Skew = 25-delta put IV minus 25-delta call IV on the expiry nearest 30 days.`;
      $("oaSym").innerHTML = MON.rows.map(r => `<option>${r.symbol}</option>`).join("");
      monitor();
    }
    const s = want && MON.rows.some(r => r.symbol === want) ? want : sym || MON.rows[0]?.symbol;
    if (s && s !== sym) detail(s);
  }
  function monitor() {
    const rows = MON.rows.filter(FILTERS[filt]).sort((a, b) => { const x = a[sort.k], y = b[sort.k]; if (typeof x === "string") return sort.dir * x.localeCompare(y); return sort.dir * ((x ?? -1e9) - (y ?? -1e9)); });
    const fm = { spot: r => BMR.fmt(r.spot), iv30: r => P(r.iv30), ivRank: r => r.ivRank == null ? "—" : `<span class="bar" style="--w:${r.ivRank}%">${r.ivRank.toFixed(0)}</span>`, ivPct: r => r.ivPct == null ? "—" : r.ivPct.toFixed(0),
      rv20: r => P(r.rv20), ivRv: r => `<span class="${BMR.cls(r.ivRv)}">${r.ivRv == null ? "—" : BMR.sgn(r.ivRv * 100, 1)}</span>`, termSlope: r => `<span class="${BMR.cls(r.termSlope)}">${r.termSlope == null ? "—" : BMR.sgn(r.termSlope * 100, 1)}</span>`,
      putSkew: r => r.putSkew == null ? "—" : BMR.sgn(r.putSkew * 100, 1), pcOI: r => BMR.fmt(r.pcOI), pcVol: r => `<span class="${r.pcVol > 1.2 ? "neg" : r.pcVol < 0.6 ? "pos" : ""}">${BMR.fmt(r.pcVol)}</span>`,
      oi: r => (r.oi / 1e3).toFixed(0) + "k", vol: r => (r.vol / 1e3).toFixed(0) + "k", mp: r => r.mp == null ? "—" : `${BMR.fmt(r.monthMaxPain)} <span class="${BMR.cls(r.mp)}">(${BMR.pct(r.mp)})</span>`, symbol: r => `<b>${r.symbol}</b>` };
    $("oaMon").innerHTML = `<thead><tr>${COLS.map(([k, n]) => `<th data-k="${k}" class="sortable">${n}${sort.k === k ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>` +
      rows.map(r => `<tr class="click ${r.symbol === sym ? "sel" : ""}" data-s="${r.symbol}">${COLS.map(([k]) => `<td>${fm[k](r)}</td>`).join("")}</tr>`).join("") + `</tbody>`;
    $("oaMon").querySelectorAll("th[data-k]").forEach(th => th.onclick = () => { const k = th.dataset.k; sort = { k, dir: sort.k === k ? -sort.dir : (k === "symbol" ? 1 : -1) }; monitor(); });
    $("oaMon").querySelectorAll("tr[data-s]").forEach(tr => tr.onclick = () => detail(tr.dataset.s));
  }
  async function detail(s) {
    sym = s; $("oaSym").value = s; monitor();
    const [lt, tj, hc] = await Promise.all([BMR.json(`data/options/latest/${s}.json`).catch(() => null), BMR.json(`data/options/term/${s}.json`).catch(() => ({})), BMR.text(`data/options/hist/${s}.csv`).catch(() => "")]);
    if (!lt) { $("oaSymCap").textContent = "No snapshot for " + s; return; }
    J = { lt, tj, hist: csv(hc) };
    const m = MON.rows.find(r => r.symbol === s) || {}, sm = lt.summary;
    $("oaSymCap").textContent = `${s} · spot ${BMR.fmt(sm.spot)} · snapshot ${sm.date}`;
    const t = [["IV30", P(sm.iv30)], ["IV60", P(sm.iv60)], ["IV90", P(sm.iv90)], ["IV rank", m.ivRank == null ? "—" : m.ivRank.toFixed(0) + (m.rankSrc ? ` <small class="flat">${m.rankSrc === "own history" ? "own " + m.rankN + "d" : m.rankSrc}</small>` : "")],
      ["RV20", P(sm.rv20)], ["IV − RV", sm.ivRv == null ? "—" : BMR.sgn(sm.ivRv * 100, 1)], ["P/C OI · vol", `${BMR.fmt(sm.pcOI)} · ${BMR.fmt(sm.pcVol)}`], [`Max pain ${sm.monthExp ? sm.monthExp.slice(5) : ""}`, BMR.fmt(sm.monthMaxPain)]];
    $("oaTiles").innerHTML = t.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
    term();
    $("oaExp").innerHTML = lt.term.map(x => `<option value="${x.exp}">${x.exp} · ${x.dte}d${x.ivUsed ? "" : " (excluded)"}</option>`).join("");
    const def = lt.term.find(x => x.ivUsed && x.dte >= 25) || lt.term[0]; $("oaExp").value = def.exp;
    smile(); expiries(); await history(); pcHist();
  }
  function csv(t) {
    const L = t.trim().split(/\r?\n/); if (L.length < 2) return [];
    const h = L[0].split(","); return L.slice(1).map(l => { const v = l.split(","), o = {}; h.forEach((k, i) => o[k] = v[i] === "" || v[i] == null ? null : isNaN(+v[i]) ? v[i] : +v[i]); return o; });
  }
  const cj = (id) => { const c = $(id); if (c._c) c._c.destroy(); return c; };
  const axis = (title, extra = {}) => ({ title: { display: !!title, text: title, color: "#7C8E85" }, grid: { color: "rgba(255,255,255,.05)" }, ticks: { color: "#7C8E85", font: { family: "ui-monospace" } }, ...extra });
  function term() {
    const { lt, tj } = J, dates = Object.keys(tj).sort(), today = lt.summary.date;
    const ago = days => { const lim = new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10); const d = dates.filter(x => x <= lim).at(-1); return d && d !== today ? d : null; };
    const used = lt.term.filter(x => x.ivUsed && x.atm), ex = lt.term.filter(x => !x.ivUsed && x.atm);
    const ds = [
      { label: `ATM ${today}`, data: used.map(x => ({ x: x.dte, y: x.atm * 100 })), borderColor: "#E7EDE9", backgroundColor: "#E7EDE9", borderWidth: 2, pointRadius: 3, showLine: true, tension: .25 },
      { label: "25Δ put", data: used.filter(x => x.p25).map(x => ({ x: x.dte, y: x.p25 * 100 })), borderColor: "#E06A50", backgroundColor: "#E06A50", borderWidth: 1.4, pointRadius: 2, showLine: true, tension: .25 },
      { label: "25Δ call", data: used.filter(x => x.c25).map(x => ({ x: x.dte, y: x.c25 * 100 })), borderColor: "#34C289", backgroundColor: "#34C289", borderWidth: 1.4, pointRadius: 2, showLine: true, tension: .25 },
      { label: `< ${lt.minDteIV} DTE (excluded)`, data: ex.map(x => ({ x: x.dte, y: x.atm * 100 })), borderColor: "#5F7169", backgroundColor: "rgba(95,113,105,.4)", pointRadius: 4, pointStyle: "crossRot", showLine: false },
    ];
    [[7, "#D2A93F", "1 week ago"], [30, "#8C7BE0", "1 month ago"]].forEach(([d, c, n]) => { const k = ago(d); if (k) ds.push({ label: `${n} (${k})`, data: tj[k].filter(p => p[0] >= lt.minDteIV).map(p => ({ x: p[0], y: p[1] * 100 })), borderColor: c, backgroundColor: c, borderDash: [5, 4], borderWidth: 1.3, pointRadius: 0, showLine: true, tension: .25 }); });
    const c = cj("oaTerm");
    c._c = new Chart(c, { type: "scatter", data: { datasets: ds }, options: { maintainAspectRatio: false, animation: false, plugins: { legend: { labels: { color: "#8A9A92", boxWidth: 10, font: { size: 10.5 } } }, tooltip: { callbacks: { label: x => `${x.dataset.label}: ${x.parsed.y.toFixed(1)}% @ ${x.parsed.x}d` } } }, scales: { x: axis("days to expiry", { type: "linear", min: 0 }), y: axis("implied vol %") } } });
    const sm = lt.summary;
    $("oaTermCap").textContent = `ATM IV by days to expiry. 30d ${P(sm.iv30)}%, 90d ${P(sm.iv90)}% (${sm.termSlope == null ? "" : sm.termSlope >= 0 ? "upward sloping" : "inverted"}). Grey crosses are expiries under ${lt.minDteIV} days, shown for reference only.`;
  }
  function smile() {
    const { lt } = J, e = $("oaExp").value, s = lt.smiles[e], spot = lt.summary.spot; if (!s) return;
    const pick = (arr) => s.k.map((k, i) => arr[i] == null ? null : { x: k, y: arr[i] * 100 }).filter(Boolean);
    const oi = s.k.map((k, i) => ({ x: k, y: s.callOI[i] + s.putOI[i] }));
    const c = cj("oaSmile");
    c._c = new Chart(c, { data: { datasets: [
      { type: "line", label: "OTM smile", data: pick(s.smile), borderColor: "#E7EDE9", borderWidth: 2, pointRadius: 0, tension: .3, yAxisID: "y" },
      { type: "scatter", label: "Call IV", data: pick(s.callIV), backgroundColor: "rgba(52,194,137,.7)", pointRadius: 2.4, yAxisID: "y" },
      { type: "scatter", label: "Put IV", data: pick(s.putIV), backgroundColor: "rgba(224,106,80,.7)", pointRadius: 2.4, yAxisID: "y" },
      { type: "bar", label: "Open interest", data: oi, backgroundColor: "rgba(90,169,230,.22)", yAxisID: "y2", barThickness: "flex" },
      { type: "line", label: "Spot", data: [{ x: spot, y: 0 }, { x: spot, y: Math.max(...oi.map(o => o.y), 1) }], borderColor: "#D2A93F", borderDash: [4, 4], borderWidth: 1, pointRadius: 0, yAxisID: "y2" },
    ] }, options: { maintainAspectRatio: false, animation: false, parsing: false, plugins: { legend: { labels: { color: "#8A9A92", boxWidth: 10, font: { size: 10.5 } } } },
      scales: { x: axis("strike", { type: "linear" }), y: axis("IV %", { position: "left" }), y2: axis("", { position: "right", grid: { display: false }, ticks: { color: "#5F7169", callback: v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v } }) } } });
    const t = lt.term.find(x => x.exp === e);
    $("oaSmileCap").textContent = t ? `ATM ${P(t.atm)}% · 25Δ put ${P(t.p25)}% · call ${P(t.c25)}% · max pain ${BMR.fmt(t.maxPain)}${t.ivUsed ? "" : " · under " + lt.minDteIV + " days, excluded from IV readings"}` : "";
  }
  function expiries() {
    const { lt } = J;
    $("oaExpCap").textContent = `Max pain = strike where option holders lose the most at expiry (by open interest). ${lt.term.filter(x => !x.ivUsed).length} expiries under ${lt.minDteIV} days are shown dimmed and are not used for IV.`;
    $("oaExpTbl").innerHTML = `<thead><tr><th>Expiry</th><th>DTE</th><th>ATM IV</th><th>25Δ put</th><th>25Δ call</th><th>Risk reversal</th><th>Call OI</th><th>Put OI</th><th>P/C OI</th><th>Call vol</th><th>Put vol</th><th>Max pain</th><th>vs spot</th></tr></thead><tbody>` +
      lt.term.map(x => `<tr class="${x.ivUsed ? "" : "part"}"><td>${x.exp}</td><td>${x.dte}</td><td>${P(x.atm)}</td><td>${P(x.p25)}</td><td>${P(x.c25)}</td><td class="${BMR.cls(x.rr25)}">${x.rr25 == null ? "—" : BMR.sgn(x.rr25 * 100, 1)}</td><td>${x.callOI.toLocaleString()}</td><td>${x.putOI.toLocaleString()}</td><td>${x.callOI ? (x.putOI / x.callOI).toFixed(2) : "—"}</td><td>${x.callVol.toLocaleString()}</td><td>${x.putVol.toLocaleString()}</td><td>${BMR.fmt(x.maxPain)}</td><td class="${BMR.cls(x.maxPain / lt.summary.spot - 1)}">${x.maxPain ? BMR.pct((x.maxPain / lt.summary.spot - 1) * 100) : "—"}</td></tr>`).join("") + `</tbody>`;
  }
  const lwOpts = () => ({ autoSize: true, layout: { background: { type: "solid", color: "#0F1713" }, textColor: "#7C8E85", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11 }, grid: { vertLines: { color: "rgba(255,255,255,.045)" }, horzLines: { color: "rgba(255,255,255,.045)" } }, rightPriceScale: { borderColor: "#22302A" }, timeScale: { borderColor: "#22302A" } });
  async function history() {
    if (hChart) { hChart.remove(); hChart = null; }
    hChart = L.createChart($("oaHist"), lwOpts());
    const legs = [];
    try {
      const px = await BMR.series(sym); const rv = BMR.TA.hv(px.c, 20, 252);
      const s = hChart.addSeries(L.LineSeries, { color: "#5AA9E6", lineWidth: 1.4, title: "RV20", priceLineVisible: false });
      s.setData(px.t.map((t, i) => rv[i] == null ? null : { time: t, value: rv[i] }).filter(Boolean)); legs.push("20-day realised vol from daily closes");
    } catch (e) { }
    const vi = VOLIX[sym];
    if (vi) { try { const v = await BMR.series(vi); const s = hChart.addSeries(L.LineSeries, { color: "#D2A93F", lineWidth: 1.6, title: vi, priceLineVisible: false }); s.setData(v.t.map((t, i) => ({ time: t, value: v.c[i] }))); legs.push(`${vi} (CBOE 30-day implied vol index)`); } catch (e) { } }
    const h = J.hist.filter(r => r.iv30 != null);
    if (h.length) { const s = hChart.addSeries(L.LineSeries, { color: "#E7EDE9", lineWidth: 2, title: "IV30", priceLineVisible: false, pointMarkersVisible: h.length < 40 }); s.setData(h.map(r => ({ time: r.date, value: r.iv30 * 100 }))); legs.push("IV30 from this site's daily snapshot"); }
    const n = hChart.timeScale(); try { const end = new Date(); const st = new Date(Date.now() - 3 * 365 * 864e5); n.setVisibleRange({ from: st.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }); } catch (e) { n.fitContent(); }
    $("oaHCap").textContent = `Annualised %. ${legs.join(" · ")}.`;
  }
  function pcHist() {
    if (pChart) { pChart.remove(); pChart = null; }
    pChart = L.createChart($("oaPC"), lwOpts());
    const h = J.hist; if (!h.length) return;
    const add = (k, c, t, mul = 1, scale = "right") => { const s = pChart.addSeries(L.LineSeries, { color: c, lineWidth: 1.6, title: t, priceLineVisible: false, pointMarkersVisible: h.length < 40, priceScaleId: scale }); s.setData(h.filter(r => r[k] != null).map(r => ({ time: r.date, value: r[k] * mul }))); };
    add("pcOI", "#5AA9E6", "P/C OI"); add("pcVol", "#E06A50", "P/C vol"); add("putSkew", "#D2A93F", "25Δ skew (vol pts)", 100, "left");
    pChart.applyOptions({ leftPriceScale: { visible: true, borderColor: "#22302A" } });
    pChart.timeScale().fitContent();
  }
  return { show };
})();
