/* Commodities: every BCOM constituent with weights, performance, feed status and futures curve,
   plus a spread / ratio builder (inter-commodity and calendar spreads). */
"use strict";
const COMM = (() => {
  const L = LightweightCharts;
  let built = false, META = null, chart = null, curveChart = null;
  const $ = id => document.getElementById(id);
  const PRESETS = [
    ["Brent – WTI ($/bbl)", "BZ=F-CL=F"],
    ["3-2-1 crack ($/bbl)", "(2*RB=F*42+HO=F*42-3*CL=F)/3"],
    ["Gasoline crack ($/bbl)", "RB=F*42-CL=F"],
    ["Heating oil crack ($/bbl)", "HO=F*42-CL=F"],
    ["Crude / natural gas ratio", "CL=F/NG=F"],
    ["Soybean board crush ($/bu)", "ZM=F*0.022+ZL=F*0.11-ZS=F/100"],
    ["Soy oil share of crush (%)", "100*ZL=F*0.11/(ZL=F*0.11+ZM=F*0.022)"],
    ["Soybean / corn ratio", "ZS=F/ZC=F"],
    ["KC – Chicago wheat (¢/bu)", "KE=F-ZW=F"],
    ["Chicago wheat – corn (¢/bu)", "ZW=F-ZC=F"],
    ["Gold / silver ratio", "GC=F/SI=F"],
    ["Copper / gold (×1000)", "HG=F/GC=F*1000"],
    ["Gold / crude ratio", "GC=F/CL=F"],
    ["Live cattle – lean hogs (¢/lb)", "LE=F-HE=F"],
    ["Sugar / crude (energy parity)", "SB=F/CL=F"],
  ];
  function build() {
    if (built) return; built = true;
    $("tab-commod").innerHTML = `
    <div class="ctrls"><span class="lbl">Bloomberg Commodity Index constituents</span>
      <div class="seg sm" id="cmW"><button data-w="w2026" class="on">2026 weights</button><button data-w="w2027">2027 weights</button></div>
      <span class="srcbadge" id="cmCap" style="margin-left:auto"></span></div>
    <div class="fgrid" id="cmGroups" style="grid-template-columns:repeat(6,1fr);margin-bottom:12px"></div>
    <div class="panel" style="padding:0;overflow:hidden"><div style="overflow-x:auto"><table id="cmTbl"></table></div></div>
    <p class="note" id="cmMiss"></p>
    <div class="two">
      <div class="panel"><h2>Spread &amp; ratio builder</h2><p class="cap">Pick a preset, two legs, or type any formula. Open the result in the Pro Chart or Seasonality tabs for full tools.</p>
        <div class="ctrls"><select id="cmPre"><option value="">Presets…</option>${PRESETS.map(p => `<option value="${BMR.esc(p[1])}">${BMR.esc(p[0])}</option>`).join("")}</select></div>
        <div class="ctrls"><select id="cmA"></select><select id="cmOp"><option value="-">minus</option><option value="/">divided by</option><option value="+">plus</option></select><select id="cmB"></select>
          <span class="lbl">× B</span><input id="cmMul" class="pc-in sm" value="1" style="width:60px"><button class="chip" id="cmLegs">Build</button></div>
        <div class="ctrls"><span class="lbl">Calendar</span><select id="cmCal"></select><select id="cmC1"></select><span class="lbl">minus</span><select id="cmC2"></select><button class="chip" id="cmCalGo">Build</button></div>
        <div class="ctrls"><input id="cmExpr" class="pc-in" style="flex:1;min-width:240px" placeholder="formula, e.g. BZ=F-CL=F" spellcheck="false"><button class="chip on" id="cmGo">Plot</button></div>
        <div class="ctrls"><button class="chip" id="cmToChart">Open in Pro Chart</button><button class="chip" id="cmToSeas">Open in Seasonality</button></div>
      </div>
      <div class="panel"><h2 id="cmSpT">Spread</h2><p class="cap" id="cmSpCap"></p>
        <div class="fgrid" id="cmSpStats" style="grid-template-columns:repeat(4,1fr);margin-bottom:8px"></div>
        <div id="cmSpChart" style="height:300px;position:relative"></div></div>
    </div>
    <div class="panel"><h2>Futures curve</h2><p class="cap" id="cmCurveCap">Latest settlement of each listed contract Yahoo carries. Upward slope = contango, downward = backwardation.</p>
      <div class="ctrls"><select id="cmCurveSel"></select></div><div id="cmCurve" style="height:260px;position:relative"></div></div>`;
    $("cmPre").onchange = e => { if (e.target.value) { $("cmExpr").value = e.target.value; plot(); } };
    $("cmLegs").onclick = () => { const a = $("cmA").value, b = $("cmB").value, op = $("cmOp").value, m = parseFloat($("cmMul").value) || 1; $("cmExpr").value = `${q(a)}${op}${m === 1 ? q(b) : q(b) + "*" + m}`; plot(); };
    $("cmCal").onchange = fillCal; $("cmCalGo").onclick = () => { $("cmExpr").value = `${$("cmC1").value}-${$("cmC2").value}`; plot(); };
    $("cmGo").onclick = plot; $("cmExpr").addEventListener("keydown", e => { if (e.key === "Enter") plot(); });
    $("cmToChart").onclick = () => { const v = $("cmExpr").value.trim(); if (v && window.BMR_OPEN) BMR_OPEN("chart", v); };
    $("cmToSeas").onclick = () => { const v = $("cmExpr").value.trim(); if (v && window.BMR_OPEN) BMR_OPEN("season", v); };
    $("cmCurveSel").onchange = curve;
    $("tab-commod").querySelectorAll("#cmW button").forEach(b => b.onclick = () => { $("tab-commod").querySelectorAll("#cmW button").forEach(x => x.classList.toggle("on", x === b)); table(b.dataset.w); });
  }
  const q = s => /[-:!]/.test(s) ? `{${s}}` : s;
  async function show() {
    build();
    if (META) return;
    try { META = await BMR.json("data/commod/meta.json"); }
    catch (e) { $("cmCap").textContent = "Commodity data hasn't been loaded yet. It arrives with the next daily update."; return; }
    await BMR.index();
    $("cmCap").textContent = `as of ${META.asOf.replace("T", " ")} UTC`;
    table("w2026");
    const live = META.commodities.filter(c => c.sym);
    const opts = live.map(c => `<option value="${BMR.esc(c.sym)}">${BMR.esc(c.name)} (${BMR.esc(c.sym.replace(/^TV:/, ""))})</option>`).join("");
    $("cmA").innerHTML = opts; $("cmB").innerHTML = opts;
    if (live[1]) $("cmB").selectedIndex = 1;
    const wc = META.commodities.filter(c => c.contracts && c.contracts.length >= 2);
    $("cmCal").innerHTML = wc.map(c => `<option value="${c.key}">${BMR.esc(c.name)}</option>`).join("");
    $("cmCurveSel").innerHTML = wc.map(c => `<option value="${c.key}">${BMR.esc(c.name)}</option>`).join("");
    fillCal(); curve();
    // only presets whose legs all have data
    const known = BMR.known();
    [...$("cmPre").options].forEach(o => { if (!o.value) return; const legs = (o.value.match(/[A-Z]{1,3}=F/g) || []); if (legs.some(l => !known.has(l))) o.disabled = true; });
    $("cmExpr").value = $("cmExpr").value || "BZ=F-CL=F";
    plot();
  }
  function fillCal() {
    const c = META.commodities.find(x => x.key === $("cmCal").value); if (!c) return;
    const o = c.contracts.map(k => `<option value="${k.sym}">${BMR.esc(k.label)}</option>`).join("");
    $("cmC1").innerHTML = o; $("cmC2").innerHTML = o; if (c.contracts[1]) $("cmC2").selectedIndex = Math.min(c.contracts.length - 1, c.contracts.length > 4 ? 3 : 1);
  }
  function spark(v) {
    if (!v || v.length < 2) return "";
    const lo = Math.min(...v), hi = Math.max(...v), w = 90, h = 24, r = hi - lo || 1;
    const p = v.map((x, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - (x - lo) / r * h).toFixed(1)}`).join(" ");
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${v.at(-1) >= v[0] ? "#34C289" : "#E06A50"}" stroke-width="1.3" points="${p}"/></svg>`;
  }
  function rangeBar(s) {
    if (!s || s.hi52 == null) return "";
    const pos = s.hi52 === s.lo52 ? 50 : (s.last - s.lo52) / (s.hi52 - s.lo52) * 100;
    return `<div class="rbar" title="52-week range ${BMR.fmt(s.lo52)} – ${BMR.fmt(s.hi52)}"><i style="left:${pos.toFixed(0)}%"></i></div>`;
  }
  function table(wk) {
    const C = META.commodities, groups = {};
    C.forEach(c => { (groups[c.group] = groups[c.group] || []).push(c); });
    // weighted group moves (target weights; constituents without a feed are left out)
    $("cmGroups").innerHTML = Object.entries(groups).map(([g, arr]) => {
      const w = arr.reduce((a, c) => a + (c.snap ? c[wk] : 0), 0), tw = arr.reduce((a, c) => a + c[wk], 0);
      const avg = k => { const ok = arr.filter(c => c.snap && c.snap[k] != null); const ww = ok.reduce((a, c) => a + c[wk], 0); return ww ? ok.reduce((a, c) => a + c[wk] * c.snap[k], 0) / ww : null; };
      const m = avg("m1"), y = avg("ytd");
      return `<div class="stat"><div class="k">${BMR.esc(g)} · ${tw.toFixed(1)}%</div><div class="v ${BMR.cls(m)}">${BMR.pct(m)} <small class="flat">1M</small></div><div class="num ${BMR.cls(y)}" style="font-size:11px">${BMR.pct(y)} YTD</div></div>`;
    }).join("");
    let h = `<thead><tr><th>Commodity</th><th>Feed</th><th>${wk === "w2026" ? "2026" : "2027"} wt</th><th>Δ wt</th><th>Last</th><th>1D</th><th>1W</th><th>1M</th><th>3M</th><th>YTD</th><th>1Y</th><th>52W range</th><th>60 days</th><th></th></tr></thead><tbody>`;
    Object.entries(groups).forEach(([g, arr]) => {
      h += `<tr class="srow"><td colspan="14">${BMR.esc(g)}</td></tr>`;
      arr.forEach(c => {
        const s = c.snap, dw = c.w2027 - c.w2026;
        const feed = c.sym ? `<span title="${BMR.esc(c.source || "")}${c.note ? " · " + BMR.esc(c.note) : ""}">${BMR.esc(c.sym.replace(/^TV:/, ""))}${c.note ? " *" : ""}</span>` : `<span class="neg">no feed</span>`;
        h += `<tr><td style="font-family:var(--ui)">${BMR.esc(c.name)} <span class="flat" style="font-size:10px">${BMR.esc(c.unit || "")}</span></td><td>${feed}</td><td>${c[wk].toFixed(2)}%</td><td class="${BMR.cls(dw)}">${dw ? BMR.sgn(dw, 2) : "—"}</td>` +
          (s ? `<td>${BMR.fmt(s.last, s.last < 10 ? 3 : 2)}</td>` + ["d1", "w1", "m1", "m3", "ytd", "y1"].map(k => `<td class="${BMR.cls(s[k])}">${BMR.pct(s[k])}</td>`).join("") + `<td>${rangeBar(s)}</td><td>${spark(s.spark)}</td>` : `<td colspan="9" class="flat">—</td>`) +
          `<td>${c.sym ? `<button class="mini" data-ch="${BMR.esc(c.sym)}">Chart</button><button class="mini" data-se="${BMR.esc(c.sym)}">Seasonal</button>` : ""}</td></tr>`;
      });
    });
    $("cmTbl").innerHTML = h + "</tbody>";
    $("cmTbl").querySelectorAll("[data-ch]").forEach(b => b.onclick = () => window.BMR_OPEN && BMR_OPEN("chart", b.dataset.ch));
    $("cmTbl").querySelectorAll("[data-se]").forEach(b => b.onclick = () => window.BMR_OPEN && BMR_OPEN("season", b.dataset.se));
    const miss = C.filter(c => !c.sym), prox = C.filter(c => c.sym && c.note);
    $("cmMiss").innerHTML = (miss.length ? `No free daily feed found for: ${miss.map(c => BMR.esc(c.name)).join(", ")}. ` : "All constituents have a daily feed. ") +
      (prox.length ? prox.map(c => `* ${BMR.esc(c.name)}: ${BMR.esc(c.note)}.`).join(" ") : "") + ` Weights are BCOM target weights; the 2027 set applies from the January 2027 roll.`;
  }
  async function plot() {
    const ex = $("cmExpr").value.trim(); if (!ex) return;
    let s; try { s = await BMR.evaluate(ex); } catch (e) { $("cmSpCap").textContent = String(e.message || e); return; }
    $("cmSpT").textContent = ex;
    const c = s.c, n = c.length, last = c[n - 1], y1 = c.slice(-252), y5 = c.slice(-1260);
    const m = y1.reduce((a, b) => a + b, 0) / y1.length, sd = Math.sqrt(y1.reduce((a, b) => a + (b - m) ** 2, 0) / y1.length);
    const pctl = y5.filter(x => x <= last).length / y5.length * 100;
    $("cmSpCap").textContent = `${s.t[0]} → ${s.t.at(-1)} · ${n.toLocaleString()} days on common dates`;
    $("cmSpStats").innerHTML = [["Last", BMR.fmt(last, Math.abs(last) < 10 ? 3 : 2), "flat"], ["1Y average", BMR.fmt(m, Math.abs(m) < 10 ? 3 : 2), "flat"], ["Z-score vs 1Y", sd ? ((last - m) / sd).toFixed(2) : "—", BMR.cls(last - m)], ["5Y percentile", pctl.toFixed(0) + "%", pctl > 80 ? "pos" : pctl < 20 ? "neg" : "flat"]]
      .map(([k, v, cl]) => `<div class="stat"><div class="k">${k}</div><div class="v ${cl}">${v}</div></div>`).join("");
    if (chart) chart.remove();
    chart = L.createChart($("cmSpChart"), chartOpts());
    const a = chart.addSeries(L.BaselineSeries, { baseValue: { type: "price", price: m }, lineWidth: 1.6, priceLineVisible: false });
    a.setData(s.t.map((t, i) => ({ time: t, value: c[i] })));
    a.createPriceLine({ price: m, color: "rgba(210,169,63,.6)", lineStyle: 2, lineWidth: 1, title: "1Y avg" });
    if (c.some(x => x < 0) && c.some(x => x > 0)) a.createPriceLine({ price: 0, color: "rgba(255,255,255,.3)", lineWidth: 1, lineStyle: 0, axisLabelVisible: false });
    const i0 = Math.max(0, n - 756); chart.timeScale().setVisibleLogicalRange({ from: i0, to: n + 3 });
  }
  function chartOpts() {
    return { autoSize: true, layout: { background: { type: "solid", color: "#0F1713" }, textColor: "#7C8E85", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,.045)" }, horzLines: { color: "rgba(255,255,255,.045)" } }, rightPriceScale: { borderColor: "#22302A" }, timeScale: { borderColor: "#22302A" }, crosshair: { mode: L.CrosshairMode.Normal } };
  }
  function curve() {
    const c = META && META.commodities.find(x => x.key === $("cmCurveSel").value); if (!c) return;
    const k = c.contracts.filter(x => x.close != null);
    const el = $("cmCurve");
    if (k.length < 2) { el.innerHTML = `<p class="flat">Not enough contracts.</p>`; return; }
    const W = el.clientWidth || 700, H = 250, pad = 46, lo = Math.min(...k.map(x => x.close)), hi = Math.max(...k.map(x => x.close)), r = hi - lo || Math.abs(hi) * 0.01 || 1;
    const X = i => pad + i * (W - pad * 2) / (k.length - 1), Y = v => 16 + (hi - v) / r * (H - 56);
    const pts = k.map((x, i) => `${X(i)},${Y(x.close)}`).join(" ");
    const sl = (k[1].close / k[0].close - 1) * 100, slAll = (k.at(-1).close / k[0].close - 1) * 100;
    el.innerHTML = `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" style="font-family:var(--mono);font-size:10.5px">
      <polyline fill="none" stroke="#5AA9E6" stroke-width="2" points="${pts}"/>
      ${k.map((x, i) => `<circle cx="${X(i)}" cy="${Y(x.close)}" r="3.5" fill="#5AA9E6"/><text x="${X(i)}" y="${Y(x.close) - 9}" fill="#E7EDE9" text-anchor="middle">${BMR.fmt(x.close, x.close < 10 ? 3 : 2)}</text><text x="${X(i)}" y="${H - 8}" fill="#7C8E85" text-anchor="middle">${BMR.esc(x.label)}</text>`).join("")}
    </svg>`;
    $("cmCurveCap").textContent = `${c.name}: front to second ${BMR.pct(sl, 2)} (${sl >= 0 ? "contango" : "backwardation"}), front to last listed ${BMR.pct(slAll, 2)}. Contract settlements as of each contract's last bar; thinly traded months can be stale.`;
  }
  return { show };
})();
