#!/usr/bin/env node
/**
 * Dev tool: replace the panel stylesheet inside client.js with the contents of
 * a plain .css file, so the sheet can be authored and audited on its own
 * without hand-matching a long template literal.
 *
 *   node tools/splice-css.mjs <clientFile> <cssFile> [buildLabel]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [clientFile, cssFile, buildLabel] = process.argv.slice(2)
if (!clientFile || !cssFile) {
  console.error('usage: node tools/splice-css.mjs <clientFile> <cssFile> [buildLabel]')
  process.exit(1)
}

const source = readFileSync(clientFile, 'utf8')
// The sheet lives inside a JS template literal, so a stray backtick or ${ in a
// CSS comment would terminate it early — escape both before splicing.
const css = readFileSync(cssFile, 'utf8')
  .replace(/\s+$/, '')
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')

const marker = 'const CSS = `'
const start = source.indexOf(marker)
if (start < 0) throw new Error('CSS template literal not found')
const bodyStart = start + marker.length
const end = source.indexOf('`', bodyStart)
if (end < 0) throw new Error('unterminated CSS template literal')

let next = source.slice(0, bodyStart) + '\n' + css + '\n' + source.slice(end)
if (buildLabel) {
  next = next.replace(/const PANEL_BUILD = '[^']*'/, `const PANEL_BUILD = '${buildLabel}'`)
}
writeFileSync(clientFile, next, 'utf8')
console.log(`spliced ${css.length} bytes of CSS into ${clientFile}`)
if (buildLabel) console.log(`PANEL_BUILD = ${buildLabel}`)
