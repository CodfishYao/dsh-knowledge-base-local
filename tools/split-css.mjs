#!/usr/bin/env node
/**
 * Dev tool: pull every inlined CSS string out of a compiled dsh client bundle
 * and write one rule per line so the read tool can show it in full.
 *
 *   node tools/split-css.mjs <bundle.js> <outDir>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

function unescapeCss(raw) {
  return raw
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
}

function pretty(css) {
  let out = ''
  let depth = 0
  for (let i = 0; i < css.length; i++) {
    const char = css[i]
    if (char === '{') {
      out += ' {\n  '
      depth++
      continue
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1)
      out = out.replace(/\s+$/, '')
      out += '\n}\n'
      continue
    }
    if (char === ';') {
      out += ';\n  '
      continue
    }
    if (char === '\n') continue
    out += char
  }
  return out
    .split('\n')
    .map((line) => line.replace(/^ {2,}/, (m) => '  '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function main() {
  const [source, outDir] = process.argv.slice(2)
  if (!source || !outDir) {
    console.error('usage: node tools/split-css.mjs <bundle.js> <outDir>')
    process.exit(1)
  }
  const text = await readFile(source, 'utf8')
  const pattern = /const css(?:\$(\d+))? = "((?:[^"\\]|\\.)*)";/g
  let match
  let index = 0
  while ((match = pattern.exec(text)) !== null) {
    const raw = unescapeCss(match[2])
    const tagMatch = /const tagId(?:\$(\d+))? = "([^"]+)"/g
    tagMatch.lastIndex = pattern.lastIndex
    const tag = tagMatch.exec(text.slice(pattern.lastIndex, pattern.lastIndex + 400))
    const name = (tag?.[2] ?? `css-${match[1] ?? index}`).split('/').pop().replace(/\.module\.css$/, '.css')
    index++
    const file = join(outDir, `${basename(source).replace(/\.js$/, '')}.${index}-${name}`)
    await mkdir(outDir, { recursive: true })
    await writeFile(file, `${pretty(raw)}\n`, 'utf8')
    console.log(`wrote ${file}`)
  }
  if (index === 0) console.log('no css strings found')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
