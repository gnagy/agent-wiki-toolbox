/**
 * The structural verbs: the writes that corrupt something when done by hand.
 *
 * Rename, move, delete, split, merge, tag-rename, the generated listing, and the
 * front matter — which is its own domain rather than another item, with its own
 * parser, its own address and its own hazards.
 *
 * Ordinary prose edits stay with the agent's own file tools, and the index picks
 * them up on the next call.
 *
 * Every verb is re-runnable: nothing locks, a file that changed underneath is
 * skipped and reported, and re-running finishes the rest.
 */
export {moveNote, renameNote} from './lib/move.js'
export {deleteNote} from './lib/delete.js'
export {splitByHeading} from './lib/split.js'
export {mergeFiles} from './lib/merge.js'
export {renameTag} from './lib/tags.js'
export {frontmatter, FRONTMATTER_CODES} from './lib/frontmatter.js'
export {buildListing, MARKER_START, MARKER_END} from './lib/listing.js'
export {createEdit} from './lib/edit.js'
export {shortestResolvingForm, relativePathFrom} from './lib/rewrite.js'
