/**
 * "Is this graph healthy?" in one call.
 *
 * Foam answered it in four — `lint`, `list placeholders`, `list orphans`,
 * `list deadends` — and the estate ran all four every time, which is the shape
 * toolbox decision 24 is reacting to.
 *
 * **A placeholder is not a problem.** It is the backlog signal, so it is reported
 * separately from the things that are actually wrong, and it never fails a check.
 */
export function check(workspace) {
  const problems = []

  for (const site of workspace.ambiguities) {
    problems.push({
      severity: 'error',
      rule: 'ambiguous-link',
      path: site.from,
      line: site.line,
      message: `[[${site.target}]] matches ${site.candidates.length} notes: ${site.candidates.join(', ')}`,
    })
  }

  for (const site of workspace.brokenLinks) {
    problems.push({
      severity: 'error',
      rule: 'broken-link',
      path: site.from,
      line: site.line,
      message: `no file at ${site.target}`,
    })
  }

  for (const site of workspace.brokenAnchors) {
    problems.push({
      severity: 'error',
      rule: 'missing-anchor',
      path: site.from,
      line: site.line,
      message: `${site.to} has no heading "#${site.anchor}"`,
    })
  }

  return {
    root: workspace.root,
    notes: workspace.resources.length,
    links: workspace.edges.length,
    problems,
    placeholders: workspace.placeholders(),
    orphans: workspace.orphans(),
    deadends: workspace.deadends(),
    unreferenced: workspace.unreferenced(),
    crossWikiLinks: workspace.crossWikiLinks.length,
    healthy: problems.length === 0,
  }
}
