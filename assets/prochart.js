/* Pro Chart: TradingView-style charting on lightweight-charts v5 (multi-pane).
   Chart types, D/W/M/Q/Y, log / % scale, 30+ indicators with editable settings, compare overlays,
   spread / ratio formulas, drawing tools saved per symbol, legend, screenshot, fullscreen. */
"use strict";
const PRO = (() => {
  const L = LightweightCharts, T = BMR.TA;
  const COL = { up: "#34C289", down: "#E06A50", bg: "#0F1713", grid: "rgba(255,255,255,.045)", tick: "#7C8E85", line: "#22302A" };
  const PAL = ["#5AA9E6", "#D2A93F", "#B98CD0", "#4FB0A5", "#E0975A", "#8C7BE0", "#E36FA8", "#9BC53D", "#F2C14E", "#6EC1E4"];
  const LS = { get(k, d) { try { const v = localStorage.getItem("bmr." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
               set(k, v) { try { localStorage.setItem("bmr." + k, JSON.stringify(v)); } catch (e) { } } };

  /* ---------------- indicator registry ---------------- */
  const IND = {
    sma: { name: "Moving average (SMA)", pane: 0, p: { len: 50 }, f: (d, p) => [{ v: T.sma(d.c, p.len), t: `SMA ${p.len}` }] },
    ema: { name: "Exponential MA (EMA)", pane: 0, p: { len: 20 }, f: (d, p) => [{ v: T.ema(d.c, p.len), t: `EMA ${p.len}` }] },
    wma: { name: "Weighted MA (WMA)", pane: 0, p: { len: 20 }, f: (d, p) => [{ v: T.wma(d.c, p.len), t: `WMA ${p.len}` }] },
    hma: { name: "Hull MA", pane: 0, p: { len: 21 }, f: (d, p) => [{ v: T.hma(d.c, p.len), t: `HMA ${p.len}` }] },
    vwma: { name: "Volume-weighted MA", pane: 0, p: { len: 20 }, f: (d, p) => [{ v: T.vwma(d.c, d.v, p.len), t: `VWMA ${p.len}` }] },
    bb: { name: "Bollinger Bands", pane: 0, p: { len: 20, mult: 2 }, f: (d, p) => { const b = T.bb(d.c, p.len, p.mult); return [{ v: b.up, t: "BB up", s: 0 }, { v: b.mid, t: `BB ${p.len},${p.mult}`, s: 2 }, { v: b.lo, t: "BB lo", s: 0 }]; } },
    kc: { name: "Keltner Channels", pane: 0, p: { len: 20, mult: 2, atr: 10 }, f: (d, p) => { const b = T.keltner(d.h, d.l, d.c, p.len, p.mult, p.atr); return [{ v: b.up, t: "KC up" }, { v: b.mid, t: `KC ${p.len}`, s: 2 }, { v: b.lo, t: "KC lo" }]; } },
    dc: { name: "Donchian Channels", pane: 0, p: { len: 20 }, f: (d, p) => { const b = T.donchian(d.h, d.l, p.len); return [{ v: b.up, t: `DC ${p.len} up` }, { v: b.mid, t: "DC mid", s: 2 }, { v: b.lo, t: "DC lo" }]; } },
    ichi: { name: "Ichimoku Cloud", pane: 0, p: { conv: 9, base: 26, span: 52 }, f: (d, p) => { const r = T.ichimoku(d.h, d.l, p.conv, p.base, p.span); return [{ v: r.ten, t: "Tenkan", c: "#5AA9E6" }, { v: r.kij, t: "Kijun", c: "#E06A50" }, { v: r.spanA, t: "Span A", c: "rgba(52,194,137,.8)", shift: p.base }, { v: r.spanB, t: "Span B", c: "rgba(224,106,80,.8)", shift: p.base }]; } },
    psar: { name: "Parabolic SAR", pane: 0, p: { step: 0.02, max: 0.2 }, f: (d, p) => [{ v: T.psar(d.h, d.l, p.step, p.max), t: "SAR", dots: 1 }] },
    st: { name: "Supertrend", pane: 0, p: { atr: 10, mult: 3 }, f: (d, p) => { const r = T.supertrend(d.h, d.l, d.c, p.atr, p.mult); return [{ v: r.line.map((x, i) => r.dir[i] === 1 ? x : null), t: "ST up", c: COL.up }, { v: r.line.map((x, i) => r.dir[i] === -1 ? x : null), t: "ST down", c: COL.down }]; } },
    lr: { name: "Linear regression", pane: 0, p: { len: 50 }, f: (d, p) => [{ v: T.linreg(d.c, p.len), t: `LinReg ${p.len}` }] },
    vwap: { name: "Rolling VWAP", pane: 0, p: { len: 20 }, f: (d, p) => { const tp = d.c.map((x, i) => (d.h[i] + d.l[i] + x) / 3); return [{ v: T.vwma(tp, d.v, p.len), t: `VWAP ${p.len}` }]; } },
    rsi: { name: "RSI", pane: 1, p: { len: 14 }, lv: [70, 50, 30], f: (d, p) => [{ v: T.rsi(d.c, p.len), t: `RSI ${p.len}` }] },
    macd: { name: "MACD", pane: 1, p: { fast: 12, slow: 26, sig: 9 }, f: (d, p) => { const m = T.macd(d.c, p.fast, p.slow, p.sig); return [{ v: m.hist, t: "Hist", hist: 1 }, { v: m.line, t: `MACD ${p.fast},${p.slow}`, c: "#5AA9E6" }, { v: m.sig, t: `Signal ${p.sig}`, c: "#D2A93F" }]; } },
    stoch: { name: "Stochastic", pane: 1, p: { k: 14, smooth: 3, d: 3 }, lv: [80, 20], f: (d, p) => { const s = T.stoch(d.h, d.l, d.c, p.k, p.smooth, p.d); return [{ v: s.k, t: `%K ${p.k}`, c: "#5AA9E6" }, { v: s.d, t: "%D", c: "#D2A93F" }]; } },
    srsi: { name: "Stochastic RSI", pane: 1, p: { rsi: 14, stoch: 14, k: 3, d: 3 }, lv: [80, 20], f: (d, p) => { const s = T.stochrsi(d.c, p.rsi, p.stoch, p.k, p.d); return [{ v: s.k, t: "StochRSI K", c: "#5AA9E6" }, { v: s.d, t: "D", c: "#D2A93F" }]; } },
    cci: { name: "CCI", pane: 1, p: { len: 20 }, lv: [100, 0, -100], f: (d, p) => [{ v: T.cci(d.h, d.l, d.c, p.len), t: `CCI ${p.len}` }] },
    wr: { name: "Williams %R", pane: 1, p: { len: 14 }, lv: [-20, -80], f: (d, p) => [{ v: T.willr(d.h, d.l, d.c, p.len), t: `%R ${p.len}` }] },
    adx: { name: "ADX / DMI", pane: 1, p: { len: 14 }, lv: [25], f: (d, p) => { const r = T.adx(d.h, d.l, d.c, p.len); return [{ v: r.adx, t: `ADX ${p.len}`, c: "#D2A93F" }, { v: r.pdi, t: "+DI", c: COL.up }, { v: r.mdi, t: "-DI", c: COL.down }]; } },
    atr: { name: "ATR", pane: 1, p: { len: 14 }, f: (d, p) => [{ v: T.atr(d.h, d.l, d.c, p.len), t: `ATR ${p.len}` }] },
    obv: { name: "On-balance volume", pane: 1, p: {}, f: d => [{ v: T.obv(d.c, d.v), t: "OBV" }] },
    mfi: { name: "Money flow index", pane: 1, p: { len: 14 }, lv: [80, 20], f: (d, p) => [{ v: T.mfi(d.h, d.l, d.c, d.v, p.len), t: `MFI ${p.len}` }] },
    roc: { name: "Rate of change", pane: 1, p: { len: 12 }, lv: [0], f: (d, p) => [{ v: T.roc(d.c, p.len), t: `ROC ${p.len}` }] },
    hv: { name: "Historical volatility", pane: 1, p: { len: 20 }, f: (d, p, tf) => [{ v: T.hv(d.c, p.len, { D: 252, W: 52, M: 12, Q: 4, Y: 1 }[tf] || 252), t: `HV ${p.len} (ann. %)` }] },
    z: { name: "Z-score", pane: 1, p: { len: 50 }, lv: [2, 0, -2], f: (d, p) => [{ v: T.zscore(d.c, p.len), t: `Z ${p.len}` }] },
  };
  const DEFAULT_INDS = [{ k: "ema", p: { len: 20 } }, { k: "ema", p: { len: 50 } }, { k: "sma", p: { len: 200 } }, { k: "rsi", p: { len: 14 } }, { k: "macd", p: { fast: 12, slow: 26, sig: 9 } }];

  const TOOLS = [["cursor", "Cursor", "M4 3l14 8-6 2-2 6z"], ["trend", "Trend line", "M4 19L20 5"], ["ray", "Ray", "M4 19l16-14M18 5h2v2"],
    ["xline", "Extended line", "M2 21L22 3"], ["hline", "Horizontal line", "M2 12h20"], ["hray", "Horizontal ray", "M6 12h16M4 10v4"],
    ["vline", "Vertical line", "M12 2v20"], ["rect", "Rectangle", "M5 6h14v12H5z"], ["channel", "Parallel channel", "M3 16L19 6M5 20L21 10"],
    ["fib", "Fib retracement", "M3 5h18M3 9h18M3 13h18M3 19h18"], ["measure", "Measure", "M4 20L20 4M14 4h6v6"], ["text", "Text note", "M5 5h14M12 5v14"]];
  const NPTS = { trend: 2, ray: 2, xline: 2, hline: 1, hray: 1, vline: 1, rect: 2, channel: 3, fib: 2, measure: 2, text: 1 };
  const FIBS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];

  let S = {
    sym: null, tf: LS.get("tf", "D"), type: LS.get("type", "candles"), log: LS.get("log", false), pct: false,
    inds: LS.get("inds", DEFAULT_INDS), vol: LS.get("vol", true), compares: [], signals: LS.get("signals", true), oi: LS.get("oi", false),
    tool: "cursor", magnet: LS.get("magnet", true), range: null
  };
  let chart = null, main = null, mainData = null, raw = null, bars = null, built = false, outs = [], legendRows = [], sigPlugin = null, oiLines = [];
  let draws = [], pending = null, selected = -1, drag = null, hover = null, canvas, ctx, root;

  /* ---------------- DOM ---------------- */
  function build() {
    if (built) return; built = true;
    root = document.getElementById("tab-chart");
    root.innerHTML = `
    <div class="pc-bar">
      <input id="pcSym" class="pc-in" list="pcList" placeholder="Symbol or formula, e.g. AAPL, CL=F, BZ=F-CL=F" spellcheck="false">
      <datalist id="pcList"></datalist>
      <div class="seg sm" id="pcTf">${["D", "W", "M", "Q", "Y"].map(t => `<button data-tf="${t}">${t}</button>`).join("")}</div>
      <select id="pcType" title="Chart type">
        <option value="candles">Candles</option><option value="hollow">Hollow candles</option><option value="bars">Bars</option>
        <option value="ha">Heikin Ashi</option><option value="line">Line</option><option value="step">Step line</option>
        <option value="area">Area</option><option value="baseline">Baseline</option></select>
      <div class="pc-dd"><button class="chip" id="pcIndBtn">Indicators ▾</button><div class="pc-menu" id="pcIndMenu"></div></div>
      <div class="pc-dd"><button class="chip" id="pcCmpBtn">Compare ▾</button><div class="pc-menu" id="pcCmpMenu"></div></div>
      <span class="chip" id="pcLog" title="Logarithmic price scale">Log</span>
      <span class="chip" id="pcPct" title="Percent scale">%</span>
      <span class="chip" id="pcVol" title="Volume">Vol</span>
      <span class="chip" id="pcSig" title="Detected signals (watchlist names)">Signals</span>
      <span class="chip" id="pcOI" title="Largest open-interest strikes">OI strikes</span>
      <span class="pc-sp"></span>
      <button class="chip" id="pcShot" title="Save a PNG">⤓ PNG</button>
      <button class="chip" id="pcFull" title="Fullscreen">⛶</button>
    </div>
    <div class="pc-wrap" id="pcWrap">
      <div class="pc-tools" id="pcTools">
        ${TOOLS.map(([k, n, d]) => `<button data-tool="${k}" title="${n}"><svg viewBox="0 0 24 24"><path d="${d}"/></svg></button>`).join("")}
        <div class="pc-tsep"></div>
        <button id="pcMag" title="Magnet: snap to open/high/low/close"><svg viewBox="0 0 24 24"><path d="M6 3v8a6 6 0 0012 0V3h-4v8a2 2 0 01-4 0V3z"/></svg></button>
        <button id="pcDel" title="Delete selected drawing (Del)"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"/></svg></button>
        <button id="pcClr" title="Remove all drawings on this symbol"><svg viewBox="0 0 24 24"><path d="M4 4l16 16M20 4L4 20"/></svg></button>
      </div>
      <div class="pc-main">
        <div class="pc-chart" id="pcChart"></div>
        <canvas class="pc-canvas" id="pcCanvas"></canvas>
        <div class="pc-legend" id="pcLegend"></div>
        <div class="pc-err" id="pcErr"></div>
      </div>
      <aside class="pc-side" id="pcSide"><h2>Detected signals</h2><div class="siglist" id="pcSigList"></div></aside>
    </div>
    <div class="pc-foot">
      <div class="seg sm" id="pcRng">${["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "All"].map(r => `<button data-r="${r}">${r}</button>`).join("")}</div>
      <span class="pc-info" id="pcInfo"></span>
    </div>
    <p class="note">Formulas: use + − × ÷ and brackets with any symbols on file, e.g. <code>BZ=F-CL=F</code> (Brent–WTI), <code>ZS=F/ZC=F</code> (soy/corn), <code>GC=F/SI=F</code>, <code>(2*RB=F*42+HO=F*42-3*CL=F)/3</code> (3-2-1 crack, $/bbl), or contract spreads like <code>CLF27.NYM-CLM27.NYM</code>. Wrap a symbol in { } if it contains a minus sign. Drawings are saved in this browser for each symbol.</p>`;
    canvas = document.getElementById("pcCanvas"); ctx = canvas.getContext("2d");
    const $ = id => document.getElementById(id);
    BMR.index().then(() => {
      $("pcList").innerHTML = BMR.symbolList().map(x => `<option value="${BMR.esc(x.s)}">${BMR.esc(x.n || x.g)}</option>`).join("");
    });
    $("pcSym").addEventListener("change", () => { const v = $("pcSym").value.trim(); if (v) open(v); });
    $("pcSym").addEventListener("keydown", e => { if (e.key === "Enter") { const v = $("pcSym").value.trim(); if (v) open(v); } });
    root.querySelectorAll("#pcTf button").forEach(b => b.onclick = () => { S.tf = b.dataset.tf; LS.set("tf", S.tf); S.range = null; render(); });
    $("pcType").onchange = e => { S.type = e.target.value; LS.set("type", S.type); render(true); };
    $("pcLog").onclick = () => { S.log = !S.log; if (S.log) S.pct = false; LS.set("log", S.log); applyScale(); syncChips(); };
    $("pcPct").onclick = () => { S.pct = !S.pct; if (S.pct) S.log = false; applyScale(); syncChips(); };
    $("pcVol").onclick = () => { S.vol = !S.vol; LS.set("vol", S.vol); render(true); };
    $("pcSig").onclick = () => { S.signals = !S.signals; LS.set("signals", S.signals); render(true); };
    $("pcOI").onclick = () => { S.oi = !S.oi; LS.set("oi", S.oi); drawOI(); syncChips(); };
    $("pcShot").onclick = screenshot;
    $("pcFull").onclick = () => { const w = $("pcWrap"); if (document.fullscreenElement) document.exitFullscreen(); else w.requestFullscreen && w.requestFullscreen(); };
    document.addEventListener("fullscreenchange", () => setTimeout(resize, 60));
    root.querySelectorAll("#pcRng button").forEach(b => b.onclick = () => setRange(b.dataset.r));
    root.querySelectorAll("#pcTools [data-tool]").forEach(b => b.onclick = () => setTool(b.dataset.tool));
    $("pcMag").onclick = () => { S.magnet = !S.magnet; LS.set("magnet", S.magnet); syncChips(); };
    $("pcDel").onclick = () => { if (selected >= 0) { draws.splice(selected, 1); selected = -1; saveDraws(); paint(); } };
    $("pcClr").onclick = () => { if (draws.length && confirm(`Remove all ${draws.length} drawings on ${S.sym}?`)) { draws = []; selected = -1; saveDraws(); paint(); } };
    dropdown("pcIndBtn", "pcIndMenu", buildIndMenu);
    dropdown("pcCmpBtn", "pcCmpMenu", buildCmpMenu);
    // drawing interaction (capture phase so the chart doesn't pan while editing)
    const mainEl = root.querySelector(".pc-main");
    mainEl.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    document.addEventListener("keydown", e => {
      if (!root.classList.contains("on") || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.key === "Escape") { pending = null; setTool("cursor"); paint(); }
      if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) { draws.splice(selected, 1); selected = -1; saveDraws(); paint(); e.preventDefault(); }
    });
    new ResizeObserver(() => resize()).observe(mainEl);
  }
  function dropdown(btn, menu, fill) {
    const b = document.getElementById(btn), m = document.getElementById(menu);
    b.onclick = e => { e.stopPropagation(); const open = m.style.display === "block"; document.querySelectorAll(".pc-menu").forEach(x => x.style.display = "none"); if (!open) { fill(); m.style.display = "block"; } };
    document.addEventListener("click", e => { if (!m.contains(e.target) && e.target !== b) m.style.display = "none"; });
  }
  function syncChips() {
    const tg = (id, on) => { const e = document.getElementById(id); if (e) e.classList.toggle("on", !!on); };
    tg("pcLog", S.log); tg("pcPct", S.pct || S.compares.length); tg("pcVol", S.vol); tg("pcSig", S.signals); tg("pcOI", S.oi); tg("pcMag", S.magnet);
    root.querySelectorAll("#pcTf button").forEach(b => b.classList.toggle("on", b.dataset.tf === S.tf));
    root.querySelectorAll("#pcTools [data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === S.tool));
    document.getElementById("pcType").value = S.type;
    document.getElementById("pcSide").style.display = S.signals ? "" : "none";
  }

  /* ---------------- indicator + compare menus ---------------- */
  function buildIndMenu() {
    const m = document.getElementById("pcIndMenu");
    const cur = S.inds.map((x, i) => {
      const def = IND[x.k]; if (!def) return "";
      const ps = Object.entries(x.p || {}).map(([k, v]) => `<label>${k}<input type="number" step="any" data-i="${i}" data-p="${k}" value="${v}"></label>`).join("");
      return `<div class="pc-ind"><span class="pc-dot" style="background:${colorOf(i)}"></span><b>${def.name}</b>${ps}<button data-rm="${i}" title="Remove">×</button></div>`;
    }).join("") || `<div class="pc-mut">No indicators on the chart.</div>`;
    m.innerHTML = `<div class="pc-mh">On the chart</div>${cur}<div class="pc-mh">Add <input id="pcIndQ" placeholder="search…"></div><div id="pcIndAdd" class="pc-add"></div>
      <div class="pc-mh"><button class="chip" id="pcIndReset">Reset to default</button></div>`;
    const fillAdd = q => { document.getElementById("pcIndAdd").innerHTML = Object.entries(IND).filter(([k, d]) => !q || d.name.toLowerCase().includes(q)).map(([k, d]) => `<button data-add="${k}">${d.name}<small>${d.pane ? "pane" : "overlay"}</small></button>`).join(""); bindAdd(); };
    const bindAdd = () => m.querySelectorAll("[data-add]").forEach(b => b.onclick = e => { e.stopPropagation(); const k = b.dataset.add; S.inds.push({ k, p: { ...IND[k].p } }); saveInds(); buildIndMenu(); render(true); });
    fillAdd("");
    document.getElementById("pcIndQ").oninput = e => fillAdd(e.target.value.toLowerCase());
    m.querySelectorAll("[data-rm]").forEach(b => b.onclick = e => { e.stopPropagation(); S.inds.splice(+b.dataset.rm, 1); saveInds(); buildIndMenu(); render(true); });
    m.querySelectorAll("input[data-p]").forEach(inp => inp.onchange = () => { const v = parseFloat(inp.value); if (!Number.isFinite(v)) return; S.inds[+inp.dataset.i].p[inp.dataset.p] = v; saveInds(); render(true); });
    document.getElementById("pcIndReset").onclick = e => { e.stopPropagation(); S.inds = JSON.parse(JSON.stringify(DEFAULT_INDS)); saveInds(); buildIndMenu(); render(true); };
    m.onclick = e => e.stopPropagation();
  }
  function saveInds() { LS.set("inds", S.inds); }
  function buildCmpMenu() {
    const m = document.getElementById("pcCmpMenu");
    m.innerHTML = `<div class="pc-mh">Compare (shown in %)</div>
      ${S.compares.map((c, i) => `<div class="pc-ind"><span class="pc-dot" style="background:${PAL[(i + 5) % PAL.length]}"></span><b>${BMR.esc(c)}</b><button data-rmc="${i}">×</button></div>`).join("") || `<div class="pc-mut">Nothing compared yet.</div>`}
      <div class="pc-mh"><input id="pcCmpIn" list="pcList" placeholder="symbol or formula"><button class="chip" id="pcCmpAdd">Add</button></div>
      <div class="pc-add">${["SPY", "QQQ", "^GSPC", "GC=F", "CL=F", "DX-Y.NYB", "^TNX"].map(s => `<button data-q="${s}">${s}</button>`).join("")}</div>`;
    const add = v => { v = (v || "").trim(); if (!v || S.compares.includes(v)) return; S.compares.push(v); buildCmpMenu(); render(true); };
    document.getElementById("pcCmpAdd").onclick = e => { e.stopPropagation(); add(document.getElementById("pcCmpIn").value); };
    document.getElementById("pcCmpIn").onkeydown = e => { if (e.key === "Enter") add(e.target.value); };
    m.querySelectorAll("[data-q]").forEach(b => b.onclick = e => { e.stopPropagation(); add(b.dataset.q); });
    m.querySelectorAll("[data-rmc]").forEach(b => b.onclick = e => { e.stopPropagation(); S.compares.splice(+b.dataset.rmc, 1); buildCmpMenu(); render(true); });
    m.onclick = e => e.stopPropagation();
  }
  function colorOf(i) { return PAL[i % PAL.length]; }

  /* ---------------- data → chart ---------------- */
  async function open(sym) {
    build();
    sym = sym.trim();
    if (!/[+*\/()\s]/.test(sym) && !sym.includes("-")) sym = sym.toUpperCase();
    else if (!/[+*\/()\s]/.test(sym) && BMR.known().has(sym.toUpperCase())) sym = sym.toUpperCase();
    S.sym = sym; S.range = null; selected = -1; pending = null;
    try { if (typeof chartSym !== "undefined") chartSym = sym; if (location.hash.startsWith("#chart")) history.replaceState(null, "", "#chart/" + encodeURIComponent(sym)); } catch (e) { }
    document.getElementById("pcSym").value = sym;
    draws = LS.get("draw." + sym, []);
    await render();
  }
  function heikin(d) {
    const o = [], h = [], l = [], c = [];
    for (let i = 0; i < d.t.length; i++) {
      const hc = (d.o[i] + d.h[i] + d.l[i] + d.c[i]) / 4, ho = i ? (o[i - 1] + c[i - 1]) / 2 : (d.o[i] + d.c[i]) / 2;
      o.push(ho); c.push(hc); h.push(Math.max(d.h[i], ho, hc)); l.push(Math.min(d.l[i], ho, hc));
    }
    return { ...d, o, h, l, c };
  }
  const pts = (t, v, shift = 0) => { const o = []; for (let i = 0; i < v.length; i++) { const j = i + shift; if (v[i] == null || !Number.isFinite(v[i]) || j >= t.length) continue; o.push({ time: t[j], value: v[i] }); } return o; };
  function chartOpts() {
    return { autoSize: true, layout: { background: { type: "solid", color: COL.bg }, textColor: COL.tick, fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11, panes: { separatorColor: COL.line, separatorHoverColor: "rgba(47,163,107,.35)", enableResize: true }, attributionLogo: true },
      grid: { vertLines: { color: COL.grid }, horzLines: { color: COL.grid } }, crosshair: { mode: L.CrosshairMode.Normal },
      rightPriceScale: { borderColor: COL.line, scaleMargins: { top: 0.08, bottom: 0.08 } }, timeScale: { borderColor: COL.line, rightOffset: 8, barSpacing: 7, minBarSpacing: 0.3 },
      localization: { priceFormatter: p => BMR.fmt(p, Math.abs(p) < 10 ? 4 : 2) } };
  }
  async function render(keepRange) {
    if (!S.sym) return;
    syncChips();
    const err = document.getElementById("pcErr"); err.textContent = "";
    let range = null;
    if (keepRange && chart) { try { range = chart.timeScale().getVisibleLogicalRange(); } catch (e) { } }
    try { raw = await BMR.evaluate(S.sym); }
    catch (e) { err.textContent = String(e.message || e); return; }
    bars = BMR.resample(raw, S.tf);
    const disp = S.type === "ha" ? heikin(bars) : bars;
    if (chart) { chart.remove(); chart = null; }
    chart = L.createChart(document.getElementById("pcChart"), chartOpts());
    outs = []; legendRows = []; oiLines = []; sigPlugin = null;
    const ohlc = disp.t.map((t, i) => ({ time: t, open: disp.o[i], high: disp.h[i], low: disp.l[i], close: disp.c[i] }));
    const line = disp.t.map((t, i) => ({ time: t, value: disp.c[i] }));
    const up = COL.up, dn = COL.down;
    if (["candles", "hollow", "ha"].includes(S.type)) {
      main = chart.addSeries(L.CandlestickSeries, { upColor: S.type === "hollow" ? "rgba(0,0,0,0)" : up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn });
      main.setData(ohlc);
    } else if (S.type === "bars") { main = chart.addSeries(L.BarSeries, { upColor: up, downColor: dn, thinBars: false }); main.setData(ohlc); }
    else if (S.type === "area") { main = chart.addSeries(L.AreaSeries, { lineColor: "#5AA9E6", topColor: "rgba(90,169,230,.35)", bottomColor: "rgba(90,169,230,.02)", lineWidth: 2 }); main.setData(line); }
    else if (S.type === "baseline") { main = chart.addSeries(L.BaselineSeries, { baseValue: { type: "price", price: disp.c[Math.max(0, disp.c.length - 252)] }, lineWidth: 2 }); main.setData(line); }
    else { main = chart.addSeries(L.LineSeries, { color: "#5AA9E6", lineWidth: 2, lineType: S.type === "step" ? 1 : 0 }); main.setData(line); }
    mainData = disp;
    try { L.createTextWatermark(chart.panes()[0], { horzAlign: "center", vertAlign: "center", lines: [{ text: S.sym.length > 24 ? "spread" : S.sym, color: "rgba(255,255,255,.035)", fontSize: 54 }] }); } catch (e) { }
    // volume
    if (S.vol && bars.v.some(x => x > 0)) {
      const vs = chart.addSeries(L.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      vs.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vs.setData(bars.t.map((t, i) => ({ time: t, value: bars.v[i], color: bars.c[i] >= bars.o[i] ? "rgba(52,194,137,.32)" : "rgba(224,106,80,.32)" })));
      legendRows.push({ pane: 0, t: "Vol", c: "#7C8E85", v: bars.v, fmtv: x => x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? (x / 1e3).toFixed(1) + "K" : String(x) });
    }
    // indicators
    let pane = 1;
    S.inds.forEach((ins, i) => {
      const def = IND[ins.k]; if (!def) return;
      let res; try { res = def.f(bars, { ...def.p, ...ins.p }, S.tf); } catch (e) { return; }
      const pi = def.pane ? pane++ : 0, base = colorOf(i);
      res.forEach((o, j) => {
        const color = o.c || (j === 0 ? base : PAL[(i + j * 3) % PAL.length]);
        let s;
        if (o.hist) { s = chart.addSeries(L.HistogramSeries, { lastValueVisible: false, priceLineVisible: false }, pi); s.setData(pts(bars.t, o.v).map(p => ({ ...p, color: p.value >= 0 ? "rgba(52,194,137,.55)" : "rgba(224,106,80,.55)" }))); }
        else {
          s = chart.addSeries(L.LineSeries, { color, lineWidth: o.dots ? 1 : (pi ? 1.5 : 1.3), lineStyle: o.s || 0, lastValueVisible: !!pi, priceLineVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: !!o.dots, pointMarkersRadius: 1.5, lineVisible: !o.dots }, pi);
          s.setData(pts(bars.t, o.v, o.shift || 0));
        }
        if (j === 0 && def.lv) def.lv.forEach(lv => s.createPriceLine({ price: lv, color: "rgba(255,255,255,.18)", lineStyle: 2, lineWidth: 1, axisLabelVisible: false }));
        legendRows.push({ pane: pi, t: o.t, c: o.hist ? "#7C8E85" : color, v: o.v, shift: o.shift || 0 });
      });
    });
    try { chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3.2 : 1)); } catch (e) { }
    // compares
    for (let k = 0; k < S.compares.length; k++) {
      try {
        const cd = BMR.resample(await BMR.evaluate(S.compares[k]), S.tf);
        const s = chart.addSeries(L.LineSeries, { color: PAL[(k + 5) % PAL.length], lineWidth: 1.6, priceLineVisible: false });
        s.setData(cd.t.map((t, i) => ({ time: t, value: cd.c[i] })));
        legendRows.push({ pane: 0, t: S.compares[k], c: PAL[(k + 5) % PAL.length], series: s, cmp: cd });
      } catch (e) { err.textContent = `Compare ${S.compares[k]}: ${e.message || e}`; }
    }
    applyScale();
    await drawSignals();
    drawOI();
    chart.subscribeCrosshairMove(onCross);
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => paint());
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    else setRange(S.range || defaultRange(), true);
    const m = BMR.meta(S.sym);
    document.getElementById("pcInfo").textContent = `${m && m.n ? m.n + " · " : ""}${bars.t.length.toLocaleString()} bars · ${bars.t[0]} → ${bars.t.at(-1)} · source: ${raw.src}${raw.expr ? " (" + raw.legs.join(", ") + ")" : ""}`;
    legend(null);
    setTimeout(() => { resize(); paint(); }, 30);
  }
  function defaultRange() { return { D: "1Y", W: "5Y", M: "All", Q: "All", Y: "All" }[S.tf] || "1Y"; }
  function applyScale() {
    if (!chart) return;
    const mode = S.log ? L.PriceScaleMode.Logarithmic : (S.pct || S.compares.length) ? L.PriceScaleMode.Percentage : L.PriceScaleMode.Normal;
    chart.priceScale("right").applyOptions({ mode });
    setTimeout(paint, 20);
  }
  function setRange(r, silent) {
    if (!chart || !bars) return;
    S.range = r;
    root.querySelectorAll("#pcRng button").forEach(b => b.classList.toggle("on", b.dataset.r === r));
    if (r === "All") { chart.timeScale().fitContent(); return; }
    const last = new Date(bars.t.at(-1) + "T00:00:00Z"); const from = new Date(last);
    if (r === "YTD") from.setUTCMonth(0, 1);
    else { const n = parseInt(r); if (r.endsWith("M")) from.setUTCMonth(from.getUTCMonth() - n); else from.setUTCFullYear(from.getUTCFullYear() - n); }
    const fs = from.toISOString().slice(0, 10);
    let i = bars.t.findIndex(t => t >= fs); if (i < 0) i = 0;
    chart.timeScale().setVisibleLogicalRange({ from: i, to: bars.t.length - 1 + 8 });
  }
  async function drawSignals() {
    const list = document.getElementById("pcSigList");
    if (!S.signals) return;
    let d = null;
    if (S.tf === "D" && !raw.expr) { try { d = await BMR.json(`data/${S.sym}.json`); } catch (e) { } }
    if (!d || !d.signals || !d.signals.length) { list.innerHTML = `<div class="pc-mut" style="padding:18px">${S.tf !== "D" ? "Signals show on the daily chart." : raw.expr ? "Signals are for single symbols." : "Signals are computed for the watchlist names only."}</div>`; return; }
    const K = typeof KIND !== "undefined" ? KIND : {};
    const sig = d.signals.filter(x => K[x.kind]).slice(-150);
    const mk = sig.map(x => ({ time: x.time, position: K[x.kind].bull ? "belowBar" : "aboveBar", color: K[x.kind].c, shape: K[x.kind].bull ? "arrowUp" : "arrowDown", text: (typeof SH !== "undefined" && SH[x.kind]) || "" })).sort((a, b) => a.time < b.time ? -1 : 1);
    try { sigPlugin = L.createSeriesMarkers(main, mk); } catch (e) { }
    list.innerHTML = sig.slice().reverse().map(x => `<div class="sig" data-t="${x.time}"><span class="dot" style="background:${K[x.kind].c}"></span><div><div class="t ${K[x.kind].bull ? "pos" : "neg"}">${BMR.esc(x.label)}</div><div class="d">${x.time} · ${x.price}</div><div class="det">${BMR.esc(x.detail || "")}</div></div></div>`).join("");
    list.querySelectorAll(".sig").forEach(r => r.onclick = () => { const i = bars.t.indexOf(r.dataset.t); if (i >= 0) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, i - 60), to: i + 25 }); });
  }
  async function drawOI() {
    oiLines.forEach(l => { try { main.removePriceLine(l); } catch (e) { } }); oiLines = [];
    syncChips();
    if (!S.oi || !main || raw.expr) return;
    let o = null; try { o = await BMR.json(`data/options/latest/${S.sym}.json`); } catch (e) { }
    let arr = [];
    if (o && o.smiles) {
      const by = {}; Object.values(o.smiles).forEach(s => s.k.forEach((k, i) => { const b = by[k] = by[k] || { c: 0, p: 0 }; b.c += s.callOI[i]; b.p += s.putOI[i]; }));
      arr = Object.entries(by).map(([k, v]) => ({ k: +k, c: v.c, p: v.p, oi: v.c + v.p }));
    } else {
      try { const x = await BMR.json(`data/${S.sym}.options.json`); const by = {}; x.chain.forEach(r => { const b = by[r.strike] = by[r.strike] || { c: 0, p: 0 }; if (r.right === "C") b.c += r.oi || 0; else b.p += r.oi || 0; }); arr = Object.entries(by).map(([k, v]) => ({ k: +k, c: v.c, p: v.p, oi: v.c + v.p })); } catch (e) { }
    }
    arr.sort((a, b) => b.oi - a.oi).slice(0, 8).forEach(x => oiLines.push(main.createPriceLine({ price: x.k, color: x.c >= x.p ? "rgba(52,194,137,.55)" : "rgba(224,106,80,.55)", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: `OI ${(x.oi / 1000).toFixed(0)}k` })));
  }

  /* ---------------- legend ---------------- */
  function legend(i) {
    const el = document.getElementById("pcLegend"); if (!el || !mainData) return;
    const n = mainData.t.length; if (i == null || i < 0 || i >= n) i = n - 1;
    const d = mainData, ch = i ? d.c[i] - d.c[i - 1] : 0, chp = i && d.c[i - 1] ? ch / Math.abs(d.c[i - 1]) * 100 : 0;
    const dp = Math.abs(d.c[i]) < 10 ? 4 : 2;
    const m = BMR.meta(S.sym);
    let html = `<div class="pc-lh"><b>${BMR.esc(S.sym)}</b>${m && m.n ? `<span class="pc-mut"> ${BMR.esc(m.n)}</span>` : ""} <span class="pc-mut">· ${S.tf} · ${d.t[i]}</span>
      <span>O <i>${BMR.fmt(d.o[i], dp)}</i></span><span>H <i>${BMR.fmt(d.h[i], dp)}</i></span><span>L <i>${BMR.fmt(d.l[i], dp)}</i></span><span>C <i>${BMR.fmt(d.c[i], dp)}</i></span>
      <span class="${BMR.cls(ch)}">${BMR.sgn(ch, dp)} (${BMR.pct(chp, 2)})</span></div>`;
    const t = d.t[i];
    const byPane = {};
    legendRows.forEach(r => {
      let v;
      if (r.cmp) { const j = r.cmp.t.indexOf(t); v = j >= 0 ? BMR.fmt(r.cmp.c[j], 2) : "—"; }
      else { const j = i - (r.shift || 0); const x = j >= 0 ? r.v[j] : null; v = x == null ? "—" : r.fmtv ? r.fmtv(x) : BMR.fmt(x, Math.abs(x) < 10 ? 3 : 2); }
      (byPane[r.pane] = byPane[r.pane] || []).push(`<span><em style="background:${r.c}"></em>${BMR.esc(r.t)} <i>${v}</i></span>`);
    });
    html += `<div class="pc-lr">${(byPane[0] || []).join("")}</div>`;
    el.innerHTML = html;
    // pane legends
    root.querySelectorAll(".pc-pl").forEach(x => x.remove());
    if (!chart) return;
    let top = 0;
    const panes = chart.panes();
    panes.forEach((p, k) => {
      const h = p.getHeight();
      if (k > 0 && byPane[k]) {
        const div = document.createElement("div"); div.className = "pc-pl pc-lr"; div.style.top = (top + 4) + "px"; div.innerHTML = byPane[k].join("");
        root.querySelector(".pc-main").appendChild(div);
      }
      top += h + 1;
    });
  }
  function onCross(p) {
    legend(p && p.logical != null ? Math.round(p.logical) : null);
    hover = p && p.point ? p.point : null;
    if (pending) paint();
  }

  /* ---------------- drawings ---------------- */
  function saveDraws() { LS.set("draw." + S.sym, draws); }
  function setTool(t) { S.tool = t; pending = null; canvas.style.cursor = t === "cursor" ? "" : "crosshair"; syncChips(); }
  const ms = t => Date.parse(t + "T00:00:00Z");
  function timeToLogical(t) {
    const tt = bars.t, x = ms(t), n = tt.length;
    if (!n) return 0;
    const step = n > 21 ? (ms(tt[n - 1]) - ms(tt[n - 21])) / 20 : 864e5;
    if (x >= ms(tt[n - 1])) return n - 1 + (x - ms(tt[n - 1])) / step;
    if (x <= ms(tt[0])) return (x - ms(tt[0])) / step;
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ms(tt[m]) <= x) lo = m; else hi = m; }
    return lo + (x - ms(tt[lo])) / (ms(tt[hi]) - ms(tt[lo]));
  }
  function logicalToTime(l) {
    const tt = bars.t, n = tt.length;
    const step = n > 21 ? (ms(tt[n - 1]) - ms(tt[n - 21])) / 20 : 864e5;
    const i = Math.round(l);
    if (i >= 0 && i < n) return tt[i];
    const base = i < 0 ? ms(tt[0]) + i * step : ms(tt[n - 1]) + (i - n + 1) * step;
    return new Date(base).toISOString().slice(0, 10);
  }
  function toXY(pt) {
    const x = chart.timeScale().logicalToCoordinate(timeToLogical(pt.t));
    const y = main.priceToCoordinate(pt.p);
    return x == null || y == null ? null : [x, y];
  }
  function fromXY(x, y) {
    const l = chart.timeScale().coordinateToLogical(x); if (l == null) return null;
    let p = main.coordinateToPrice(y); if (p == null) return null;
    const t = logicalToTime(l);
    if (S.magnet && mainData) {
      const i = mainData.t.indexOf(t);
      if (i >= 0) { const c = [mainData.o[i], mainData.h[i], mainData.l[i], mainData.c[i]]; const best = c.reduce((a, b) => Math.abs(main.priceToCoordinate(b) - y) < Math.abs(main.priceToCoordinate(a) - y) ? b : a); if (Math.abs(main.priceToCoordinate(best) - y) < 14) p = best; }
    }
    return { t, p };
  }
  function relXY(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function plotW() { try { return chart.timeScale().width(); } catch (e) { return canvas.width; } }
  function plotH() { try { return chart.panes()[0].getHeight(); } catch (e) { return canvas.height; } }
  function inPlot(x, y) { return x >= 0 && y >= 0 && x <= plotW() && y <= plotH(); }
  function onDown(e) {
    if (!chart || e.button !== 0) return;
    const [x, y] = relXY(e); if (!inPlot(x, y)) return;
    if (S.tool !== "cursor") {
      e.stopPropagation(); e.preventDefault();
      const pt = fromXY(x, y); if (!pt) return;
      if (!pending) pending = { k: S.tool, pts: [pt] }; else pending.pts.push(pt);
      if (pending.pts.length >= NPTS[pending.k]) finish();
      paint(); return;
    }
    // select / drag existing drawing
    const hit = hitTest(x, y);
    if (hit) {
      selected = hit.i; e.stopPropagation(); e.preventDefault();
      chart.applyOptions({ handleScroll: false, handleScale: false });
      drag = { i: hit.i, h: hit.h, start: fromXY(x, y), orig: JSON.parse(JSON.stringify(draws[hit.i].pts)) };
      paint();
    } else if (selected >= 0) { selected = -1; paint(); }
  }
  function onMove(e) {
    if (!chart || !canvas) return;
    const [x, y] = relXY(e);
    if (drag) {
      const cur = fromXY(x, y); if (!cur) return;
      const d = draws[drag.i];
      if (drag.h >= 0) { d.pts[drag.h] = cur; }
      else {
        const dl = timeToLogical(cur.t) - timeToLogical(drag.start.t), dp = cur.p - drag.start.p;
        d.pts = drag.orig.map(p => ({ t: logicalToTime(timeToLogical(p.t) + dl), p: p.p + dp }));
      }
      paint(); return;
    }
    if (pending) { hover = { x, y }; paint(); }
    else if (S.tool === "cursor" && inPlot(x, y)) { canvas.parentElement.style.cursor = hitTest(x, y) ? "move" : ""; }
  }
  function onUp() {
    if (drag) { drag = null; chart.applyOptions({ handleScroll: true, handleScale: true }); saveDraws(); }
  }
  function finish() {
    const d = pending; pending = null;
    if (d.k === "text") { const s = prompt("Note text"); if (!s) { setTool("cursor"); return; } d.text = s; }
    if (d.k === "measure") { draws.push(d); selected = draws.length - 1; setTool("cursor"); paint(); setTimeout(() => { const i = draws.indexOf(d); if (i >= 0) { draws.splice(i, 1); if (selected === i) selected = -1; paint(); } }, 12000); return; }
    draws.push(d); selected = draws.length - 1; saveDraws(); setTool("cursor");
  }
  function segDist(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy; let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - ax - t * dx, py - ay - t * dy); }
  function hitTest(x, y) {
    for (let i = draws.length - 1; i >= 0; i--) {
      const d = draws[i], P = d.pts.map(toXY); if (P.some(p => !p)) continue;
      for (let h = 0; h < P.length; h++) if (Math.hypot(P[h][0] - x, P[h][1] - y) < 7) return { i, h };
      const W = plotW();
      let near = false;
      if (d.k === "hline") near = Math.abs(P[0][1] - y) < 5;
      else if (d.k === "hray") near = Math.abs(P[0][1] - y) < 5 && x >= P[0][0];
      else if (d.k === "vline") near = Math.abs(P[0][0] - x) < 5;
      else if (d.k === "rect" || d.k === "fib" || d.k === "measure") { const [a, b] = P; near = x >= Math.min(a[0], b[0]) - 4 && x <= Math.max(a[0], b[0]) + 4 && y >= Math.min(a[1], b[1]) - 4 && y <= Math.max(a[1], b[1]) + 4; }
      else if (d.k === "text") near = Math.abs(P[0][0] - x) < 60 && Math.abs(P[0][1] - y) < 12;
      else if (P.length >= 2) {
        const ext = ext2(P[0], P[1], d.k, W); near = segDist(x, y, ext[0][0], ext[0][1], ext[1][0], ext[1][1]) < 5;
        if (!near && d.k === "channel" && P[2]) { const off = P[2][1] - lineY(P[0], P[1], P[2][0]); near = segDist(x, y, P[0][0], P[0][1] + off, P[1][0], P[1][1] + off) < 5; }
      }
      if (near) return { i, h: -1 };
    }
    return null;
  }
  function lineY(a, b, x) { return b[0] === a[0] ? a[1] : a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
  function ext2(a, b, k, W) {
    if (k === "ray") { const x2 = b[0] >= a[0] ? W : 0; return [a, [x2, lineY(a, b, x2)]]; }
    if (k === "xline") return [[0, lineY(a, b, 0)], [W, lineY(a, b, W)]];
    return [a, b];
  }
  function resize() {
    if (!canvas) return;
    const el = canvas.parentElement, dpr = window.devicePixelRatio || 1;
    canvas.width = el.clientWidth * dpr; canvas.height = el.clientHeight * dpr;
    canvas.style.width = el.clientWidth + "px"; canvas.style.height = el.clientHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(); legend(null);
  }
  function paint() {
    if (!ctx || !chart || !main) return;
    const W = canvas.width, H = canvas.height; ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.restore();
    const pw = plotW(), ph = plotH();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    const all = draws.map((d, i) => ({ d, i }));
    if (pending && hover) { const p = fromXY(hover.x, hover.y); if (p) all.push({ d: { ...pending, pts: [...pending.pts, p] }, i: -2 }); }
    all.forEach(({ d, i }) => drawOne(d, i === selected || i === -2, pw, ph));
    ctx.restore();
  }
  function drawOne(d, sel, W, H) {
    const P = d.pts.map(toXY); if (P.some(p => !p)) return;
    const col = d.c || (d.k === "measure" ? "#D2A93F" : "#5AA9E6");
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = sel ? 2 : 1.4; ctx.setLineDash([]); ctx.font = "11px ui-monospace,Menlo,monospace";
    const ln = (a, b) => { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); };
    const priceTxt = p => BMR.fmt(p, Math.abs(p) < 10 ? 4 : 2);
    if (d.k === "hline" || d.k === "hray") { ln([d.k === "hray" ? P[0][0] : 0, P[0][1]], [W, P[0][1]]); ctx.fillText(priceTxt(d.pts[0].p), W - 70, P[0][1] - 4); }
    else if (d.k === "vline") ln([P[0][0], 0], [P[0][0], H]);
    else if (d.k === "text") { ctx.font = "12px Inter,system-ui,sans-serif"; ctx.fillStyle = "#E7EDE9"; ctx.fillText(d.text || "", P[0][0] + 4, P[0][1] - 4); ctx.beginPath(); ctx.arc(P[0][0], P[0][1], 2.5, 0, 7); ctx.fillStyle = col; ctx.fill(); }
    else if (P.length >= 2) {
      const [a, b] = P;
      if (d.k === "rect") { ctx.globalAlpha = .12; ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.globalAlpha = 1; ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
      else if (d.k === "fib") {
        const p0 = d.pts[0].p, p1 = d.pts[1].p, x0 = Math.min(a[0], b[0]), x1 = Math.max(W, Math.max(a[0], b[0]));
        FIBS.forEach((f, k) => { const pr = p1 + (p0 - p1) * f, y = main.priceToCoordinate(pr); if (y == null) return; ctx.strokeStyle = ["#7C8E85", "#E06A50", "#D2A93F", "#34C289", "#5AA9E6", "#8C7BE0", "#7C8E85", "#E36FA8", "#E36FA8"][k]; ln([x0, y], [x1, y]); ctx.fillStyle = ctx.strokeStyle; ctx.fillText(`${f} (${priceTxt(pr)})`, x0 + 3, y - 3); });
        ctx.strokeStyle = col; ctx.setLineDash([4, 4]); ln(a, b); ctx.setLineDash([]);
      } else if (d.k === "measure") {
        const dp = d.pts[1].p - d.pts[0].p, pc = dp / Math.abs(d.pts[0].p) * 100, nb = Math.round(timeToLogical(d.pts[1].t) - timeToLogical(d.pts[0].t)), days = Math.round((ms(d.pts[1].t) - ms(d.pts[0].t)) / 864e5);
        ctx.globalAlpha = .14; ctx.fillStyle = dp >= 0 ? COL.up : COL.down; ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.globalAlpha = 1;
        ctx.strokeStyle = dp >= 0 ? COL.up : COL.down; ln(a, b);
        const txt = `${BMR.sgn(dp, Math.abs(d.pts[0].p) < 10 ? 4 : 2)} (${BMR.pct(pc, 2)}) · ${nb} bars · ${days}d`;
        const tw = ctx.measureText(txt).width; ctx.fillStyle = "rgba(15,23,19,.92)"; ctx.fillRect(b[0] + 6, b[1] - 16, tw + 10, 18); ctx.fillStyle = "#E7EDE9"; ctx.fillText(txt, b[0] + 11, b[1] - 3);
      } else {
        const e = ext2(a, b, d.k, W); ln(e[0], e[1]);
        if (d.k === "channel" && P[2]) { const off = P[2][1] - lineY(a, b, P[2][0]); ln([a[0], a[1] + off], [b[0], b[1] + off]); ctx.globalAlpha = .08; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(b[0], b[1] + off); ctx.lineTo(a[0], a[1] + off); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; }
      }
    }
    if (sel) P.forEach(p => { ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, 7); ctx.fillStyle = "#0F1713"; ctx.fill(); ctx.strokeStyle = col; ctx.stroke(); });
  }
  function screenshot() {
    if (!chart) return;
    const c = chart.takeScreenshot(true, false), g = c.getContext("2d");
    g.drawImage(canvas, 0, 0, c.width, c.height);
    const a = document.createElement("a"); a.download = `${S.sym.replace(/[^A-Za-z0-9=._-]+/g, "_")}_${S.tf}.png`; a.href = c.toDataURL("image/png"); a.click();
  }

  return { open, render, current: () => S.sym, IND };
})();
