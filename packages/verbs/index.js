/**
 * The structural verbs: the writes that corrupt something when done by hand.
 *
 * [[toolbox-decisions]] 12 draws the line — rename, move, delete, split, merge,
 * tag-rename, and the generated listing. Ordinary prose edits stay with the agent's
 * own `Write` and `Edit`, and the index picks them up on the next call.
 *
 * Every verb here is **re-runnable**, because decision 20 makes a partial
 * completion normal: nothing locks, a file that moved under us is skipped and
 * reported, and re-running is how the rest gets finished.
 */
export {moveNote, renameNote} from './lib/move.js'
export {deleteNote} from './lib/delete.js'
export {splitByHeading} from './lib/split.js'
export {mergeFiles} from './lib/merge.js'
export {renameTag} from './lib/tags.js'
export {buildListing, MARKER_START, MARKER_END} from './lib/listing.js'
export {createEdit} from './lib/edit.js'
export {shortestUniqueForm, relativePathFrom} from './lib/rewrite.js'
