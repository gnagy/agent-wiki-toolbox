#!/usr/bin/env node
/**
 * Run the MCP server over stdio.
 *
 *   awt mcp --workspace docs/wiki [--allow-writes]
 *
 * Nothing is watched and nothing is held open: every call reloads the index, which
 * is a few `stat`s warm (decision 9). So the server may be started before the wiki
 * has any notes, and it will see them.
 */
import {parseArgs} from 'node:util'
import {resolve} from 'node:path'
import process from 'node:process'

import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'

import {createServer} from '../index.js'

const {values} = parseArgs({
  options: {
    workspace: {type: 'string'},
    'allow-writes': {type: 'boolean', default: false},
    name: {type: 'string'},
  },
})

const root = resolve(values.workspace ?? process.env.AWT_WORKSPACE ?? process.cwd())
const server = createServer({root, allowWrites: values['allow-writes'], name: values.name})

await server.connect(new StdioServerTransport())
