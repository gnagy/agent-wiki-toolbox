/**
 * The index, the graph, the resolver and the cache.
 *
 * A pure function of the file tree. Nothing above it in the layer graph is reached
 * from here: not `format`, not `verbs`, not `mcp`. That keeps the index cacheable
 * with no watcher.
 */
export {loadWorkspace, buildWorkspace} from './lib/workspace.js'
export {createResolver, canonicaliseTarget, normaliseTarget, checkAnchor, joinRelative} from './lib/resolve.js'
export {slugifyPath, slugifySegment, sluggify, simplifySlug, isFolderPath, createAnchorSlugger} from './lib/slug.js'
export {parseNote} from './lib/note.js'
export {walkNotes} from './lib/walk.js'
export {check} from './lib/check.js'
export {computeAddresses} from './lib/address.js'
export {materialiseIndex, writeIndexArtifact, ARTIFACT_VERSION} from './lib/artifact.js'
export {INDEX_VERSION, cachePathFor, cacheDirectory, hashSource, readCache, writeCache} from './lib/cache.js'
export {
  resolvePath,
  describeTarget,
  renderTarget,
  sectionEnd,
  sectionsOf,
  tableHeader,
  columnIndex,
  tableRows,
  listItemTerm,
  textOf,
  PATH_CODES,
  SEGMENT_TYPES,
} from './lib/segments.js'
