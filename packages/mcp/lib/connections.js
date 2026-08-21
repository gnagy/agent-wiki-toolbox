/**
 * `connections` — links out, links in, to a depth.
 *
 * Foam's `get_connections` and `traverse_graph` are one question asked at depth 1
 * and depth n; splitting them makes an agent choose a tool before it knows how far
 * it needs to look ([[toolbox-decisions]] 24).
 */
export function connections(workspace, {path, depth = 1, direction = 'both'} = {}) {
  const start = workspace.get(path)
  if (!start) return {path, error: `no note at ${path}`}

  const seen = new Map([[path, 0]])
  let frontier = [path]

  for (let level = 1; level <= depth; level++) {
    const next = []
    for (const current of frontier) {
      const neighbours = [
        ...(direction === 'in' ? [] : workspace.outbound(current)),
        ...(direction === 'out' ? [] : workspace.backlinks(current)),
      ]
      for (const neighbour of neighbours) {
        if (seen.has(neighbour)) continue
        seen.set(neighbour, level)
        next.push(neighbour)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }

  const describe = (target) => ({
    path: target,
    title: workspace.get(target)?.title ?? target,
    depth: seen.get(target),
  })

  return {
    path,
    title: start.title,
    links: workspace.outbound(path).map(describe),
    backlinks: workspace.backlinks(path).map(describe),
    reached: [...seen.keys()].filter((target) => target !== path).map(describe),
    // A note nothing links to is reachable by search and by nothing else, which is
    // usually the answer someone asking about connections actually wants.
    unreferenced: workspace.backlinks(path).length === 0,
  }
}
