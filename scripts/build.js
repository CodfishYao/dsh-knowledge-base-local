#!/usr/bin/env node
/**
 * Build script: copy source files to lib/ for npm publishing.
 * This is optional — the package works fine shipping source directly.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const lib = join(root, 'lib')

async function build() {
  console.log('Cleaning lib/...')
  await rm(lib, { recursive: true, force: true })
  await mkdir(lib, { recursive: true })

  console.log('Copying files...')
  const files = [
    'index.js',
    'client.js',
    'kb.mjs',
    'mcp-stdio.mjs',
    'cordis.patch.yml',
    'icon.svg',
    'LICENSE',
    'README.md',
    'README.zh.md',
    'CONTRIBUTING.md',
    'CONTRIBUTING.zh.md',
    'CHANGELOG.md',
    'CHANGELOG.zh.md',
    'SECURITY.md',
    'SECURITY.zh.md',
    'src/',
    'locale/',
  ]

  for (const file of files) {
    const src = join(root, file)
    const dest = join(lib, file)
    await cp(src, dest, { recursive: true })
    console.log(`  ${file}`)
  }

  console.log('Build complete: lib/')
}

build().catch((error) => {
  console.error('Build failed:', error)
  process.exit(1)
})
