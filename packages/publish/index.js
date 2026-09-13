/**
 * Building and releasing a wiki as a Quartz site.
 *
 * Its own package rather than a layer: the stack below is a resolution stack, and
 * a build orchestrator resolves nothing. It clones a
 * pinned renderer, stages a build, renames a release, and turns mermaid sources
 * into pictures. It may read the index from `core`; nothing below it may depend on
 * it.
 *
 * It also owns the one zero-dependency Quartz plugin in `quartz-plugins/awt`, which
 * stays dependency-free by consuming the materialised index as data, and the
 * derivation of the config Quartz reads (`lib/site-config.js`).
 */
export {bootstrap, gitignoreGaps} from './lib/bootstrap.js'
export {extractDeclaration, renderDeclaration} from './lib/migrate.js'
export {deriveSiteConfig, writeSiteConfig, DERIVED_CONFIG, PROJECT_CONFIG, PLUGIN_SOURCE} from './lib/site-config.js'
export {publish} from './lib/release.js'
export {serve, DEFAULT_PORT, wsPortFor} from './lib/serve.js'
export {renderDiagrams, rasterize, disposeRenderer} from './lib/diagrams.js'
export {prerenderDiagrams} from './lib/diagrams-pass.js'
export {findFont, loadFont} from './lib/font-metrics.js'
