//#region lib/index.js
/**
 * dsh-token-telemetry — Node (host) half.
 *
 * This is a presentation surface: every figure it shows is either a durable
 * projection (sessionStats / tokenUsage) already computed host-side and served
 * to the browser, or a client-observed live stream frame. So the host half
 * carries no behavior of its own; the empty `apply` exists so the plugin row
 * appears in the composed profile and the browser half ships via
 * exports["./client"] (discovered through the package.json `dsh.client`
 * manifest), mirroring the official dsh-client-ui-cordis surface plugin.
 */
export function apply(ctx) {
  // Proof-of-load only. `ctx.logger` is the framework logger (cordis).
  try {
    ctx.logger?.info?.('dsh-token-telemetry: host half loaded');
  } catch {
    console.log('[dsh-token-telemetry] host half loaded');
  }
}
//#endregion
