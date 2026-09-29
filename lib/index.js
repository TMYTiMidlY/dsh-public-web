/**
 * Append public authorities to the web runtime trust list.
 * Connection keeps that array and checks it on every /api request, including
 * when a later profile patch reads `ctx.webRuntime.trustedHosts` by reference.
 * @param ctx - host context.
 * @param config - `{ hosts: string[] }`, bare host or host:port.
 */
export function apply(ctx, config) {
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
