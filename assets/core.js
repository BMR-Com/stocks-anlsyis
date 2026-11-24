/* Shared data + maths for the Pro Chart, Seasonality, Commodities and Options Analytics tabs.
   Everything is computed in the browser from the JSON files in data/. */
"use strict";
const BMR = (() => {
  const cache = {}, pend = {};
  let INDEX = null, CHARTS = null, KNOWN = null;

  // some data files carry bare NaN / Infinity (not valid JSON): read them as null
  async function json(p) { const r = await fetch(p, { cache: "no-cache" }); if (!r.ok) throw new Error(p + " " + r.status); const t = await r.text(); try { return JSON.parse(t); } catch (e) { return JSON.parse(t.replace(/-?\bInfinity\b|\bNaN\b/g, "null")); } }
  async function text(p) { const r = await fetch(p, { cache: "no-cache" }); if (!r.ok) throw new Error(p + " " + r.status); return r.text(); }
  const safe = s => s.replace(/\^/g, "_I_").replace(/=/g, "_").replace(/\//g, "_").replace(/!/g, "").replace(/:/g, "_");

  async function index() {
    if (INDEX) return INDEX;
    try { INDEX = await json("data/hist/index.json"); } catch (e) { INDEX = {}; }
    try { CHARTS = await json("data/charts_index.json"); } catch (e) { CHARTS = []; }
    KNOWN = new Set([...Object.keys(INDEX), ...CHARTS]);
    return INDEX;
  }
  function known() { return KNOWN || new Set(); }
  function meta(sym) { return (INDEX && INDEX[sym]) || null; }
  function symbolList() {
    const out = [];
    Object.entries(INDEX || {}).forEach(([s, m]) => out.push({ s, n: m.n || "", g: m.g || "", k: m.k || "" }));
    (CHARTS || []).forEach(s => { if (!INDEX || !INDEX[s]) out.push({ s, n: "", g: "Stock", k: "stock" }); });
    return out;
  }

  /* ---------- series loading: long history first, then the 2-year chart file */
  async function series(sym) {
    sym = sym.trim();
    if (cache[sym]) return cache[sym];
    if (pend[sym]) return pend[sym];
    pend[sym] = (async () => {
      const f = safe(sym);
      const parts = [];
      for (const p of [`data/hist/${f}.base.json`, `data/hist/${f}.json`]) {
        try { parts.push(await json(p)); } catch (e) { }
      }
      let src = "history";
      if (!parts.length) {
        try { parts.push(await json(`data/charts/${sym}.json`)); src = "2-year chart file"; } catch (e) { }
      }
      if (!parts.length) { delete pend[sym]; throw new Error("No data for " + sym); }
      const m = new Map();
      parts.forEach(d => d.t.forEach((t, i) => { if (d.c[i] != null && Number.isFinite(d.c[i])) m.set(t, [d.o[i], d.h[i], d.l[i], d.c[i], (d.v || [])[i] || 0]); }));
      const t = [...m.keys()].sort();
      const out = { sym, src, t, o: [], h: [], l: [], c: [], v: [] };
      t.forEach(k => { const r = m.get(k); out.o.push(r[0] ?? r[3]); out.h.push(r[1] ?? r[3]); out.l.push(r[2] ?? r[3]); out.c.push(r[3]); out.v.push(r[4]); });
      cache[sym] = out; delete pend[sym];
      return out;
    })();
    return pend[sym];
  }

  /* ---------- expression engine: "BZ=F - CL=F", "ZS=F/ZC=F", "(2*RB=F*42+HO=F*42-3*CL=F)/3" */
  const SYMCH = /[A-Za-z0-9\^=._:!\-]/;
  function tokenize(expr) {
    const toks = []; let i = 0; const K = known();
    while (i < expr.length) {
      const ch = expr[i];
      if (/\s/.test(ch)) { i++; continue; }
      if ("+-*/()".includes(ch)) {
        // a leading minus is unary
        toks.push({ k: "op", v: ch }); i++; continue;
      }
      if (/[0-9.]/.test(ch)) {
        let j = i; while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
        const nxt = expr[j];
        if (!nxt || !SYMCH.test(nxt) || nxt === "-") { toks.push({ k: "num", v: parseFloat(expr.slice(i, j)) }); i = j; continue; }
      }
      if (ch === "{" || ch === "[" || ch === '"') {
        const close = ch === "{" ? "}" : ch === "[" ? "]" : '"';
        const j = expr.indexOf(close, i + 1); if (j < 0) throw new Error("Unclosed " + ch);
        toks.push({ k: "sym", v: expr.slice(i + 1, j).trim().toUpperCase() }); i = j + 1; continue;
      }
      if (SYMCH.test(ch)) {
        let j = i; while (j < expr.length && SYMCH.test(expr[j])) j++;
        let run = expr.slice(i, j);
        // a hyphen can be part of a symbol (BTC-USD, DX-Y.NYB) or a minus: take the longest known prefix
        let take = run;
        if (run.includes("-")) {
          take = null;
          const cuts = [run.length]; for (let q = run.length - 1; q > 0; q--) if (run[q] === "-") cuts.push(q);
          for (const q of cuts) { const s = run.slice(0, q); if (K.has(s.toUpperCase()) || K.has(s)) { take = s; break; } }
          if (!take) take = run.split("-")[0];
        }
        toks.push({ k: "sym", v: take.toUpperCase() }); i += take.length; continue;
      }
      throw new Error("Unexpected '" + ch + "'");
    }
    // mark unary minus
    toks.forEach((t, n) => { if (t.k === "op" && t.v === "-" && (n === 0 || (toks[n - 1].k === "op" && toks[n - 1].v !== ")"))) t.v = "neg"; });
    return toks;
  }
  function toRPN(toks) {
    const out = [], st = [], P = { "+": 1, "-": 1, "*": 2, "/": 2, neg: 3 };
    toks.forEach(t => {
      if (t.k !== "op") { out.push(t); return; }
      if (t.v === "(") { st.push(t); return; }
      if (t.v === ")") { while (st.length && st.at(-1).v !== "(") out.push(st.pop()); if (!st.length) throw new Error("Mismatched )"); st.pop(); return; }
      while (st.length && st.at(-1).v !== "(" && (P[st.at(-1).v] > P[t.v] || (P[st.at(-1).v] === P[t.v] && t.v !== "neg"))) out.push(st.pop());
      st.push(t);
    });
    while (st.length) { const t = st.pop(); if (t.v === "(") throw new Error("Mismatched ("); out.push(t); }
    return out;
  }
  function evalRPN(rpn, env) {
    const st = [];
    rpn.forEach(t => {
      if (t.k === "num") st.push(t.v);
      else if (t.k === "sym") st.push(env[t.v]);
      else if (t.v === "neg") st.push(-st.pop());
      else { const b = st.pop(), a = st.pop(); st.push(t.v === "+" ? a + b : t.v === "-" ? a - b : t.v === "*" ? a * b : a / b); }
    });
    return st[0];
  }
  function isExpr(s) { const t = tokenize(s); return t.length > 1; }
  /* returns {sym, t, o, h, l, c, v, expr:true} aligned on dates every leg has */
  async function evaluate(expr) {
    await index();
    const toks = tokenize(expr);
    const syms = [...new Set(toks.filter(t => t.k === "sym").map(t => t.v))];
    if (!syms.length) throw new Error("No symbol in expression");
    if (toks.length === 1) return series(syms[0]);
    const data = await Promise.all(syms.map(s => series(s)));
    const rpn = toRPN(toks);
    const maps = data.map(d => { const m = new Map(); d.t.forEach((t, i) => m.set(t, i)); return m; });
    let dates = data[0].t.filter(t => maps.every(m => m.has(t)));
    const out = { sym: expr, expr: true, src: "calculated", t: [], o: [], h: [], l: [], c: [], v: [], legs: syms };
    dates.forEach(t => {
      const val = f => { const env = {}; syms.forEach((s, k) => env[s] = data[k][f][maps[k].get(t)]); return evalRPN(rpn, env); };
      const o = val("o"), c = val("c"), h = val("h"), l = val("l");
      if (![o, c, h, l].every(Number.isFinite)) return;
      out.t.push(t); out.o.push(o); out.c.push(c); out.h.push(Math.max(o, c, h, l)); out.l.push(Math.min(o, c, h, l)); out.v.push(0);
    });
    if (!out.t.length) throw new Error("The legs have no dates in common");
    // spreads (anything with + or -) are measured in price changes, ratios in % changes
    out.additive = rpn.some(t => t.k === "op" && (t.v === "+" || t.v === "-"));
    return out;
  }
  const load = s => evaluate(s);

  /* ---------- resampling */
  function weekKey(t) { const d = new Date(t + "T00:00:00Z"); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); }
  function resample(s, tf) {
    if (tf === "D") return s;
    const key = tf === "W" ? weekKey : tf === "M" ? (t => t.slice(0, 7)) : tf === "Q" ? (t => t.slice(0, 4) + "Q" + Math.ceil(+t.slice(5, 7) / 3)) : (t => t.slice(0, 4));
    const out = { ...s, t: [], o: [], h: [], l: [], c: [], v: [] };
    let cur = null;
    s.t.forEach((t, i) => {
      const k = key(t);
      if (k !== cur) { cur = k; out.t.push(t); out.o.push(s.o[i]); out.h.push(s.h[i]); out.l.push(s.l[i]); out.c.push(s.c[i]); out.v.push(s.v[i] || 0); }
      else { const n = out.t.length - 1; out.t[n] = t; out.h[n] = Math.max(out.h[n], s.h[i]); out.l[n] = Math.min(out.l[n], s.l[i]); out.c[n] = s.c[i]; out.v[n] += s.v[i] || 0; }
    });
    return out;
  }

  /* ---------- technical indicators (arrays in, arrays out, null where undefined) */
  const TA = {
    sma(a, n) { const o = Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; },
    ema(a, n) { const o = Array(a.length).fill(null), k = 2 / (n + 1); let e = null, s = 0; for (let i = 0; i < a.length; i++) { if (a[i] == null) continue; if (e == null) { s += a[i]; if (i >= n - 1) { e = s / n; o[i] = e; } continue; } e = a[i] * k + e * (1 - k); o[i] = e; } return o; },
    rma(a, n) { const o = Array(a.length).fill(null); let e = null, s = 0, c = 0; for (let i = 0; i < a.length; i++) { if (a[i] == null) continue; if (e == null) { s += a[i]; c++; if (c === n) { e = s / n; o[i] = e; } continue; } e = (e * (n - 1) + a[i]) / n; o[i] = e; } return o; },
    wma(a, n) { const o = Array(a.length).fill(null), d = n * (n + 1) / 2; for (let i = n - 1; i < a.length; i++) { let s = 0; for (let j = 0; j < n; j++) s += a[i - j] * (n - j); o[i] = s / d; } return o; },
    hma(a, n) { const h = TA.wma(a, Math.max(1, Math.round(n / 2))), f = TA.wma(a, n); const d = a.map((_, i) => h[i] == null || f[i] == null ? null : 2 * h[i] - f[i]); const st = d.findIndex(x => x != null); const r = TA.wma(d.slice(st), Math.max(1, Math.round(Math.sqrt(n)))); return [...Array(st).fill(null), ...r]; },
    vwma(c, v, n) { const o = Array(c.length).fill(null); for (let i = n - 1; i < c.length; i++) { let pv = 0, vv = 0; for (let j = i - n + 1; j <= i; j++) { pv += c[j] * v[j]; vv += v[j]; } o[i] = vv ? pv / vv : null; } return o; },
    std(a, n) { const o = Array(a.length).fill(null); for (let i = n - 1; i < a.length; i++) { let s = 0, q = 0; for (let j = i - n + 1; j <= i; j++) { s += a[j]; q += a[j] * a[j]; } const m = s / n; o[i] = Math.sqrt(Math.max(q / n - m * m, 0)); } return o; },
    bb(c, n, m) { const mid = TA.sma(c, n), sd = TA.std(c, n); return { mid, up: mid.map((x, i) => x == null ? null : x + m * sd[i]), lo: mid.map((x, i) => x == null ? null : x - m * sd[i]) }; },
    tr(h, l, c) { return h.map((x, i) => i === 0 ? x - l[i] : Math.max(x - l[i], Math.abs(x - c[i - 1]), Math.abs(l[i] - c[i - 1]))); },
    atr(h, l, c, n) { return TA.rma(TA.tr(h, l, c), n); },
    keltner(h, l, c, n, m, an) { const mid = TA.ema(c, n), a = TA.atr(h, l, c, an); return { mid, up: mid.map((x, i) => x == null || a[i] == null ? null : x + m * a[i]), lo: mid.map((x, i) => x == null || a[i] == null ? null : x - m * a[i]) }; },
    donchian(h, l, n) { const up = h.map((_, i) => i < n - 1 ? null : Math.max(...h.slice(i - n + 1, i + 1))), lo = l.map((_, i) => i < n - 1 ? null : Math.min(...l.slice(i - n + 1, i + 1))); return { up, lo, mid: up.map((x, i) => x == null ? null : (x + lo[i]) / 2) }; },
    rsi(c, n) { const g = [null], d = [null]; for (let i = 1; i < c.length; i++) { const x = c[i] - c[i - 1]; g.push(Math.max(x, 0)); d.push(Math.max(-x, 0)); } const ag = TA.rma(g, n), al = TA.rma(d, n); return c.map((_, i) => ag[i] == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i])); },
    macd(c, f, s, sg) { const a = TA.ema(c, f), b = TA.ema(c, s); const line = c.map((_, i) => a[i] == null || b[i] == null ? null : a[i] - b[i]); const sig = TA.ema(line, sg); return { line, sig, hist: line.map((x, i) => x == null || sig[i] == null ? null : x - sig[i]) }; },
    stoch(h, l, c, kp, ks, dp) { const raw = c.map((_, i) => { if (i < kp - 1) return null; const hh = Math.max(...h.slice(i - kp + 1, i + 1)), ll = Math.min(...l.slice(i - kp + 1, i + 1)); return hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100; }); const k = TA.smaN(raw, ks); return { k, d: TA.smaN(k, dp) }; },
    smaN(a, n) { const o = Array(a.length).fill(null); for (let i = 0; i < a.length; i++) { if (i < n - 1) continue; const w = a.slice(i - n + 1, i + 1); if (w.some(x => x == null)) continue; o[i] = w.reduce((x, y) => x + y, 0) / n; } return o; },
    stochrsi(c, rn, sn, k, d) { const r = TA.rsi(c, rn); const raw = r.map((x, i) => { if (i < sn - 1 || x == null) return null; const w = r.slice(i - sn + 1, i + 1); if (w.some(z => z == null)) return null; const hh = Math.max(...w), ll = Math.min(...w); return hh === ll ? 50 : (x - ll) / (hh - ll) * 100; }); const kk = TA.smaN(raw, k); return { k: kk, d: TA.smaN(kk, d) }; },
    cci(h, l, c, n) { const tp = c.map((x, i) => (h[i] + l[i] + x) / 3), m = TA.sma(tp, n); return tp.map((x, i) => { if (m[i] == null) return null; let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]); md /= n; return md ? (x - m[i]) / (0.015 * md) : 0; }); },
    willr(h, l, c, n) { return c.map((x, i) => { if (i < n - 1) return null; const hh = Math.max(...h.slice(i - n + 1, i + 1)), ll = Math.min(...l.slice(i - n + 1, i + 1)); return hh === ll ? -50 : (hh - x) / (hh - ll) * -100; }); },
    adx(h, l, c, n) { const pdm = [0], mdm = [0]; for (let i = 1; i < c.length; i++) { const u = h[i] - h[i - 1], d = l[i - 1] - l[i]; pdm.push(u > d && u > 0 ? u : 0); mdm.push(d > u && d > 0 ? d : 0); } const tr = TA.rma(TA.tr(h, l, c), n), p = TA.rma(pdm, n), m = TA.rma(mdm, n); const pdi = p.map((x, i) => x == null || !tr[i] ? null : 100 * x / tr[i]), mdi = m.map((x, i) => x == null || !tr[i] ? null : 100 * x / tr[i]); const dx = pdi.map((x, i) => x == null || mdi[i] == null || (x + mdi[i]) === 0 ? null : 100 * Math.abs(x - mdi[i]) / (x + mdi[i])); return { adx: TA.rma(dx, n), pdi, mdi }; },
    obv(c, v) { const o = [0]; for (let i = 1; i < c.length; i++) o.push(o[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0)); return o; },
    mfi(h, l, c, v, n) { const tp = c.map((x, i) => (h[i] + l[i] + x) / 3); return c.map((_, i) => { if (i < n) return null; let p = 0, m = 0; for (let j = i - n + 1; j <= i; j++) { const f = tp[j] * v[j]; if (tp[j] > tp[j - 1]) p += f; else if (tp[j] < tp[j - 1]) m += f; } return m === 0 ? 100 : 100 - 100 / (1 + p / m); }); },
    roc(c, n) { return c.map((x, i) => i < n ? null : (x / c[i - n] - 1) * 100); },
    hv(c, n, ann) { const r = c.map((x, i) => i === 0 ? null : Math.log(x / c[i - 1])); return c.map((_, i) => { if (i < n) return null; const w = r.slice(i - n + 1, i + 1); const m = w.reduce((a, b) => a + b, 0) / n; return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) * ann) * 100; }); },
    zscore(c, n) { const m = TA.sma(c, n), s = TA.std(c, n); return c.map((x, i) => m[i] == null || !s[i] ? null : (x - m[i]) / s[i]); },
    psar(h, l, step, mx) { const n = h.length, o = Array(n).fill(null); if (n < 3) return o; let up = h[1] > h[0], af = step, ep = up ? h[1] : l[1], sar = up ? l[0] : h[0]; for (let i = 1; i < n; i++) { sar = sar + af * (ep - sar); if (up) { sar = Math.min(sar, l[i - 1], i > 1 ? l[i - 2] : l[i - 1]); if (l[i] < sar) { up = false; sar = ep; ep = l[i]; af = step; } else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, mx); } } else { sar = Math.max(sar, h[i - 1], i > 1 ? h[i - 2] : h[i - 1]); if (h[i] > sar) { up = true; sar = ep; ep = h[i]; af = step; } else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, mx); } } o[i] = sar; } return o; },
    supertrend(h, l, c, n, m) { const a = TA.atr(h, l, c, n), o = Array(c.length).fill(null), dir = Array(c.length).fill(1); let fu = null, fl = null; for (let i = 0; i < c.length; i++) { if (a[i] == null) continue; const hl = (h[i] + l[i]) / 2, bu = hl + m * a[i], bl = hl - m * a[i]; fu = fu == null || bu < fu || c[i - 1] > fu ? bu : fu; fl = fl == null || bl > fl || c[i - 1] < fl ? bl : fl; const pd = i ? dir[i - 1] : 1; dir[i] = pd === 1 ? (c[i] < fl ? -1 : 1) : (c[i] > fu ? 1 : -1); o[i] = dir[i] === 1 ? fl : fu; } return { line: o, dir }; },
    ichimoku(h, l, a, b, cc) { const mid = (n, i) => i < n - 1 ? null : (Math.max(...h.slice(i - n + 1, i + 1)) + Math.min(...l.slice(i - n + 1, i + 1))) / 2; const ten = h.map((_, i) => mid(a, i)), kij = h.map((_, i) => mid(b, i)), spanA = ten.map((x, i) => x == null || kij[i] == null ? null : (x + kij[i]) / 2), spanB = h.map((_, i) => mid(cc, i)); return { ten, kij, spanA, spanB }; },
    linreg(c, n) { return c.map((_, i) => { if (i < n - 1) return null; let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let j = 0; j < n; j++) { const y = c[i - n + 1 + j]; sx += j; sy += y; sxy += j * y; sxx += j * j; } const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a0 = (sy - b * sx) / n; return a0 + b * (n - 1); }); },
  };

  /* ---------- seasonality */
  function doy(t) { const d = new Date(t + "T00:00:00Z"), y = Date.UTC(d.getUTCFullYear(), 0, 1); return Math.floor((d - y) / 864e5); }
  function byYear(s) { const g = {}; s.t.forEach((t, i) => { const y = +t.slice(0, 4); (g[y] = g[y] || { t: [], c: [] }); g[y].t.push(t); g[y].c.push(s.c[i]); }); return g; }
  /* additive mode for series that can be <= 0 (spreads): changes instead of % returns */
  function isAdditive(s) { return s.additive ?? s.c.some(x => x <= 0); }
  /* path per year on a 0..365 calendar grid (value = % change, or change, from the last close of the previous year) */
  function yearPaths(s, opt = {}) {
    const add = opt.additive ?? isAdditive(s), g = byYear(s), years = Object.keys(g).map(Number).sort();
    const startDoy = opt.startDoy || 0; // seasonal year can start mid-year (e.g. crop year)
    const paths = {};
    // rebuild groups by seasonal year when startDoy > 0
    const grp = {};
    s.t.forEach((t, i) => { const y = +t.slice(0, 4), d = doy(t); const sy = d >= startDoy ? y : y - 1; (grp[sy] = grp[sy] || []).push(i); });
    Object.keys(grp).map(Number).sort().forEach(sy => {
      const ix = grp[sy]; const prevI = ix[0] - 1;
      const base = prevI >= 0 ? s.c[prevI] : s.o[ix[0]];
      if (!Number.isFinite(base) || (!add && base <= 0)) return;
      const arr = Array(366).fill(null);
      ix.forEach(i => { let d = doy(s.t[i]) - startDoy; if (d < 0) d += 365; d = Math.min(d, 365); arr[d] = add ? s.c[i] - base : (s.c[i] / base - 1) * 100; });
      // forward-fill gaps (weekends/holidays) up to the last observed day
      let last = null, lastIdx = arr.reduce((m, v, k) => v != null ? k : m, -1);
      for (let k = 0; k <= lastIdx; k++) { if (arr[k] == null) arr[k] = last ?? 0; else last = arr[k]; }
      paths[sy] = { v: arr, lastDay: lastIdx, n: ix.length, first: s.t[ix[0]], last: s.t[ix.at(-1)] };
    });
    return { paths, additive: add };
  }
  function seasonalAverage(yp, years, opt = {}) {
    const avg = Array(366).fill(null), med = Array(366).fill(null), up = Array(366).fill(null);
    const use = years.filter(y => yp.paths[y] && yp.paths[y].lastDay >= 300);
    for (let d = 0; d < 366; d++) {
      const v = use.map(y => yp.paths[y].v[d]).filter(x => x != null);
      if (v.length < 2) continue;
      avg[d] = v.reduce((a, b) => a + b, 0) / v.length;
      const s = [...v].sort((a, b) => a - b); med[d] = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      up[d] = v.filter(x => x > 0).length / v.length * 100;
    }
    if (opt.detrend && avg[365] != null) { const k = avg[365] / 365; for (let d = 0; d < 366; d++) { if (avg[d] != null) avg[d] -= k * d; if (med[d] != null) med[d] -= (med[365] ?? 0) / 365 * d; } }
    return { avg, med, up, years: use };
  }
  function monthlyTable(s) {
    const add = isAdditive(s); const mm = {}; let prev = null, prevKey = null;
    // month-end closes
    const ends = []; s.t.forEach((t, i) => { const k = t.slice(0, 7); if (k !== prevKey) { if (prevKey) ends.push([prevKey, prev]); prevKey = k; } prev = s.c[i]; });
    if (prevKey) ends.push([prevKey, prev, true]);
    for (let i = 1; i < ends.length; i++) { const [k, c, partial] = ends[i], p = ends[i - 1][1]; const y = +k.slice(0, 4), m = +k.slice(5, 7); (mm[y] = mm[y] || {})[m] = { r: add ? c - p : (c / p - 1) * 100, partial: !!partial }; }
    // full-year
    const yr = {}; const ye = {}; s.t.forEach((t, i) => ye[+t.slice(0, 4)] = s.c[i]);
    const ys = Object.keys(ye).map(Number).sort(); ys.forEach((y, k) => { if (k) yr[y] = add ? ye[y] - ye[ys[k - 1]] : (ye[y] / ye[ys[k - 1]] - 1) * 100; });
    return { mm, yr, additive: add };
  }
  function stats(v) { v = v.filter(Number.isFinite); if (!v.length) return null; const n = v.length, m = v.reduce((a, b) => a + b, 0) / n; const s = [...v].sort((a, b) => a - b); const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0; return { n, mean: m, med, sd, win: v.filter(x => x > 0).length / n * 100, best: s[n - 1], worst: s[0] }; }
  function dowStats(s, years) {
    const add = isAdditive(s), g = [[], [], [], [], []];
    for (let i = 1; i < s.t.length; i++) { const y = +s.t[i].slice(0, 4); if (years && !years.includes(y)) continue; const d = new Date(s.t[i] + "T00:00:00Z").getUTCDay(); if (d < 1 || d > 5) continue; g[d - 1].push(add ? s.c[i] - s.c[i - 1] : (s.c[i] / s.c[i - 1] - 1) * 100); }
    return g.map(stats);
  }
  function windowReturns(s, fromMD, toMD, years) {
    // per year: from first close on/after fromMD to last close on/before toMD (window may wrap the year end)
    const add = isAdditive(s), out = [];
    const ys = [...new Set(s.t.map(t => +t.slice(0, 4)))];
    const wrap = toMD < fromMD;
    ys.forEach(y => {
      if (years && !years.includes(y)) return;
      const a = `${y}-${fromMD}`, b = `${wrap ? y + 1 : y}-${toMD}`;
      let i = s.t.findIndex(t => t >= a); if (i < 0) return;
      let j = -1; for (let k = s.t.length - 1; k >= 0; k--) if (s.t[k] <= b) { j = k; break; }
      if (j <= i) return;
      const complete = s.t.at(-1) >= b;
      const lo = Math.min(...s.l.slice(i, j + 1)), hi = Math.max(...s.h.slice(i, j + 1));
      const base = s.c[i];
      out.push({ year: y, from: s.t[i], to: s.t[j], start: base, end: s.c[j], complete,
        r: add ? s.c[j] - base : (s.c[j] / base - 1) * 100,
        maxUp: add ? hi - base : (hi / base - 1) * 100, maxDn: add ? lo - base : (lo / base - 1) * 100 });
    });
    return { rows: out, additive: add };
  }

  /* ---------- formatting */
  const fmt = (x, d = 2) => x == null || !Number.isFinite(x) ? "—" : Math.abs(x) >= 1e5 ? x.toLocaleString(undefined, { maximumFractionDigits: 0 }) : x.toFixed(d);
  const pct = (x, d = 1) => x == null || !Number.isFinite(x) ? "—" : (x > 0 ? "+" : "") + x.toFixed(d) + "%";
  const sgn = (x, d = 2) => x == null || !Number.isFinite(x) ? "—" : (x > 0 ? "+" : "") + x.toFixed(d);
  const cls = x => x == null || !Number.isFinite(x) ? "flat" : x > 0 ? "pos" : x < 0 ? "neg" : "flat";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function heat(x, scale) { if (x == null || !Number.isFinite(x)) return "transparent"; const a = Math.min(Math.abs(x) / scale, 1) * 0.75 + 0.05; return x >= 0 ? `rgba(52,194,137,${a})` : `rgba(224,106,80,${a})`; }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function doyLabel(d) { const dt = new Date(Date.UTC(2001, 0, 1) + d * 864e5); return MONTHS[dt.getUTCMonth()] + " " + dt.getUTCDate(); }

  return { isAdditive, json, text, safe, index, meta, known, symbolList, series, evaluate, load, tokenize, toRPN, evalRPN, isExpr, resample, TA,
    doy, yearPaths, seasonalAverage, monthlyTable, stats, dowStats, windowReturns, fmt, pct, sgn, cls, esc, heat, MONTHS, doyLabel };
})();
if (typeof module !== "undefined") module.exports = BMR;
