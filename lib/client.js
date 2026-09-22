window.__ModuleLoader__.load({
  id: "dsh-token-telemetry",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // ---- constants -------------------------------------------------------
    const SAMPLE = 0.25; // bucket, seconds
    const VIEW_ID = "token-telemetry";
    const OR = "#FF6B2C";
    const GR = "#8A8A94";

    // ---- pure helpers ----------------------------------------------------
    const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
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

    // expand one settled AssistantStreamRecord[] into timed token points.
    // Record kinds carry time0 + per-chunk dt[] + texts[]; each dt advances time.
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

    // Bucket a set of timed points into tokens/s samples + peak.
    function bucketPoints(points) {
      if (!points.length) return { samples: [], peak: 0 };
      const sorted = points.slice().sort((a, b) => a.t - b.t);
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

    // Latest in-progress/last step's live running totals. Per attempt, durable
    // points override transient ones (so a settled turn is not double-counted).
    function computeLive(pts) {
      if (!pts.length) return null;
      const byAtt = new Map();
      for (const p of pts) {
        const a = p.att || "-";
        let g = byAtt.get(a);
        if (!g) { g = { live: [], dur: [] }; byAtt.set(a, g); }
        (p.src === "durable" ? g.dur : g.live).push(p);
      }
      // pick the attempt whose last event time is greatest (current/last)
      let best = null, bestAtt = null, bestT = -Infinity;
      for (const [a, g] of byAtt) {
        const arr = g.dur.length ? g.dur : g.live;
        const mx = arr.reduce((m, p) => Math.max(m, p.t), -Infinity);
        if (mx > bestT) { bestT = mx; best = arr; bestAtt = a; }
      }
      if (!best) return null;
      let think = 0, out = 0, t0 = Infinity, t1 = -Infinity;
      for (const p of best) {
        if (p.kind === "think") think += p.tok; else out += p.tok;
        if (p.t < t0) t0 = p.t; if (p.t > t1) t1 = p.t;
      }
      const sec = Math.max(0.001, (t1 - t0) / 1000);
      // peak of the current step's buckets
      const { peak } = bucketPoints(best);
      return { att: bestAtt, think, out, total: think + out, sec, tps: (think + out) / sec, settled: (byAtt.get(bestAtt).dur.length > 0), peak };
    }

    function drawSpark(c2d, w, h, samples, peak) {
      c2d.clearRect(0, 0, w, h);
      if (!samples.length) return;
      const yMax = niceMax(Math.max(peak * 1.1, 60));
      const n = samples.length;
      const X = (i) => (i / Math.max(1, n - 1)) * w;
      const Y = (v) => h - 2 - (v / yMax) * (h - 4);
      const line = (key, color) => {
        c2d.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = samples[i][key];
          if (v <= 0) continue;
          if (started) c2d.lineTo(X(i), Y(v)); else { c2d.moveTo(X(i), Y(v)); started = true; }
        }
        c2d.strokeStyle = color; c2d.lineWidth = 1.4; c2d.stroke();
      };
      line("think", GR);
      line("out", OR);
    }

    const h = React.createElement;

    function StatCard(props) {
      return h("div", { style: card },
        h("div", { style: cardLabel }, props.label),
        h("div", { style: { ...cardValue, color: props.accent || "#ECECEF" } }, props.value,
          props.unit ? h("span", { style: cardUnit }, " " + props.unit) : null),
        props.sub ? h("div", { style: cardSub }, props.sub) : null);
    }
    const swatch = (color) => h("span", { style: { display: "inline-block", width: 8, height: 8, borderRadius: 2, background: color } });

    function TelemetryView(props) {
      const stats = (props.useProjection && props.useProjection("sessionStats")) || null;
      const usage = (props.useProjection && props.useProjection("tokenUsage")) || null;
      // Resolve the session's eventSource directly from the captured ctx + this
      // slot's standard `sessionId` prop. (A generic list slot does not merge the
      // register `inject` face into props, so we do not rely on props.hooks here.)
      const eventSource = React.useMemo(() => {
        try {
          const b = CTX && CTX.sessions && CTX.sessions.binding(props.sessionId);
          return (b && b.eventSource) || null;
        } catch { return null; }
      }, [props.sessionId]);

      const stateRef = React.useRef(null);
      if (!stateRef.current) stateRef.current = { pts: [], doneSeq: new Set(), liveSeq: -1 };
      const [, force] = React.useReducer((x) => x + 1, 0);
      const canvasRef = React.useRef(null);

      React.useEffect(() => {
        if (!eventSource || typeof eventSource.subscribe !== "function") {
          window.__dshTeleDbg = { ...(window.__dshTeleDbg || {}), effect: "no eventSource", es: String(eventSource) };
          console.log("[dsh-telemetry][effect] no eventSource", String(eventSource));
          return;
        }
        const st = stateRef.current;
        const read = () => {
          try {
            const win = eventSource.getSnapshot();
            const entries = (win && win.entries) || [];
            for (const e of entries) {
              if (e.type === "event" && e.event) {
                const ev = e.event;
                if (ev.type === "assistant/message" && !st.doneSeq.has(ev.seq)) {
                  st.doneSeq.add(ev.seq);
                  const dd = ev.data || {};
                  const att = (dd.turn !== undefined ? dd.turn : "?") + "-" + (dd.step !== undefined ? dd.step : "?");
                  const pts = streamToPoints(dd.stream, att);
                  for (const p of pts) st.pts.push(p);
                }
              } else if (e.type === "transient" && e.event) {
                const ev = e.event;
                if (ev.seq > st.liveSeq) st.liveSeq = ev.seq;
                const dd = ev.data || {};
                const att = (dd.turn !== undefined ? dd.turn : "?") + "-" + (dd.step !== undefined ? dd.step : "?");
                const chunk = dd.chunk;
                if (!chunk) continue;
                if (chunk.type === "reasoning-delta") { const tk = estTokens(chunk.text); if (tk) st.pts.push({ t: ev.time, kind: "think", tok: tk, att, src: "live" }); }
                else if (chunk.type === "text-delta") { const tk = estTokens(chunk.text); if (tk) st.pts.push({ t: ev.time, kind: "out", tok: tk, att, src: "live" }); }
              }
            }
          } catch { /* never break the host */ }
          force();
        };
        read();
        const unsub = eventSource.subscribe(read);
        return unsub;
      }, [eventSource]);

      React.useEffect(() => {
        const cv = canvasRef.current; if (!cv) return;
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth, hh = cv.clientHeight;
        if (cv.width !== w * dpr || cv.height !== hh * dpr) { cv.width = w * dpr; cv.height = hh * dpr; }
        const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
        const { samples, peak } = bucketPoints(stateRef.current.pts);
        drawSpark(c, w, hh, samples, peak);
        stateRef.current._peak = peak;
        stateRef.current._n = samples.length;
      });

      const decodeTps = stats && stats.decodeMs > 50 ? num(stats.decodeTokens) / (stats.decodeMs / 1000) : 0;
      const outTps = stats && stats.llmMs > 50 ? num(stats.decodeTokens || (usage && usage.outputTokens)) / (stats.llmMs / 1000) : 0;
      const avgTtft = stats && stats.ttftSteps > 0 ? (num(stats.ttftMs) / stats.ttftSteps) / 1000 : null;
      const totalTokens = usage ? num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.outputTokens) : 0;
      const peak = stateRef.current._peak || 0;
      const live = computeLive(stateRef.current.pts);

      return h("div", { style: page },
        h("div", { style: header },
          h("h2", { style: title }, "Token 遥测"),
          h("span", { style: subtitle }, "session " + (props.sessionId || "—"))),
        h("div", { style: curveBox },
          h("div", { style: legend },
            h("span", { style: legendItem }, swatch(GR), " 思考"),
            h("span", { style: legendItem }, swatch(OR), " 输出"),
            h("span", { style: legendPeak }, "峰值 ", fmt(peak), " token/s · ", (stateRef.current._n || 0), " 桶")),
          h("canvas", { ref: canvasRef, style: canvas }),
          h("div", { style: liveStrip },
            live ? h("span", { style: liveItem }, "实时 步 ", live.att, live.settled ? "（已结算）" : "（流式中）") : null,
            live ? h("span", { style: liveItem }, "思考 ", h("b", { style: { color: GR } }, fmt(live.think))) : null,
            live ? h("span", { style: liveItem }, "输出 ", h("b", { style: { color: OR } }, fmt(live.out))) : null,
            live ? h("span", { style: liveItem }, "已用 ", h("b", null, live.sec.toFixed(1) + "s")) : null,
            live ? h("span", { style: liveItem }, "即时 ", h("b", { style: { color: OR } }, fmt(live.tps) + " tok/s")) : null,
            live ? h("span", { style: liveItem }, "步峰 ", h("b", null, fmt(live.peak))) : null,
            live ? null : h("span", { style: liveItem }, "等待流式数据…"))),
        h("div", { style: grid },
          h(StatCard, { label: "解码 TPS (整段)", value: fmt(decodeTps), unit: "tok/s", accent: OR, sub: stats ? fmt(num(stats.decodeTokens)) + " 输出 tok · " + (num(stats.decodeMs) / 1000).toFixed(1) + "s" : "—" }),
          h(StatCard, { label: "模型 TPS (整段)", value: fmt(outTps), unit: "tok/s", sub: stats ? "LLM 墙钟 " + (num(stats.llmMs) / 1000).toFixed(1) + "s" : "—" }),
          h(StatCard, { label: "首响应 (均值)", value: avgTtft === null ? "—" : avgTtft.toFixed(2), unit: avgTtft === null ? "" : "s", sub: stats ? stats.ttftSteps + " 步采样" : "—" }),
          h(StatCard, { label: "总 Tokens", value: fmt(totalTokens), sub: usage ? "输入 " + fmt(num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) + " · 输出 " + fmt(num(usage.outputTokens)) : "—" })),
        h("div", { style: footer }, "回合 ", stats ? stats.turns : 0, " · 步 ", stats ? stats.steps : 0, " · 工具 ", stats ? (num(stats.toolMs) / 1000).toFixed(1) + "s" : "0s", " · 缓存读 ", usage ? fmt(num(usage.cacheReadTokens)) : 0));
    }

    const page = { padding: "18px 20px", color: "#ECECEF", font: "13px system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif", height: "100%", overflow: "auto", boxSizing: "border-box", background: "#0B0B0D" };
    const header = { display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 };
    const title = { fontSize: 14, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600, margin: 0 };
    const subtitle = { font: "11px ui-monospace, monospace", color: "#5A5A62" };
    const curveBox = { border: "1px solid #24242A", borderRadius: 12, padding: "12px 14px", marginBottom: 14, background: "linear-gradient(180deg,#151519,#0F0F12)" };
    const legend = { display: "flex", alignItems: "center", gap: 16, fontSize: 11.5, color: "#8B8B93", marginBottom: 8 };
    const legendItem = { display: "flex", alignItems: "center", gap: 6 };
    const legendPeak = { marginLeft: "auto", font: "11px ui-monospace, monospace", color: "#5A5A62" };
    const canvas = { display: "block", width: "100%", height: 150 };
    const liveStrip = { display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 10, paddingTop: 10, borderTop: "1px solid #24242A", font: "11.5px ui-monospace, monospace", color: "#8B8B93" };
    const liveItem = { display: "inline-flex", alignItems: "center", gap: 5 };
    const grid = { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 };
    const card = { border: "1px solid #24242A", borderRadius: 12, padding: "14px 16px", background: "#0E0E11" };
    const cardLabel = { fontSize: 11, color: "#5A5A62", letterSpacing: ".06em", marginBottom: 8 };
    const cardValue = { font: "700 24px ui-monospace, monospace", letterSpacing: "-.02em" };
    const cardUnit = { fontSize: 11, fontWeight: 500, color: "#5A5A62" };
    const cardSub = { font: "10.5px ui-monospace, monospace", color: "#5A5A62", marginTop: 6 };
    const footer = { marginTop: 14, font: "11px ui-monospace, monospace", color: "#5A5A62" };

    const inject = ["slots", "sessions"];
    let CTX = null; // captured in apply(); component resolves the event feed from it

    function apply(ctx) {
      CTX = ctx;
      if (!ctx.slots || typeof ctx.slots.inject !== "function") {
        console.warn("[dsh-token-telemetry] ctx.slots unavailable; panel not mounted");
        return;
      }
      ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view",
        id: VIEW_ID,
        order: 20,
        label: () => "Token 遥测",
      }, TelemetryView));
      console.log("[dsh-token-telemetry] client half mounted (conversation.view tab)");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
