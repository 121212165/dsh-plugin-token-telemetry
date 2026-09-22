# dsh-token-telemetry

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that adds a
per-session **token throughput telemetry** panel. It mounts a "Token 遥测" tab into the
conversation view and shows, from **real harness data**:

- **Live dual-line TPS curve** — thinking (`reasoning`) vs output (`text`) tokens/s over 250 ms
  buckets, with the running peak.
- **Settlement cards** — decode TPS, model TPS, mean first-token latency (TTFT), and total
  tokens.
- **Whole-session footer** — turns / steps / tool time / cache-read tokens.

Everything is read from the harness's own durable surfaces — no simulated data:

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

Tested against a clean `dsh web` instance (`@deepseek-ai/dsh@0.1.7-alpha.1`) with two real turns
on `step-5-preview`:

- Settlement matched dsh's native stats pill exactly (e.g. **74 tok/s**, **11.9K tok**).
- Live curve rendered from the real streams (peak ~208 tok/s across 912 buckets).

## Notes / limitations

- Token counts on the live curve use a CJK-aware heuristic (`estTokens`); durable settlement uses
  the provider-reported `sessionStats`/`tokenUsage` values.
- The plugin is per-session (a conversation-view tab). A multi-session "queue" overview would add
  a `main` + `sidebar.panellist` panel reading `useSessions`.
- `dsh` is in developer preview; plugin surfaces can change.

MIT
