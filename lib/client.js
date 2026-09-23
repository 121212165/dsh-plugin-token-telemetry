window.__ModuleLoader__.load({
  id: "dsh-token-telemetry",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;

    // ---------- constants / small helpers ----------
    const SAMPLE = 0.25; // bucket, seconds
    const OR = "#FF6B2C";  // output
    const GR = "#8A8A94";  // thinking
    const TOOL = "#4AA3FF"; // tool wait
    const DIM = "#5A5A62";
    const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
    const key = (turn, step) => turn + "-" + step;

    function estTokens(text) {
      if (!text) return 0;
      let cjk = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0x3000 && c <= 0x9fff) cjk++;
      }
      return cjk + Math.max(0, Math.round((text.length - cjk) / 3.5));
    }
    function niceMax(v) {
      const st = v > 1400 ? 400 : v > 700 ? 200 : v > 200 ? 100 : 50;
      return Math.max(st, Math.ceil(v / st) * st);
    }
    // a readable x-axis step (seconds) giving ~4-6 ticks across a span
    function niceStep(span) {
      const raw = span / 5;
      for (const s of [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600]) if (raw <= s) return s;
      return 900;
    }

    // ---------- sampling ----------
    function streamToPoints(stream, att) {
      const pts = [];
      if (!Array.isArray(stream)) return pts;
      for (const rec of stream) {
        if (!rec) continue;
        if (rec.type === "reasoning-chunks" || rec.type === "text-chunks") {
          const kind = rec.type === "reasoning-chunks" ? "think" : "out";
          const dts = rec.dt || [], texts = rec.texts || [];
          let t = rec.time0 || 0;
          for (let i = 0; i < texts.length; i++) {
            t += dts[i] || 0;
            const tok = estTokens(texts[i]);
            if (tok > 0) pts.push({ t, kind, tok, att });
          }
        } else if (rec.type === "chunk" && rec.chunk) {
          const c = rec.chunk;
          if (c.type === "reasoning-delta") { const tk = estTokens(c.text); if (tk) pts.push({ t: rec.time || 0, kind: "think", tok: tk, att }); }
          else if (c.type === "text-delta") { const tk = estTokens(c.text); if (tk) pts.push({ t: rec.time || 0, kind: "out", tok: tk, att }); }
        }
      }
      return pts;
    }
    function bucketPoints(pts) {
      if (!pts || !pts.length) return { samples: [], peak: 0, span: 0 };
      const sorted = pts.slice().sort((a, b) => a.t - b.t);
      const t0 = sorted[0].t;
      const buckets = [];
      for (const p of sorted) {
        const bi = Math.max(0, Math.floor((p.t - t0) / 1000 / SAMPLE));
        while (buckets.length <= bi) buckets.push({ t: bi * SAMPLE, think: 0, out: 0 });
        buckets[bi][p.kind] += p.tok;
      }
      let peak = 0;
      for (const b of buckets) { b.think /= SAMPLE; b.out /= SAMPLE; const tp = b.think + b.out; if (tp > peak) peak = tp; }
      return { samples: buckets, peak, span: (n2s(buckets.length)) };
    }
    function n2s(len) { return Math.max(0, (len - 1) * SAMPLE); }

    // ---------- shared per-session store ----------
    // One refcounted eventSource subscription per session feeds every surface.
    // Each step (attempt) keeps its transient (live) and settled (durable)
    // points SEPARATELY; the durable set wins once a step settles, so a step
    // is never double-counted when its live frames and its settled stream both
    // arrive (the bug that inflated the curve after a turn finished).
    let CTX = null;
    const sessions = new Map();

    function newRecord(sid) { return { sid, attempts: new Map(), doneSeq: new Set(), toolOpen: new Map(), listeners: new Set(), unsub: null, rev: 0 }; }
    function att(rec, turn, step) {
      const k = key(turn, step);
      let a = rec.attempts.get(k);
      if (!a) { a = { k, turn: num(turn), step: num(step), live: [], dur: [], usageOut: 0, usageReason: 0, toolMs: 0, settled: false, rev: 0 }; rec.attempts.set(k, a); }
      return a;
    }
    function pushPts(a, src, pts) {
      for (const p of pts) (src === "dur" ? a.dur : a.live).push(p);
    }
    function series(a) { return a.dur.length ? a.dur : a.live; }

    function ingest(rec, es) {
      try {
        const win = es.getSnapshot();
        const entries = (win && win.entries) || [];
        for (const e of entries) {
          if (!e || !e.event) continue;
          const ev = e.event, d = ev.data || {};
          if (e.type === "event") {
            const a = att(rec, d.turn, d.step);
            if (ev.type === "assistant/message" && !rec.doneSeq.has(ev.seq)) {
              rec.doneSeq.add(ev.seq);
              a.settled = true; a.live = []; // durable replaces live for this step
              if (d.usage) { a.usageOut = num(d.usage.outputTokens); a.usageReason = num(d.usage.reasoningTokens); }
              pushPts(a, "dur", streamToPoints(d.stream, a.k));
              rec.rev++;
            } else if (ev.type === "tool/call") {
              rec.toolOpen.set(d.callId, { t: ev.time, turn: d.turn, step: d.step });
            } else if (ev.type === "tool/result") {
              const cid = (d.message && d.message.callId) || d.callId;
              const c = cid !== undefined ? rec.toolOpen.get(cid) : undefined;
              if (c) { att(rec, c.turn, c.step).toolMs += Math.max(0, ev.time - c.t); rec.toolOpen.delete(cid); rec.rev++; }
            }
          } else if (e.type === "transient") {
            const c = d.chunk; if (!c) continue;
            const a = att(rec, d.turn, d.step);
            const tk = estTokens(c.text); if (!tk) continue;
            if (c.type === "reasoning-delta") a.live.push({ t: ev.time, kind: "think", tok: tk, att: a.k });
            else if (c.type === "text-delta") a.live.push({ t: ev.time, kind: "out", tok: tk, att: a.k });
            rec.rev++;
          }
        }
      } catch { /* never break the host */ }
    }
    function sourceOf(sid) {
      try { const b = CTX && CTX.sessions && CTX.sessions.binding(sid); return (b && b.eventSource) || null; } catch { return null; }
    }
    function acquire(sid, listener) {
      let rec = sessions.get(sid);
      if (!rec) {
        rec = newRecord(sid); sessions.set(sid, rec);
        const es = sourceOf(sid);
        if (es && typeof es.subscribe === "function") {
          ingest(rec, es);
          rec.unsub = es.subscribe(() => { const before = rec.rev; ingest(rec, es); rec.listeners.forEach((f) => { try { f(); } catch { } }); });
        }
      }
      rec.listeners.add(listener);
      return () => { rec.listeners.delete(listener); if (!rec.listeners.size) { if (rec.unsub) { try { rec.unsub(); } catch { } } sessions.delete(sid); } };
    }
    function useTelemetry(sid) {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        if (!sid) return;
        const release = acquire(sid, () => force((v) => v + 1));
        force((v) => v + 1);
        return release;
      }, [sid]);
      return sid ? sessions.get(sid) || null : null;
    }

    // ---------- selectors ----------
    function attemptStats(a) {
      const s = series(a);
      let think = 0, out = 0, t0 = Infinity, t1 = -Infinity;
      for (const p of s) { if (p.kind === "think") think += p.tok; else out += p.tok; if (p.t < t0) t0 = p.t; if (p.t > t1) t1 = p.t; }
      const sec = t1 > t0 ? (t1 - t0) / 1000 : 0;
      const thinkTok = a.usageReason || think;
      const outTok = a.usageOut || out;
      const total = thinkTok + outTok;
      const b = bucketPoints(s);
      return { a, think: thinkTok, out: outTok, total, sec, toolSec: a.toolMs / 1000, tps: sec > 0.05 ? total / sec : 0, peak: b.peak, samples: b.samples, settled: a.settled };
    }
    function stepsSorted(rec, turn) {
      if (!rec) return [];
      return [...rec.attempts.values()].filter((a) => a.turn >= 1 && (turn === undefined || a.turn === turn)).sort((x, y) => x.turn - y.turn || x.step - y.step);
    }
    function turnStats(rec, turn) {
      const list = stepsSorted(rec, turn).map(attemptStats);
      let think = 0, out = 0, sec = 0, toolSec = 0, peak = 0, settled = list.length > 0;
      for (const s of list) { think += s.think; out += s.out; sec += s.sec; toolSec += s.toolSec; if (s.peak > peak) peak = s.peak; if (!s.settled) settled = false; }
      const pts = [];
      for (const a of stepsSorted(rec, turn)) for (const p of series(a)) pts.push(p);
      const b = bucketPoints(pts);
      return { turn, list, think, out, total: think + out, sec, toolSec, peak: Math.max(peak, b.peak), samples: b.samples, span: b.span, settled, steps: list.length };
    }
    function sessionSteps(rec) { return stepsSorted(rec).map(attemptStats); }

    // ---------- canvas ----------
    function drawSeries(cv, samples, peak, opt) {
      if (!cv || !cv.clientWidth) return;
      opt = opt || {};
      const axis = !!opt.axis;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const c = cv.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      c.fillStyle = DIM;
      if (!samples || !samples.length) { c.font = "10px ui-monospace, monospace"; c.fillText("等待流式数据…", 6, h / 2); return; }
      const P = axis ? { l: 38, r: 10, t: 10, b: 18 } : { l: 1, r: 1, t: 2, b: 2 };
      const pw = w - P.l - P.r, ph = h - P.t - P.b;
      const n = samples.length;
      const xMax = Math.max(1, (n - 1) * SAMPLE);
      const yMax = niceMax(Math.max(peak * 1.15, 40));
      const X = (sec) => P.l + (sec / xMax) * pw;
      const Y = (v) => P.t + ph - (v / yMax) * ph;
      if (axis) {
        c.font = "9px ui-monospace, monospace"; c.lineWidth = 1;
        for (let k = 0; k <= 4; k++) {
          const v = (yMax * k) / 4, y = Y(v);
          c.strokeStyle = "rgba(255,255,255,.06)"; c.beginPath(); c.moveTo(P.l, y); c.lineTo(P.l + pw, y); c.stroke();
          c.fillStyle = DIM; c.fillText(String(Math.round(v)), 3, y + 3);
        }
        const step = niceStep(xMax);
        for (let s = 0; s <= xMax; s += step) {
          const x = X(s);
          c.strokeStyle = "rgba(255,255,255,.05)"; c.beginPath(); c.moveTo(x, P.t); c.lineTo(x, P.t + ph); c.stroke();
          c.fillStyle = DIM; c.fillText(s + "s", Math.max(P.l, Math.min(x - 8, P.l + pw - 14)), h - 6);
        }
      }
      const fillArea = (kind, color) => {
        c.beginPath(); let started = false, firstX = 0;
        for (let i = 0; i < n; i++) { const v = samples[i][kind]; const x = X(samples[i].t), y = Y(v); if (!started) { firstX = x; c.moveTo(x, y); started = true; } else c.lineTo(x, y); }
        if (!started) return;
        let lastX = firstX; for (let i = n - 1; i >= 0; i--) { if (samples[i][kind] >= 0) { lastX = X(samples[i].t); break; } }
        c.lineTo(lastX, P.t + ph); c.lineTo(firstX, P.t + ph); c.closePath();
        c.fillStyle = color; c.fill();
      };
      const line = (kind, color, lw) => {
        c.beginPath(); let started = false;
        for (let i = 0; i < n; i++) { const v = samples[i][kind]; if (v <= 0) continue; const x = X(samples[i].t), y = Y(v); if (started) c.lineTo(x, y); else { c.moveTo(x, y); started = true; } }
        c.strokeStyle = color; c.lineWidth = lw; c.lineJoin = "round"; c.stroke();
      };
      if (axis) { fillArea("out", "rgba(255,107,44,.14)"); fillArea("think", "rgba(138,138,148,.12)"); }
      line("think", GR, axis ? 1.6 : 1.1);
      line("out", OR, axis ? 2 : 1.2);
      if (axis) { c.strokeStyle = "rgba(255,255,255,.12)"; c.beginPath(); c.moveTo(P.l, P.t + ph); c.lineTo(P.l + pw, P.t + ph); c.stroke(); }
    }

    function Series(props) {
      const ref = React.useRef(null);
      React.useEffect(() => { drawSeries(ref.current, props.samples, props.peak, { axis: props.axis }); }, [props.samples, props.peak, props.axis]);
      return h("canvas", { ref, style: { display: "block", width: "100%", height: props.height || 22 } });
    }

    // ---------- trajectory ribbon: per-step colored block, mini curve inside ----------
    function phaseColor(st) {
      if (st.settled && st.toolSec > st.sec * 0.5 && st.toolSec > 0.2) return { bg: "rgba(74,163,255,.16)", bd: TOOL };
      if (st.out >= st.think) return { bg: "rgba(255,107,44,.16)", bd: OR };
      return { bg: "rgba(138,138,148,.18)", bd: GR };
    }
    function TrajectoryTrack(props) {
      const list = props.steps.filter((s) => s.samples.length || s.total > 0);
      if (!list.length) return h("div", { style: { color: DIM, font: "11px ui-monospace, monospace" } }, "暂无步数据");
      const total = list.reduce((a, s) => a + Math.max(0.4, s.sec), 0);
      return h("div", { style: { display: "flex", gap: 3, alignItems: "stretch", height: props.height || 56 } },
        list.map((s) => {
          const col = phaseColor(s);
          const grow = Math.max(0.4, s.sec) / total;
          return h("div", { key: s.a.k, title: "S" + s.a.step + " 思考" + fmt(s.think) + " 输出" + fmt(s.out) + " " + s.tps.toFixed(0) + " tok/s" + (s.toolSec ? " 工具" + s.toolSec.toFixed(1) + "s" : ""),
            style: { flexGrow: grow, flexBasis: 0, minWidth: 34, background: col.bg, border: "1px solid " + col.bd, borderRadius: 6, padding: "3px 5px", overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "space-between" } },
            h("div", { style: { font: "9px ui-monospace, monospace", color: "#ECECEF", whiteSpace: "nowrap" } },
              (props.showTurn ? "T" + s.a.turn + "-" : "") + "S" + s.a.step,
              h("span", { style: { color: col.bd } }, " " + fmt(s.tps))),
            h(Series, { samples: s.samples, peak: s.peak, height: 20 }));
        }));
    }

    const swatch = (color) => h("span", { style: { display: "inline-block", width: 7, height: 7, borderRadius: 2, background: color } });

    // ---------- per-turn inline card ----------
    function TelemetryTail(props) {
      const turnObj = props.turn;
      const turn = turnObj && typeof turnObj.turn === "number" ? turnObj.turn : (typeof props.turn === "number" ? props.turn : null);
      const rec = useTelemetry(props.sessionId);
      const [open, setOpen] = React.useState(false);
      const t = turn === null || !rec ? null : turnStats(rec, turn);
      if (!t || !t.steps) return null; // no step data for this turn
      return h("div", { style: tailWrap },
        h("div", { style: tailRow, onClick: () => setOpen((v) => !v) },
          h("span", { style: tailId }, "T" + turn),
          h("span", { style: tailNums },
            h("b", { style: { color: GR } }, fmt(t.think)), " 思考 ",
            h("b", { style: { color: OR } }, fmt(t.out)), " 输出 ",
            h("b", null, fmt(t.sec > 0.05 ? t.total / t.sec : 0)), " tok/s",
            h("span", { style: tailDim }, " · " + (t.sec + t.toolSec).toFixed(1) + "s · " + t.steps + "步" + (t.settled ? "" : " 流式中"))),
          h("span", { style: { width: 120, flex: "none" } }, h(Series, { samples: t.samples, peak: t.peak, height: 22 })),
          h("span", { style: tailToggle }, open ? "收起 ▴" : "轨迹 ▾")),
        open ? h("div", { style: tailDetail },
          h("div", { style: { fontSize: 10, color: DIM, margin: "2px 0 6px" } }, "轨迹 · 按步时长分色（灰=思考 橙=输出 蓝=工具），块内为该步 tok/s 曲线"),
          h(TrajectoryTrack, { steps: t.list, height: 50 }),
          h("div", { style: tailSum }, "合计 ", fmt(t.total), " tok · 峰值 ", fmt(t.peak), " tok/s · 工具 ", t.toolSec.toFixed(1) + "s")) : null);
    }
    const tailWrap = { marginTop: 6, border: "1px solid #24242A", borderRadius: 10, background: "#0E0E11", overflow: "hidden", font: "11.5px ui-monospace, monospace", color: "#8B8B93" };
    const tailRow = { display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", cursor: "pointer" };
    const tailId = { color: DIM, fontWeight: 700 };
    const tailNums = { display: "flex", gap: 6, alignItems: "baseline", flex: 1, minWidth: 0, flexWrap: "wrap" };
    const tailDim = { color: DIM };
    const tailToggle = { color: DIM, flex: "none" };
    const tailDetail = { padding: "6px 10px 10px", borderTop: "1px solid #24242A" };
    const tailSum = { marginTop: 8, color: DIM };

    // ---------- aggregate view ----------
    function TelemetryView(props) {
      const stats = (props.useProjection && props.useProjection("sessionStats")) || null;
      const usage = (props.useProjection && props.useProjection("tokenUsage")) || null;
      const rec = useTelemetry(props.sessionId);
      const turns = React.useMemo(() => {
        if (!rec) return [];
        const set = new Set([...rec.attempts.values()].filter((a) => a.turn >= 1).map((a) => a.turn));
        return [...set].sort((a, b) => a - b).map((tn) => turnStats(rec, tn));
      }, [rec && rec.rev]);
      const allPts = rec ? stepsSorted(rec).reduce((arr, a) => arr.concat(series(a)), []) : [];
      const all = bucketPoints(allPts);
      const stepList = rec ? sessionSteps(rec) : [];
      const live = turns.length ? turns[turns.length - 1] : null;
      const decodeTps = stats && stats.decodeMs > 50 ? num(stats.decodeTokens) / (stats.decodeMs / 1000) : 0;
      const avgTtft = stats && stats.ttftSteps > 0 ? (num(stats.ttftMs) / stats.ttftSteps) / 1000 : null;
      const totalTokens = usage ? num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.outputTokens) : 0;
      const sessPeak = all.peak;

      return h("div", { style: page },
        h("div", { style: header }, h("h2", { style: title }, "Token 遥测"), h("span", { style: subtitle }, "session " + (props.sessionId || "—"))),

        h("div", { style: curveBox },
          h("div", { style: legend },
            h("span", { style: legendItem }, swatch(GR), " 思考"),
            h("span", { style: legendItem }, swatch(OR), " 输出"),
            h("span", { style: legendPeak }, "峰值 ", fmt(sessPeak), " tok/s · 跨 ", all.span.toFixed(0), "s · ", all.samples.length, " 桶")),
          h("div", { style: { height: 150 } }, h(Series, { samples: all.samples, peak: sessPeak, axis: true, height: 150 })),
          h("div", { style: { fontSize: 11, color: DIM, margin: "10px 0 6px" } }, "轨迹总览 · 按步时长分色（灰=思考 橙=输出 蓝=工具），块内为该步 tok/s"),
          h(TrajectoryTrack, { steps: stepList, height: 58, showTurn: true })),


        h("div", { style: grid },
          h(StatCard, { label: "解码 TPS (整段)", value: fmt(decodeTps), unit: "tok/s", accent: OR, sub: stats ? fmt(num(stats.decodeTokens)) + " tok · " + (num(stats.decodeMs) / 1000).toFixed(1) + "s" : "—" }),
          h(StatCard, { label: "首响应 (均值)", value: avgTtft === null ? "—" : avgTtft.toFixed(2), unit: avgTtft === null ? "" : "s", sub: stats ? stats.ttftSteps + " 步采样" : "—" }),
          h(StatCard, { label: "总 Tokens", value: fmt(totalTokens), sub: usage ? "输入 " + fmt(num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) + " · 输出 " + fmt(num(usage.outputTokens)) : "—" }),
          h(StatCard, { label: "回合 / 步 / 采样峰值", value: (stats ? stats.turns : 0) + " / " + stepList.length + " / " + fmt(sessPeak), unit: "tok/s", sub: stats ? "工具 " + (num(stats.toolMs) / 1000).toFixed(1) + "s" : "—" })),

        h("div", { style: aggBox },
          h("div", { style: aggTitle }, "跨回合总览"),
          turns.length ? h("table", { style: tbl },
            h("thead", null, h("tr", null, ["回合", "思考", "输出", "合计", "模型时长", "tok/s", "峰值", "步"].map((c) => h("th", { key: c, style: th }, c)))),
            h("tbody", null, turns.map((x) => h("tr", { key: x.turn },
              h("td", { style: td }, "T" + x.turn),
              h("td", { style: { ...td, color: GR } }, fmt(x.think)),
              h("td", { style: { ...td, color: OR } }, fmt(x.out)),
              h("td", { style: td }, fmt(x.total)),
              h("td", { style: td }, (x.sec + x.toolSec).toFixed(1) + "s"),
              h("td", { style: td }, fmt(x.sec > 0.05 ? x.total / x.sec : 0)),
              h("td", { style: td }, fmt(x.peak)),
              h("td", { style: td }, x.steps))))) : h("div", { style: aggEmpty }, "暂无回合数据")),
        live ? h("div", { style: footer }, "当前 T", live.turn, live.settled ? "（已结算）" : "（流式中）", " · 思考 ", fmt(live.think), " · 输出 ", fmt(live.out), " · 即时 ", fmt(live.sec > 0.05 ? live.total / live.sec : 0), " tok/s") : null);
    }
    function StatCard(props) {
      return h("div", { style: card },
        h("div", { style: cardLabel }, props.label),
        h("div", { style: { ...cardValue, color: props.accent || "#ECECEF" } }, props.value, props.unit ? h("span", { style: cardUnit }, " " + props.unit) : null),
        props.sub ? h("div", { style: cardSub }, props.sub) : null);
    }

    const page = { padding: "18px 20px", color: "#ECECEF", font: "13px system-ui, -apple-system, 'PingFang SC', sans-serif", height: "100%", overflow: "auto", boxSizing: "border-box", background: "#0B0B0D" };
    const header = { display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 };
    const title = { fontSize: 14, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600, margin: 0 };
    const subtitle = { font: "11px ui-monospace, monospace", color: DIM };
    const curveBox = { border: "1px solid #24242A", borderRadius: 12, padding: "12px 14px", marginBottom: 14, background: "linear-gradient(180deg,#151519,#0F0F12)" };
    const legend = { display: "flex", alignItems: "center", gap: 16, fontSize: 11.5, color: "#8B8B93", marginBottom: 6 };
    const legendItem = { display: "flex", alignItems: "center", gap: 6 };
    const legendPeak = { marginLeft: "auto", font: "11px ui-monospace, monospace", color: DIM };
    const grid = { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 };
    const card = { border: "1px solid #24242A", borderRadius: 12, padding: "14px 16px", background: "#0E0E11" };
    const cardLabel = { fontSize: 11, color: DIM, letterSpacing: ".06em", marginBottom: 8 };
    const cardValue = { font: "700 20px ui-monospace, monospace", letterSpacing: "-.02em" };
    const cardUnit = { fontSize: 11, fontWeight: 500, color: DIM };
    const cardSub = { font: "10.5px ui-monospace, monospace", color: DIM, marginTop: 6 };
    const aggBox = { marginTop: 14, border: "1px solid #24242A", borderRadius: 12, padding: "12px 14px", background: "#0E0E11" };
    const aggTitle = { fontSize: 11, color: DIM, letterSpacing: ".08em", marginBottom: 8 };
    const aggEmpty = { font: "11px ui-monospace, monospace", color: DIM };
    const footer = { marginTop: 12, font: "11px ui-monospace, monospace", color: DIM };
    const tbl = { width: "100%", borderCollapse: "collapse", font: "11px ui-monospace, monospace" };
    const th = { textAlign: "left", padding: "5px 8px 5px 0", color: DIM, fontWeight: 500, borderBottom: "1px solid #24242A" };
    const td = { padding: "5px 8px 5px 0", borderBottom: "1px solid #1A1A20" };

    const inject = ["slots", "sessions"];
    function apply(ctx) {
      CTX = ctx;
      if (!ctx.slots || typeof ctx.slots.inject !== "function") { console.warn("[dsh-token-telemetry] ctx.slots unavailable; not mounted"); return; }
      ctx.slots.inject("conversation.view", () => ctx.slots.register({ name: "conversation.view", id: "token-telemetry", order: 20, label: () => "Token 遥测" }, TelemetryView));
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({ name: "conversation.chat.turnTail", id: "token-telemetry-tail", order: 50 }, TelemetryTail));
      console.log("[dsh-token-telemetry] client half mounted (turnTail + aggregate, trajectory ribbon)");
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
