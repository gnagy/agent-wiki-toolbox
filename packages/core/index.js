/**
 * The index, the graph, the resolver and the cache.
 *
 * A pure function of the file tree, and nothing above it in the layer graph may be
 * reached from here — not `format`, not `verbs`, not `mcp`. That is what keeps the
 * index cacheable with no watcher, and what makes the MCP server ordinary rather
 * than architecturally privileged (toolbox decision 9).
 */
export {loadWorkspace, buildWorkspace} from './lib/workspace.js'
export {createResolver, normaliseTarget, checkAnchor} from './lib/resolve.js'
export {slugifyPath, slugifySegment, createAnchorSlugger} from './lib/slug.js'
export {parseNote} from './lib/note.js'
export {walkNotes} from './lib/walk.js'
export {check} from './lib/check.js'
export {INDEX_VERSION, cachePathFor, cacheDirectory, hashSource, readCache, writeCache} from './lib/cache.js'
