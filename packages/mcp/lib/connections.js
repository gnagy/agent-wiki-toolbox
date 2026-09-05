/** `connections`: links out, links in, to a depth. One tool for depth 1 and depth n. */
export function connections(workspace, {path, depth = 1, direction = 'both'} = {}) {
  const start = workspace.get(path)
  if (!start) {
    // Both surfaces get the same sentence, because both callers make the same
    // mistake: `connections` takes a path and `resolve` takes a stem, and a bare
    // stem here is a miss rather than a lookup.
    return {
      path,
      error:
        `no note at ${path}; connections takes a workspace-relative path such as meta/conventions.md, ` +
        'and resolve takes a bare stem',
    }
  }

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
