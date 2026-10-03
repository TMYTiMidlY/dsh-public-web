import { readFileSync } from "node:fs"

const browserAdapter = readFileSync(new URL("./client.js", import.meta.url), "utf8")

/**
 * Append public authorities to the web runtime trust list.
 * Connection keeps that array and checks it on every /api request, including
 * when a later profile patch reads `ctx.webRuntime.trustedHosts` by reference.
 * @param ctx - host context.
 * @param config - public authorities and the initial watch acknowledgement budget.
 */
export function apply(ctx, config) {
  const watchAckTimeoutMs = config?.watchAckTimeoutMs ?? 800
  if (!Number.isInteger(watchAckTimeoutMs) || watchAckTimeoutMs < 1 || watchAckTimeoutMs > 60000) {
    throw new Error("dsh-public-web: watchAckTimeoutMs must be an integer from 1 to 60000")
  }
  ctx.on("webserver/index-inject", (table) => {
    // Run before the official registration facade is created. Its client
    // bundles, module graph and entry implementations remain official.
    table.unshift(
      { kind: "global", name: "__DSH_PUBLIC_WEB_CONFIG__", value: { watchAckTimeoutMs } },
      { kind: "script", placement: "head", text: browserAdapter },
    )
  })
  const hosts = publicHosts(config?.hosts)
  if (hosts.length === 0) return
  ctx.inject(["webRuntime"], (webCtx) => {
    const list = webCtx.webRuntime?.trustedHosts
    if (!Array.isArray(list)) return
    for (const host of hosts) {
      if (list.some((entry) => String(entry).toLowerCase() === host.toLowerCase())) continue
      list.push(host)
    }
  })
}

function publicHosts(value) {
  if (!Array.isArray(value)) return []
  const hosts = []
  for (const entry of value) {
    if (typeof entry !== "string" || !isBareAuthority(entry)) continue
    hosts.push(entry)
  }
  return hosts
}

function isBareAuthority(entry) {
  if (entry !== entry.trim() || entry.includes("://") || entry.includes("/") || entry.includes("@")) return false
  try {
    const url = new URL(`http://${entry}`)
    return url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === ""
  } catch {
    return false
  }
}
