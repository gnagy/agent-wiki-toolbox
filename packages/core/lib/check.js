/**
 * Everything wrong with the graph, in one call.
 *
 * A placeholder is not a problem. It is reported separately and never fails a check.
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

  // An aliased link is an error because `rename` rewrites the target and leaves
  // the label, so the label goes stale.
  for (const site of workspace.aliasedLinks) {
    problems.push({
      severity: 'error',
      rule: 'aliased-link',
      path: site.from,
      line: site.line,
      message: `[[${site.target}|${site.alias}]] carries a label; rename does not rewrite the label, so it goes stale`,
    })
  }

  // The miss that used to be filed as backlog. Reported at the link rather than at
  // the note, because the note is fine — it is the link that cannot reach it.
  for (const site of workspace.unreachableNotes) {
    problems.push({
      severity: 'error',
      rule: 'unreachable-note',
      path: site.from,
      line: site.line,
      message:
        `[[${site.target}]] names ${site.to}, which exists — but the link resolves to nothing, ` +
        'so it yields no edge. Link it by a form that resolves, or as a relative markdown link',
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

  // A note that should be its folder's landing page and cannot be, because
  // another note already holds that address. Both pages are then served and one
  // shadows the other in the explorer and the breadcrumbs, which is not something
  // any tool gets to resolve on the author's behalf.
  for (const note of workspace.shadowedNotes) {
    problems.push({
      severity: 'error',
      rule: 'shadowed-folder-note',
      path: note.path,
      line: 1,
      message:
        `it sits beside a folder of its own name, so it should be served at ${note.address} — ` +
        `but ${note.heldBy} already is. One of the two has to go`,
    })
  }

  // Reported on every file in the group rather than once on the group, because
  // the fix is to rename one of them and the author needs both named where they
  // live. Which one survives today depends on directory walk order, so this is an
  // error rather than a warning about a coin flip.
  for (const collision of workspace.collidingViews) {
    for (const path of collision.paths) {
      const others = collision.paths.filter((other) => other !== path)
      problems.push({
        severity: 'error',
        rule: 'colliding-view',
        path,
        line: 1,
        message:
          `it is served at ${collision.address}, and so ${others.length > 1 ? 'are' : 'is'} ` +
          `${others.join(', ')} — one page. The index keeps whichever the walk reached last, ` +
          'so rename or move all but one',
      })
    }
  }

  for (const site of workspace.unclosedLinks) {
    problems.push({
      severity: 'warning',
      rule: 'unclosed-wikilink',
      path: site.from,
      line: site.line,
      message: `a "[[" that never became a link — it yields no edge and no placeholder: …${site.text}…`,
    })
  }

  return {
    notesDir: workspace.notesDir,
    notes: workspace.resources.length,
    links: workspace.edges.length,
    problems,
    placeholders: workspace.placeholders(),
    orphans: workspace.orphans(),
    deadends: workspace.deadends(),
    unreferenced: workspace.unreferenced(),
    crossWikiLinks: workspace.crossWikiLinks.length,
    healthy: problems.every((problem) => problem.severity !== 'error'),
  }
}
