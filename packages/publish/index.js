/**
 * Building and releasing a wiki as a Quartz site.
 *
 * Its own package rather than a layer ([[toolbox-decisions]] 21): the stack below
 * is a *resolution* stack, and a build orchestrator resolves nothing — it clones a
 * pinned renderer, stages a build, renames a release, and turns mermaid sources
 * into pictures. It may read the index from `core`; nothing below it may depend on
 * it.
 *
 * It also owns the three zero-dependency Quartz plugins in `quartz-plugins/`, which
 * stay dependency-free by consuming the materialised index as data.
 */
export {bootstrap, gitignoreGaps} from './lib/bootstrap.js'
export {publish} from './lib/release.js'
export {serve, DEFAULT_PORT, wsPortFor} from './lib/serve.js'
export {renderDiagrams, rasterize, disposeRenderer} from './lib/diagrams.js'
export {prerenderDiagrams} from './lib/diagrams-pass.js'
export {findFont, loadFont} from './lib/font-metrics.js'
