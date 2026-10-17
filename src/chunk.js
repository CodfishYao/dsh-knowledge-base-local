/**
 * Markdown-aware chunking with character offsets and 1-based line numbers,
 * so every search hit can cite an exact location in the canonical .md file.
 */
import { normalizeText } from './util.js'

const HEADING = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/
const SENTENCE_BOUNDARY = /[。！？!?；;]+[”’"'）)\]】]*|\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/g

function lineStartsOf(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function lineOf(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Split a long paragraph at sentence boundaries, then hard-split what is left. */
function splitOversized(text, start, end, heading, max) {
  const pieces = []
  let pieceStart = start
  SENTENCE_BOUNDARY.lastIndex = 0
  const slice = text.slice(start, end)
  let match
  while ((match = SENTENCE_BOUNDARY.exec(slice)) !== null) {
    const boundary = start + match.index + match[0].length
    if (boundary - pieceStart >= max) {
      pieces.push({ start: pieceStart, end: boundary, heading })
      pieceStart = boundary
    }
  }
  if (pieceStart < end) pieces.push({ start: pieceStart, end, heading })
  const out = []
  for (const piece of pieces) {
    let at = piece.start
    while (piece.end - at > max) {
      let cut = at + max
      const window = text.slice(at, cut)
      const lastBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '), window.lastIndexOf('，'), window.lastIndexOf(','))
      if (lastBreak > max * 0.4) cut = at + lastBreak + 1
      out.push({ start: at, end: cut, heading: piece.heading })
      at = cut
    }
    if (piece.end - at > 0) out.push({ start: at, end: piece.end, heading: piece.heading })
  }
  return out
}

/**
 * @param {string} input
 * @param {{chunkSize?: number, chunkOverlap?: number}} options
 * @returns {Array<{i:number, heading:string, start:number, end:number, lineStart:number, lineEnd:number, text:string, vectorText:string}>}
 */
export function splitChunks(input, options = {}) {
  const size = Math.max(200, Number(options.chunkSize) || 1200)
  const overlap = Math.min(Math.max(0, Number(options.chunkOverlap) || 0), Math.floor(size / 2))
  const text = normalizeText(input)
  if (text.trim() === '') return []
  const starts = lineStartsOf(text)

  // 1) paragraph segments, tracking the Markdown heading path
  const segments = []
  const stack = []
  let bufStart = 0
  let cursor = 0
  let buffer = ''
  const flush = (endOffset) => {
    const raw = buffer
    if (raw.trim() !== '') {
      const lead = raw.length - raw.trimStart().length
      const trail = raw.length - raw.trimEnd().length
      const s = bufStart + lead
      const e = endOffset - trail
      if (e > s) segments.push({ start: s, end: e, heading: stack.join(' > ') })
    }
    buffer = ''
  }

  while (cursor <= text.length) {
    const lineEnd = text.indexOf('\n', cursor)
    const end = lineEnd === -1 ? text.length : lineEnd
    const line = text.slice(cursor, end)
    const headingMatch = HEADING.exec(line)
    if (headingMatch) {
      flush(cursor)
      const level = headingMatch[1].length
      while (stack.length >= level) stack.pop()
      stack.push(headingMatch[2].trim())
      bufStart = cursor
      buffer = line
    } else if (line.trim() === '') {
      flush(cursor)
      bufStart = end + 1
    } else {
      if (buffer === '') bufStart = cursor
      buffer += (buffer === '' ? '' : '\n') + line
    }
    if (lineEnd === -1) break
    cursor = lineEnd + 1
  }
  flush(text.length)

  // 2) split oversized segments
  const pieces = []
  for (const segment of segments) {
    if (segment.end - segment.start <= size) pieces.push(segment)
    else pieces.push(...splitOversized(text, segment.start, segment.end, segment.heading, size))
  }

  // 3) greedily pack pieces, carrying a small overlap into the next chunk
  const chunks = []
  let current = null
  const flushCurrent = () => {
    if (!current || current.end <= current.start) return
    const body = text.slice(current.start, current.end).trim()
    if (body === '') return
    const heading = current.heading || ''
    chunks.push({
      i: chunks.length,
      heading,
      start: current.start,
      end: current.end,
      lineStart: lineOf(starts, current.start),
      lineEnd: lineOf(starts, Math.max(current.start, current.end - 1)),
      text: body,
      vectorText: heading ? `${heading}\n${body}` : body,
    })
  }

  for (const piece of pieces) {
    if (!current) {
      current = { start: piece.start, end: piece.end, heading: piece.heading, pieces: [piece] }
      continue
    }
    if (piece.end - current.start <= size) {
      current.end = piece.end
      current.pieces.push(piece)
      if (!current.heading) current.heading = piece.heading
      continue
    }
    flushCurrent()
    let keep = []
    let keptLength = 0
    for (let k = current.pieces.length - 1; k >= 0; k--) {
      const candidate = current.pieces[k]
      const length = candidate.end - candidate.start
      if (keptLength + length > overlap) break
      keep.unshift(candidate)
      keptLength += length
    }
    if (keptLength + (piece.end - piece.start) > size * 1.5) keep = []
    const nextPieces = keep.length > 0 ? [...keep, piece] : [piece]
    current = {
      start: nextPieces[0].start,
      end: piece.end,
      heading: nextPieces[0].heading,
      pieces: nextPieces,
    }
  }
  flushCurrent()

  return chunks
}
