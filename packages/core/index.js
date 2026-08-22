/**
 * The index, the graph, the resolver and the cache.
 *
 * A pure function of the file tree, and nothing above it in the layer graph may be
 * reached from here — not `format`, not `verbs`, not `mcp`. That is what keeps the
 * index cacheable with no watcher, and what makes the MCP server ordinary rather
 * than architecturally privileged (toolbox decision 9).
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
