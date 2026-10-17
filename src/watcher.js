/**
 * Watches `<root>/inbox` and turns dropped text files into documents.
 * New files are added; edited files update the same document (history kept).
 * The watcher is strictly best-effort: a failure disables it and never throws
 * into the plugin lifecycle.
 */
import { watch } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { decodeBuffer, guessTitle, isProbablyTextBuffer } from './extract.js'
import { canExtract } from './extract_binary.js'
import { readJson, writeJsonAtomic } from './util.js'

const STATE_FILE = 'inbox-state.json'

export function startWatcher({ store, settings }) {
  if (!store.configured || !settings.watch?.enabled) return () => {}
  const dir = join(store.root, settings.watch?.dir || 'inbox')
  let watcher = null
  let timer = null
  let busy = false
  let stopped = false
  const statePath = join(store.root, 'index', STATE_FILE)
  const state = { files: {} }

  const log = (message) => {
    try {
      console.error(`[dsh-knowledge-base] inbox: ${message}`)
    } catch {
      /* ignore */
    }
  }

  const loadState = async () => {
    const saved = await readJson(statePath, null)
    if (saved && typeof saved.files === 'object' && saved.files) {
      state.files = saved.files
    }
  }

  const importFile = async (full, name) => {
    const info = await stat(full).catch(() => null)
    if (!info || !info.isFile() || info.size === 0) return
    const rel = name
    const previous = state.files[rel]
    if (previous && previous.mtimeMs === info.mtimeMs && previous.size === info.size) return
    // PDF/Office files go through the document extractor; everything else has
    // to look like text before we bother with it.
    const isDocument = canExtract(name)
    let text = ''
    let docTitle = ''
    if (isDocument) {
      const extracted = await store.extractDocumentBody(full, basename(name))
      if (!extracted?.body) {
        log(`skipped ${rel}: ${extracted?.error ?? '未抽取到正文'}`)
        state.files[rel] = { mtimeMs: info.mtimeMs, size: info.size, skipped: true }
        await writeJsonAtomic(statePath, state)
        return
      }
      text = extracted.body
      docTitle = extracted.title
    } else {
      const buffer = await readFile(full)
      if (!isProbablyTextBuffer(buffer)) return
      text = decodeBuffer(buffer)
      if (text.trim() === '') return
    }
    try {
      if (previous?.id) {
        await store.update({ id: previous.id, text })
        state.files[rel] = { mtimeMs: info.mtimeMs, size: info.size, id: previous.id }
        log(`updated ${rel} → ${previous.id}`)
      } else {
        const result = await store.add({
          text,
          title: docTitle || guessTitle(text, basename(name)),
          collection: settings.watch.collection || 'inbox',
          tags: ['inbox'],
          source: { type: 'inbox', path: full, rel },
          filePath: isDocument && settings.import?.copyFiles !== false ? full : undefined,
        })
        state.files[rel] = { mtimeMs: info.mtimeMs, size: info.size, id: result.id }
        log(`${result.deduped ? 'already existed' : 'added'} ${rel} → ${result.id}`)
      }
      await writeJsonAtomic(statePath, state)
    } catch (error) {
      log(`failed ${rel}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const scan = async () => {
    if (busy || stopped) return
    busy = true
    try {
      await loadState()
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (stopped) break
        if (!entry.isFile() || entry.name.startsWith('.')) continue
        await importFile(join(dir, entry.name), entry.name)
      }
    } catch (error) {
      log(`scan failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busy = false
    }
  }

  const schedule = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void scan()
    }, Math.max(200, Number(settings.watch?.debounceMs) || 1500))
  }

  const start = async () => {
    try {
      await mkdir(dir, { recursive: true })
      await loadState()
      watcher = watch(dir, { recursive: true }, () => schedule())
      watcher.on('error', (error) => {
        log(`watcher error: ${error instanceof Error ? error.message : String(error)}`)
        stop()
      })
      void scan()
      log(`watching ${dir}`)
    } catch (error) {
      log(`cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function stop() {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      watcher?.close()
    } catch {
      /* ignore */
    }
    watcher = null
  }

  void start()
  return stop
}
