window.__ModuleLoader__.load({
  id: "dsh-token-telemetry",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;

    // ---------- constants / small helpers ----------
    const SAMPLE = 0.25;
    const OR = "#FF6B2C";
    const GR = "#8A8A94";
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
      const st = v > 1400 ? 400 : v > 700 ? 200 : 100;
      return Math.max(st, Math.ceil(v / st) * st);
    }

    // ---------- sampling ----------
    // Expand a durable AssistantStreamRecord[] into timed token points.
    function streamToPoints(stream, att) {
      const pts = [];
      if (!Array.isArray(stream)) return pts;
      for (const rec of stream) {
        if (!rec) continue;
        if (rec.type === "reasoning-chunks" || rec.type === "text-chunks") {
          const kind = rec.type === "reasoning-chunks" ? "think" : "out";
          const dts = rec.dt || [];
          const texts = rec.texts || [];
          let t = rec.time0 || 0;
          for (let i = 0; i < texts.length; i++) {
            t += dts[i] || 0;
            const tok = estTokens(texts[i]);
            if (tok > 0) pts.push({ t, kind, tok, att, src: "durable" });
          }
        } else if (rec.type === "chunk" && rec.chunk) {
          const c = rec.chunk;
          if (c.type === "reasoning-delta") { const tk = estTokens(c.text); if (tk) pts.push({ t: rec.time || 0, kind: "think", tok: tk, att, src: "durable" }); }
          else if (c.type === "text-delta") { const tk = estTokens(c.text); if (tk) pts.push({ t: rec.time || 0, kind: "out", tok: tk, att, src: "durable" }); }
        }
      }
      return pts;
    }

    // Bucket timed points into tokens/s samples; also report the peak rate.
    function bucketPoints(pts) {
      if (!pts || !pts.length) return { samples: [], peak: 0 };
      const sorted = pts.slice().sort((a, b) => a.t - b.t);
      const t0 = sorted[0].t;
      const buckets = [];
      for (const p of sorted) {
        const bi = Math.max(0, Math.floor((p.t - t0) / 1000 / SAMPLE));
        while (buckets.length <= bi) buckets.push({ t: bi * SAMPLE, think: 0, out: 0 });
        buckets[bi][p.kind] += p.tok;
      }
      let peak = 0;
      for (const b of buckets) {
        b.think /= SAMPLE; b.out /= SAMPLE;
        const tp = b.think + b.out;
        if (tp > peak) peak = tp;
      }
      return { samples: buckets, peak };
    }

    // ---------- shared per-session store ----------
    // One refcounted eventSource subscription per session feeds every surface
    // (per-turn tail cards and the aggregate view), so N turns do not mean N
    // subscriptions and they can never disagree.
    let CTX = null;
    const sessions = new Map();

    function newRecord(sid) {
      return { sid, pts: [], attempts: new Map(), doneSeq: new Set(), liveSeq: -1, toolOpen: new Map(), listeners: new Set(), unsub: null };
    }

    function step(rec, att) {
      let a = rec.attempts.get(att);
      if (!a) { a = { att, turn: Number(att.split("-")[0]) || 0, step: Number(att.split("-")[1]) || 0, pts: [], think: 0, out: 0, usageOut: 0, usageReason: 0, toolMs: 0, settled: false, t0: Infinity, t1: -Infinity }; rec.attempts.set(att, a); }
      return a;
    }

    function addPoint(rec, p) {
      rec.pts.push(p);
      const a = step(rec, p.att);
      if (p.kind === "think") a.think += p.tok; else a.out += p.tok;
      if (p.t < a.t0) a.t0 = p.t;
      if (p.t > a.t1) a.t1 = p.t;
    }

    function ingest(rec, eventSource) {
      try {
        const win = eventSource.getSnapshot();
        const entries = (win && win.entries) || [];
        for (const e of entries) {
          if (!e || !e.event) continue;
          const ev = e.event;
          if (e.type === "event") {
            const d = ev.data || {};
            const att = key(d.turn, d.step);
            if (ev.type === "assistant/message" && !rec.doneSeq.has(ev.seq)) {
              rec.doneSeq.add(ev.seq);
              const a = step(rec, att);
              a.settled = true;
              if (d.usage) { a.usageOut = num(d.usage.outputTokens); a.usageReason = num(d.usage.reasoningTokens); }
              for (const p of streamToPoints(d.stream, att)) addPoint(rec, p);
            } else if (ev.type === "tool/call") {
              rec.toolOpen.set(d.callId, ev.time);
            } else if (ev.type === "tool/result") {
              const callId = (d.message && d.message.callId) || d.callId;
              const start = callId !== undefined ? rec.toolOpen.get(callId) : undefined;
              if (start !== undefined) { step(rec, att).toolMs += Math.max(0, ev.time - start); rec.toolOpen.delete(callId); }
            }
          } else if (e.type === "transient") {
            if (ev.seq > rec.liveSeq) rec.liveSeq = ev.seq;
            const d = ev.data || {};
            const att = key(d.turn, d.step);
            const c = d.chunk;
            if (!c) continue;
            if (c.type === "reasoning-delta") { const tk = estTokens(c.text); if (tk) addPoint(rec, { t: ev.time, kind: "think", tok: tk, att, src: "live" }); }
            else if (c.type === "text-delta") { const tk = estTokens(c.text); if (tk) addPoint(rec, { t: ev.time, kind: "out", tok: tk, att, src: "live" }); }
          }
        }
      } catch { /* never break the host */ }
    }

    function sourceOf(sid) {
      try {
        const b = CTX && CTX.sessions && CTX.sessions.binding(sid);
        return (b && b.eventSource) || null;
      } catch { return null; }
    }

    function acquire(sid, listener) {
      let rec = sessions.get(sid);
      if (!rec) {
        rec = newRecord(sid);
        sessions.set(sid, rec);
        const es = sourceOf(sid);
        if (es && typeof es.subscribe === "function") {
          ingest(rec, es);
          rec.unsub = es.subscribe(() => { ingest(rec, es); rec.listeners.forEach((f) => { try { f(); } catch { } }); });
        }
      }
      rec.listeners.add(listener);
      return () => {
        rec.listeners.delete(listener);
        if (!rec.listeners.size) { if (rec.unsub) { try { rec.unsub(); } catch { } } sessions.delete(sid); }
      };
    }

    // React binding: re-render a surface whenever its session's record updates.
    function useTelemetry(sid) {
      const rec = sid ? sessions.get(sid) || newRecord(sid) : null;
      const [, bump] = React.useReducer((x) => x + 1, 0);
      const [, force] = React.useState(0);
      React.useEffect(() => {
        if (!sid) return;
        const release = acquire(sid, () => force((v) => v + 1));
        force((v) => v + 1); // pick up the record acquire() just created/ingested
        return release;
      }, [sid]);
      void rec; void bump;
      return sid ? sessions.get(sid) || null : null;
    }

    // Aggregate one step. Tokens prefer the provider-reported usage when the
    // step has settled; the sampled points only shape the curve.
    function stepStats(a) {
      const thinkTok = a.usageReason || a.think;
      const outTok = a.usageOut || a.out;
      const sec = a.t1 > a.t0 ? (a.t1 - a.t0) / 1000 : 0;
      const { peak } = bucketPoints(a.pts.length ? a.pts : []);
      return { think: thinkTok, out: outTok, total: thinkTok + outTok, sec, tps: sec > 0.05 ? (thinkTok + outTok) / sec : 0, peak: peak || a.peak || 0, settled: a.settled };
    }

    function stepsOfTurn(rec, turn) {
      if (!rec) return [];
      return [...rec.attempts.values()].filter((a) => a.turn === turn).sort((x, y) => x.step - y.step);
    }

    function turnStats(rec, turn) {
      const steps = stepsOfTurn(rec, turn);
      let think = 0, out = 0, sec = 0, toolMs = 0, peak = 0, settled = true;
      for (const a of steps) {
        const s = stepStats(a);
        think += s.think; out += s.out; sec += s.sec; toolMs += a.toolMs;
        if (s.peak > peak) peak = s.peak;
        if (!a.settled) settled = false;
      }
      const pts = rec ? rec.pts.filter((p) => Number(p.att.split("-")[0]) === turn) : [];
      const bucketed = bucketPoints(pts);
      if (bucketed.peak > peak) peak = bucketed.peak;
      const total = think + out;
      return { turn, steps, think, out, total, sec, toolMs, peak, settled, samples: bucketed.samples };
    }

    function canvasSpark(cv, samples, peak) {
      if (!cv || !cv.clientWidth) return;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, hh = cv.clientHeight;
      if (cv.width !== w * dpr || cv.height !== hh * dpr) { cv.width = w * dpr; cv.height = hh * dpr; }
      const c = cv.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, hh);
      if (!samples.length) return;
      const yMax = niceMax(Math.max(peak * 1.1, 60));
      const n = samples.length;
      const X = (i) => (i / Math.max(1, n - 1)) * w;
      const Y = (v) => hh - 1 - (v / yMax) * (hh - 2);
      const line = (k, color, lw) => {
        c.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = samples[i][k];
          if (v <= 0) continue;
          if (started) c.lineTo(X(i), Y(v)); else { c.moveTo(X(i), Y(v)); started = true; }
        }
        c.strokeStyle = color; c.lineWidth = lw || 1.3; c.stroke();
      };
      line("think", GR);
      line("out", OR);
    }

    const swatch = (color) => h("span", { style: { display: "inline-block", width: 7, height: 7, borderRadius: 2, background: color } });

    // ---------- per-turn inline card (conversation.chat.turnTail) ----------
    function TelemetryTail(props) {
      const turn = props.turn && typeof props.turn.turn === "number" ? props.turn.turn : null;
      const rec = useTelemetry(props.sessionId);
      const [open, setOpen] = React.useState(false);
      const sparkRef = React.useRef(null);

      const t = turn === null ? null : turnStats(rec, turn);
      React.useEffect(() => { if (t) canvasSpark(sparkRef.current, t.samples, t.peak); }, [t && t.total, t && t.peak, open]);
      if (!t || (!t.total && !t.steps.length)) return null;

      const label = t.settled ? "" : " · 流式中";
      return h("div", { style: tailWrap },
        h("div", { style: tailRow, onClick: () => setOpen((v) => !v) },
          h("span", { style: tailId }, "T" + turn),
          h("span", { style: tailNums },
            h("b", { style: { color: GR } }, fmt(t.think)), " 思考 ",
            h("b", { style: { color: OR } }, fmt(t.out)), " 输出 ",
            h("b", null, fmt(t.tps || (t.sec > 0.05 ? t.total / t.sec : 0))), " tok/s",
            h("span", { style: tailDim }, " · " + (t.sec + t.toolMs / 1000).toFixed(1) + "s" + label)),
          h("canvas", { ref: sparkRef, style: tailSpark }),
          h("span", { style: tailToggle }, open ? "收起 ▴" : "明细 ▾")),
        open ? h("div", { style: tailDetail },
          h("table", { style: tbl },
            h("thead", null, h("tr", null, ["步", "思考", "输出", "时长", "tok/s", "工具", "状态"].map((c) => h("th", { key: c, style: th }, c)))),
            h("tbody", null, t.steps.map((a) => {
              const s = stepStats(a);
              return h("tr", { key: a.att },
                h("td", { style: td }, a.step),
                h("td", { style: { ...td, color: GR } }, fmt(s.think)),
                h("td", { style: { ...td, color: OR } }, fmt(s.out)),
                h("td", { style: td }, s.sec.toFixed(1) + "s"),
                h("td", { style: td }, fmt(s.tps)),
                h("td", { style: td }, a.toolMs ? (a.toolMs / 1000).toFixed(1) + "s" : "—"),
                h("td", { style: { ...td, color: a.settled ? "#5A5A62" : OR } }, a.settled ? "已结算" : "流式中"));
            }))),
          h("div", { style: tailSum }, "合计 ", fmt(t.total), " tok · 峰值 ", fmt(t.peak), " tok/s · 步数 ", t.steps.length)) : null);
    }

    const tailWrap = { marginTop: 6, border: "1px solid #24242A", borderRadius: 10, background: "#0E0E11", overflow: "hidden", font: "11.5px ui-monospace, monospace", color: "#8B8B93" };
    const tailRow = { display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", cursor: "pointer" };
    const tailId = { color: "#5A5A62", fontWeight: 700 };
    const tailNums = { display: "flex", gap: 6, alignItems: "baseline", flex: 1, minWidth: 0, flexWrap: "wrap" };
    const tailDim = { color: "#5A5A62" };
    const tailSpark = { width: 110, height: 22, flex: "none" };
    const tailToggle = { color: "#5A5A62", flex: "none" };
    const tailDetail = { padding: "4px 10px 10px", borderTop: "1px solid #24242A" };
    const tailSum = { marginTop: 8, color: "#5A5A62" };
    const tbl = { width: "100%", borderCollapse: "collapse", font: "11px ui-monospace, monospace" };
    const th = { textAlign: "left", padding: "5px 8px 5px 0", color: "#5A5A62", fontWeight: 500, borderBottom: "1px solid #24242A" };
    const td = { padding: "5px 8px 5px 0", borderBottom: "1px solid #1A1A20" };

    // ---------- aggregate view (conversation.view) ----------
    function TelemetryView(props) {
      const stats = (props.useProjection && props.useProjection("sessionStats")) || null;
      const usage = (props.useProjection && props.useProjection("tokenUsage")) || null;
      const rec = useTelemetry(props.sessionId);
      const bigRef = React.useRef(null);

      const turns = React.useMemo(() => {
        if (!rec) return [];
        const set = new Set([...rec.attempts.values()].map((a) => a.turn));
        return [...set].sort((a, b) => a - b).map((tn) => turnStats(rec, tn));
      }, [rec && rec.pts.length]);

      const allSamples = rec ? bucketPoints(rec.pts).samples : [];
      const allPeak = rec ? bucketPoints(rec.pts).peak : 0;
      React.useEffect(() => { canvasSpark(bigRef.current, allSamples, allPeak); }, [allSamples.length, allPeak]);

      const live = turns.length ? turns[turns.length - 1] : null;
      const decodeTps = stats && stats.decodeMs > 50 ? num(stats.decodeTokens) / (stats.decodeMs / 1000) : 0;
      const avgTtft = stats && stats.ttftSteps > 0 ? (num(stats.ttftMs) / stats.ttftSteps) / 1000 : null;
      const totalTokens = usage ? num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.outputTokens) : 0;
      const sessPeak = Math.max(allPeak, ...turns.map((x) => x.peak), 0);

      return h("div", { style: page },
        h("div", { style: header },
          h("h2", { style: title }, "Token 遥测"),
          h("span", { style: subtitle }, "session " + (props.sessionId || "—"))),

        h("div", { style: curveBox },
          h("div", { style: legend },
            h("span", { style: legendItem }, swatch(GR), " 思考"),
            h("span", { style: legendItem }, swatch(OR), " 输出"),
            h("span", { style: legendPeak }, "峰值 ", fmt(sessPeak), " tok/s · ", allSamples.length, " 桶")),
          h("canvas", { ref: bigRef, style: bigCanvas }),
          h("div", { style: liveStrip },
            live ? h("span", { style: liveItem }, "当前 步 ", live.steps.length ? live.steps[live.steps.length - 1].step : "—", " T", live.turn, live.settled ? "（已结算）" : "（流式中）") : h("span", { style: liveItem }, "等待数据…"),
            live ? h("span", { style: liveItem }, "思考 ", h("b", { style: { color: GR } }, fmt(live.think))) : null,
            live ? h("span", { style: liveItem }, "输出 ", h("b", { style: { color: OR } }, fmt(live.out))) : null,
            live ? h("span", { style: liveItem }, "即时 ", h("b", { style: { color: OR } }, fmt(live.sec > 0.05 ? live.total / live.sec : 0) + " tok/s")) : null)),

        h("div", { style: grid },
          h(StatCard, { label: "解码 TPS (整段)", value: fmt(decodeTps), unit: "tok/s", accent: OR, sub: stats ? fmt(num(stats.decodeTokens)) + " 输出 tok · " + (num(stats.decodeMs) / 1000).toFixed(1) + "s" : "—" }),
          h(StatCard, { label: "首响应 (均值)", value: avgTtft === null ? "—" : avgTtft.toFixed(2), unit: avgTtft === null ? "" : "s", sub: stats ? stats.ttftSteps + " 步采样" : "—" }),
          h(StatCard, { label: "总 Tokens", value: fmt(totalTokens), sub: usage ? "输入 " + fmt(num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) + " · 输出 " + fmt(num(usage.outputTokens)) : "—" }),
          h(StatCard, { label: "回合 / 采样峰值", value: (stats ? stats.turns : 0) + " / " + fmt(sessPeak), unit: "tok/s", sub: stats ? "步 " + stats.steps + " · 工具 " + (num(stats.toolMs) / 1000).toFixed(1) + "s" : "—" })),

        h("div", { style: aggBox },
          h("div", { style: aggTitle }, "跨回合总览"),
          turns.length ? h("table", { style: tbl },
            h("thead", null, h("tr", null, ["回合", "思考", "输出", "合计", "时长", "tok/s", "峰值", "步"].map((c) => h("th", { key: c, style: th }, c)))),
            h("tbody", null, turns.map((x) => h("tr", { key: x.turn },
              h("td", { style: td }, "T" + x.turn),
              h("td", { style: { ...td, color: GR } }, fmt(x.think)),
              h("td", { style: { ...td, color: OR } }, fmt(x.out)),
              h("td", { style: td }, fmt(x.total)),
              h("td", { style: td }, (x.sec + x.toolMs / 1000).toFixed(1) + "s"),
              h("td", { style: td }, fmt(x.sec > 0.05 ? x.total / x.sec : 0)),
              h("td", { style: td }, fmt(x.peak)),
              h("td", { style: td }, x.steps.length))))) : h("div", { style: aggEmpty }, "暂无回合数据")));
    }

    function StatCard(props) {
      return h("div", { style: card },
        h("div", { style: cardLabel }, props.label),
        h("div", { style: { ...cardValue, color: props.accent || "#ECECEF" } }, props.value, props.unit ? h("span", { style: cardUnit }, " " + props.unit) : null),
        props.sub ? h("div", { style: cardSub }, props.sub) : null);
    }

    const page = { padding: "18px 20px", color: "#ECECEF", font: "13px system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif", height: "100%", overflow: "auto", boxSizing: "border-box", background: "#0B0B0D" };
    const header = { display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 };
    const title = { fontSize: 14, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600, margin: 0 };
    const subtitle = { font: "11px ui-monospace, monospace", color: "#5A5A62" };
    const curveBox = { border: "1px solid #24242A", borderRadius: 12, padding: "12px 14px", marginBottom: 14, background: "linear-gradient(180deg,#151519,#0F0F12)" };
    const legend = { display: "flex", alignItems: "center", gap: 16, fontSize: 11.5, color: "#8B8B93", marginBottom: 8 };
    const legendItem = { display: "flex", alignItems: "center", gap: 6 };
    const legendPeak = { marginLeft: "auto", font: "11px ui-monospace, monospace", color: "#5A5A62" };
    const bigCanvas = { display: "block", width: "100%", height: 160 };
    const liveStrip = { display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 10, paddingTop: 10, borderTop: "1px solid #24242A", font: "11.5px ui-monospace, monospace", color: "#8B8B93" };
    const liveItem = { display: "inline-flex", alignItems: "center", gap: 5 };
    const grid = { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 };
    const card = { border: "1px solid #24242A", borderRadius: 12, padding: "14px 16px", background: "#0E0E11" };
    const cardLabel = { fontSize: 11, color: "#5A5A62", letterSpacing: ".06em", marginBottom: 8 };
    const cardValue = { font: "700 22px ui-monospace, monospace", letterSpacing: "-.02em" };
    const cardUnit = { fontSize: 11, fontWeight: 500, color: "#5A5A62" };
    const cardSub = { font: "10.5px ui-monospace, monospace", color: "#5A5A62", marginTop: 6 };
    const aggBox = { marginTop: 14, border: "1px solid #24242A", borderRadius: 12, padding: "12px 14px", background: "#0E0E11" };
    const aggTitle = { fontSize: 11, color: "#5A5A62", letterSpacing: ".08em", marginBottom: 8 };
    const aggEmpty = { font: "11px ui-monospace, monospace", color: "#5A5A62" };

    const inject = ["slots", "sessions"];

    function apply(ctx) {
      CTX = ctx;
      if (!ctx.slots || typeof ctx.slots.inject !== "function") {
        console.warn("[dsh-token-telemetry] ctx.slots unavailable; panel not mounted");
        return;
      }
      ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view", id: "token-telemetry", order: 20, label: () => "Token 遥测",
      }, TelemetryView));
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
        name: "conversation.chat.turnTail", id: "token-telemetry-tail", order: 50,
      }, TelemetryTail));
      console.log("[dsh-token-telemetry] client half mounted (turnTail cards + aggregate view)");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
