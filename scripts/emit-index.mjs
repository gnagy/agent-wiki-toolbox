#!/usr/bin/env node
/**
 * Write a wiki's index where a Quartz build can read it.
 *
 *   node scripts/emit-index.mjs <wiki-root> <output.json>
 *
 * A stopgap with a known end date: M7 folds this into `awt index`, and M8's build
 * orchestrator runs it before invoking Quartz so the shadow can never compare
 * against a stale artifact. Until then it is what the soak runs by hand.
 */
import process from 'node:process'

import {loadWorkspace, writeIndexArtifact} from '../packages/core/index.js'

const [root, output] = process.argv.slice(2)
if (!root || !output) {
  console.error('usage: emit-index.mjs <wiki-root> <output.json>')
  process.exit(2)
}

const workspace = loadWorkspace(root)
const artifact = writeIndexArtifact(workspace, output)
console.log(
  `${output}: ${Object.keys(artifact.pages).length} notes, ${workspace.edges.length} links, ` +
    `${workspace.placeholders().length} placeholders, ${workspace.ambiguities.length} ambiguous`,
)
