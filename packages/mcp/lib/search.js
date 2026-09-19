/** `search`: one call over full text, front matter and tags. */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

/**
 * @param query    plain text, matched case-insensitively; or `/regex/flags`.
 * @param fields   which of `text`, `title`, `tags`, `properties` to look in.
 * @param limit    how many notes to return; matches within a note are all returned.
 */
export function search(workspace, {query, fields, tag, type, area, topic, limit = 20} = {}) {
  const wanted = new Set(fields ?? ['text', 'title', 'tags', 'properties'])
  const matcher = buildMatcher(query)
  const results = []

  for (const resource of workspace.resources) {
    if (tag && !resource.tags.includes(tag)) continue
    if (type && resource.properties.type !== type) continue
    // What `area:` says, like `type` and `topic` — never the top folder, which in a
    // nested layout is `projects` for every note. `buildListing` reads it the same way.
    if (area && resource.properties.area !== area) continue
    if (topic && resource.properties.topic !== topic) continue

    if (!matcher) {
      results.push({path: resource.path, title: resource.title, matches: []})
      continue
    }

    const matches = []
    if (wanted.has('title') && matcher.test(resource.title)) {
      matches.push({field: 'title', line: 0, text: resource.title})
    }
    if (wanted.has('tags')) {
      for (const value of resource.tags) {
        if (matcher.test(value)) matches.push({field: 'tags', line: 0, text: value})
      }
    }
    if (wanted.has('properties')) {
      for (const [key, value] of Object.entries(resource.properties)) {
        if (key === 'tags' || key === 'title') continue
        if (typeof value === 'string' && matcher.test(value)) {
          matches.push({field: `properties.${key}`, line: 0, text: value})
        }
      }
    }
    if (wanted.has('text')) {
      // Read the body here rather than holding every note's text in the index: the
      // index is written to a cache file, and 181 note bodies is a different
      // artifact from 181 note summaries.
      const lines = readFileSync(join(workspace.notesDir, resource.path), 'utf8').split('\n')
      lines.forEach((line, offset) => {
        if (matcher.test(line)) matches.push({field: 'text', line: offset + 1, text: line.trim()})
      })
    }

    if (matches.length > 0) results.push({path: resource.path, title: resource.title, matches})
  }

  return {
    query: query ?? null,
    total: results.length,
    truncated: results.length > limit,
    results: results.slice(0, limit),
  }
}

/** `/pattern/flags` is a regex; anything else is literal text, case-insensitively. */
function buildMatcher(query) {
  if (!query) return null
  const delimited = /^\/(.*)\/([gimsuy]*)$/s.exec(query)
  if (delimited) return new RegExp(delimited[1], delimited[2].replace('g', ''))
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}
