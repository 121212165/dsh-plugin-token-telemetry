# dsh-token-telemetry

> 🧩 **dsh 插件家族**（22 件）：总目录 **[dsh-plugin-family](https://github.com/121212165/dsh-plugin-family)** ｜ 明星插件：**[ide-hub](https://github.com/121212165/dsh-plugin-ide-hub)** 跨 IDE 统一管理 · **[task-forge](https://github.com/121212165/dsh-plugin-task-forge)** 跨窗口无损交接 · **[quota](https://github.com/121212165/dsh-plugin-quota)** 实时用量仪表

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin — part of the
`dsh-plugin-*` family — that surfaces **token throughput telemetry** from real harness data, in
three layers:

- **Per-turn inline card** (`conversation.chat.turnTail`) — under each completed turn, a compact
  row: thinking / output tokens, throughput tok/s, wall time, a mini dual-line sparkline, and a
  "明细" toggle that expands a per-step table (step · think · out · duration · tok/s · tool ·
  state).
- **Aggregate view** (`conversation.view` tab "Token 遥测") — full thinking-vs-output TPS curve,
  settlement cards (decode TPS, mean TTFT, total tokens), and a cross-turn overview table.
- **Live counters** — the curve and numbers recompute every 250 ms from the streaming events, so
  they animate during a turn (the durable `sessionStats`/`tokenUsage` projections only tick at
  `step/end`).

All figures come from the harness's own durable surfaces — no simulated data:


| Panel field | Source |
|---|---|
| decode TPS / model TPS / TTFT / turns / steps / toolMs | `sessionStats` projection (`@deepseek-ai/dsh-session-stats`) |
| total / output / cache-read tokens | `tokenUsage` projection (`@deepseek-ai/dsh-token-meter`) |
| live TPS curve | `SessionBinding.eventSource` → settled `assistant/message` `stream` (timed `AssistantStreamRecord`s) + transient `assistant/live-chunk` deltas |

The curve reconstructs from the **durable timed stream** carried on each settled
`assistant/message` event, so it renders correctly even after a turn completes (not only
mid-stream).

## Architecture

`dsh` is "everything is a plugin" on [Cordis](https://github.com/cordiverse/cordis). A plugin is
one package with two halves:

- **Host half** — `exports["."]` → `apply(ctx)` (Node). This plugin has no host-side behavior
  (it only surfaces data the host already computes), so `apply` is a no-op that makes the row
  appear in the composed profile.
- **Client half** — `exports["./client"]` → `lib/client.js`, a browser module registered via
  `window.__ModuleLoader__.load(...)`. It declares `inject = ["slots", "sessions"]` and in
  `apply(ctx)` mounts a React component into the `conversation.view` slot.

The client bundle is hand-authored in the exact shape the loader expects (React is an external
resolved by `require("react")`), so no bundler is required to build it.

## Install into a dsh profile

1. Make the package resolvable from the profile (here: `~/.dsh/profiles/web`, boot dir's
   `node_modules`), e.g. copy it to `node_modules/dsh-token-telemetry`.
2. Add one insert row to the profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: token-telemetry
         name: dsh-token-telemetry
   ```

3. Restart `dsh web`. The "Token 遥测" tab appears in a session's conversation view.

## Verified

Tested against a clean `dsh web` instance (`@deepseek-ai/dsh@0.1.7-alpha.1`) with real
StepFun `step-5-preview` turns:

- **Aggregate + live counters: confirmed against real data.** Settlement matched dsh's native stats
  pill exactly (74 tok/s, 11.9K tok), and a multi-step agent task (a Gomoku build) produced a
  correct per-step cross-turn table (13,427 output tok / 132,814 input+cache / ~92 tok/s avg).
- **Per-turn inline cards and the trajectory ribbon render** with real per-step curves, colored by
  phase (thinking / output / tool) and sized by wall time — confirmed via headless screenshots.
  Phantom turn-0 rows and empty step blocks are filtered out.


## Notes / limitations

- Token counts on the live curve use a CJK-aware heuristic (`estTokens`); durable settlement uses
  the provider-reported `sessionStats`/`tokenUsage` values.
- The plugin is per-session (a conversation-view tab). A multi-session "queue" overview would add
  a `main` + `sidebar.panellist` panel reading `useSessions`.
- `dsh` is in developer preview; plugin surfaces can change.

MIT
