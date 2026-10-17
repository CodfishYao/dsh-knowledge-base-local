#!/usr/bin/env node
/**
 * Dev tool: audit the panel stylesheet against the shell's styling rules.
 *
 * Enforced:
 *  - no literal colours (hex / rgb() / rgba() / hsl()): components consume
 *    semantic --dsw-alias-* tokens only, so both palettes stay correct;
 *  - every --dsw-* / --ds-* / --dsh-* reference must exist in the token sheets
 *    (scanned from ui-theme/src/styles) or carry a fallback;
 *  - every local --kb-* variable must be defined in the sheet or supplied from
 *    React inline style;
 *  - uncapped radii (50% / pill) pair with `corner-shape: round`;
 *  - braces balance and declarations terminate.
 *
 *   node tools/audit-css.mjs [clientFile] [--tokens <stylesDir>]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_TOKEN_DIR = '../dsh-client/ui-theme/src/styles'
const INLINE_STYLE_VARS = new Set(['--kb-seg-count', '--kb-seg-index'])
/**
 * Frame custom properties published at runtime by ui-layout rather than by the
 * token sheets. The shell's own Modal sheet reads them the same way, always
 * with a fallback, so they are legitimate here.
 */
const FRAME_PROVIDED_VARS = new Set(['--dsh-frame-overlay-top', '--dsh-frame-chrome-top'])

const args = process.argv.slice(2)
const clientFile = args.find((a) => !a.startsWith('--')) ?? 'client.js'
const tokensFlag = args.indexOf('--tokens')
const tokenDir = tokensFlag >= 0 ? args[tokensFlag + 1] : DEFAULT_TOKEN_DIR

/** Every custom property the shell's token sheets define. */
function knownTokens(dir) {
  const found = new Set()
  let files = []
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.css'))
  } catch {
    return found
  }
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8')
    for (const match of text.matchAll(/(--(?:dsw|ds|dsh)-[a-z0-9-]+)\s*:/g)) found.add(match[1])
  }
  return found
}

const source = readFileSync(clientFile, 'utf8')
const start = source.indexOf('const CSS = `')
const end = source.indexOf('`', start + 13)
if (start < 0 || end < 0) {
  console.error('could not locate the CSS template literal')
  process.exit(1)
}
const css = source.slice(start + 13, end)
const declared = knownTokens(tokenDir)

const problems = []
const notes = []

// 1. literal colours
const literals = [
  ...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
  ...css.matchAll(/\brgba?\(/g),
  ...css.matchAll(/\bhsla?\(/g),
]
for (const match of literals) problems.push(`literal colour ${match[0]}`)

// 2. variable references
const defined = new Set([...css.matchAll(/(--kb-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
const referenced = new Set()
let index = 0
while ((index = css.indexOf('var(', index)) !== -1) {
  let depth = 0
  let at = index + 3
  for (; at < css.length; at++) {
    if (css[at] === '(') depth++
    else if (css[at] === ')') {
      depth--
      if (depth === 0) break
    }
  }
  const inner = css.slice(index + 4, at)
  const name = inner.split(',')[0].trim()
  const hasFallback = inner.includes(',')
  referenced.add(name)
  if (name.startsWith('--kb-')) {
    if (!defined.has(name) && !INLINE_STYLE_VARS.has(name)) problems.push(`undefined local var ${name}`)
  } else if (/^--(dsw|ds|dsh)-/.test(name)) {
    if (FRAME_PROVIDED_VARS.has(name)) {
      if (!hasFallback) problems.push(`frame var without fallback: ${name}`)
    } else if (declared.size === 0) notes.push('token sheets not found; skipped existence checks')
    else if (!declared.has(name) && !hasFallback) problems.push(`unknown token without fallback: ${name}`)
    else if (!declared.has(name)) problems.push(`unknown token (has fallback): ${name}`)
  } else if (name.startsWith('--')) {
    problems.push(`foreign namespace ${name}`)
  }
  index = at + 1
}

// 3. uncapped radii must pair with corner-shape: round
for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = block[1].trim()
  const body = block[2]
  const pill = /border-radius:\s*(?:50%|100%|999px)/.test(body)
  if (pill && !/corner-shape:\s*round/.test(body)) problems.push(`uncapped radius without corner-shape: round in ${selector}`)
}

// 4. every class the JSX asks for must exist in the sheet
const jsx = source.slice(0, start) + source.slice(end)
// Only className values count: route paths, the style element id and inline
// custom properties share the kb- prefix without being classes.
const usedClasses = new Set()
for (const match of jsx.matchAll(/className:\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)) {
  for (const name of match[1].matchAll(/kb-[a-z0-9]+(?:[-_][a-z0-9]+)*/g)) usedClasses.add(name[0])
}
const declaredClasses = new Set([...css.matchAll(/\.(kb-[a-z0-9]+(?:[-_][a-z0-9]+)*)/g)].map((m) => m[1]))
const unstyled = [...usedClasses].filter((name) => !declaredClasses.has(name)).sort()
for (const name of unstyled) problems.push(`class used in JSX but never styled: ${name}`)
const unused = [...declaredClasses].filter((name) => !usedClasses.has(name)).sort()

// 5. shape
let open = 0
let close = 0
for (const ch of css) {
  if (ch === '{') open++
  else if (ch === '}') close++
}
if (open !== close) problems.push(`unbalanced braces: ${open} open vs ${close} close`)
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
for (const line of stripped.split('\n').map((l) => l.trim())) {
  // A line ending in ':' opens a multi-line value (stacked gradients).
  if (line !== '' && !/[;{},:]$/.test(line) && !line.startsWith('@')) {
    problems.push(`unterminated declaration: ${line.slice(0, 70)}`)
  }
}

console.log(`file: ${clientFile}`)
console.log(`css bytes: ${css.length} · rules: ${open}`)
console.log(`token sheets: ${declared.size ? `${declared.size} tokens from ${tokenDir}` : 'NOT FOUND'}`)
console.log(`local --kb-* defined: ${defined.size} · referenced vars: ${referenced.size}`)
console.log(`dsw tokens used: ${[...referenced].filter((n) => n.startsWith('--dsw-')).length}`)
console.log(`classes styled: ${declaredClasses.size} · used in JSX: ${usedClasses.size}`)
if (unused.length > 0) console.log(`note: styled but unused: ${unused.join(', ')}`)
for (const note of new Set(notes)) console.log(`note: ${note}`)
console.log(`problems: ${problems.length ? [...new Set(problems)].join(' | ') : 'none'}`)
process.exit(problems.length > 0 ? 1 : 0)
