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

  // Open-questions 37, answered: an aliased link is an error, with the same weight
  // as an ambiguous one. Decision 27's reasoning is that a link needing a label is
  // a naming failure, so the fix is nearly always the filename rather than the
  // link — and a rule that only warns is a ban nobody ever finishes applying.
  for (const site of workspace.aliasedLinks) {
    problems.push({
      severity: 'error',
      rule: 'aliased-link',
      path: site.from,
      line: site.line,
      message:
        `[[${site.target}|${site.alias}]] carries a label. A link that needs one is a naming ` +
        'failure (decision 27): rename the note so its own name reads in the sentence',
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
    root: workspace.root,
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
