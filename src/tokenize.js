/**
 * Dependency-free tokenizer + signed feature-hashing vectorizer.
 *
 * The "local" vector mode is deliberately not sold as a neural embedding: it is
 * a deterministic TF-IDF hashed vector over Latin words, numbers and CJK
 * character bigrams. It is fast, offline, multilingual enough for Chinese and
 * English notes, and gives real cosine similarity. The "llm" mode enriches the
 * text first, then uses this same vectorizer.
 */
import { fnv1a } from './util.js'

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u
const LATIN_CHAR = /[a-z0-9_+.#]/i

const EN_STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she', 'so', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was',
  'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'you', 'your',
])

const ZH_STOP = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '也', '就', '都', '而', '被',
  '把', '对', '为', '以', '于', '中', '上', '下', '个', '这', '那', '有', '我',
  '你', '他', '它', '们', '之', '其', '并', '但', '很', '还', '要', '会', '能',
  '可', '吗', '呢', '啊', '吧', '着', '过', '得', '地', '嘛', '呀',
])

/**
 * Split text into terms. CJK runs produce overlapping bigrams (知识库 → 知识, 识库);
 * a single-character run is kept as itself. Latin runs are lowercased and
 * stopwords removed.
 * @param {string} text
 * @returns {string[]}
 */
export function terms(text) {
  const out = []
  const source = String(text ?? '').normalize('NFKC').toLowerCase()
  const chars = [...source]
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    if (CJK_CHAR.test(ch)) {
      let j = i
      while (j < chars.length && CJK_CHAR.test(chars[j])) j++
      const run = chars.slice(i, j)
      if (run.length === 1) {
        if (!ZH_STOP.has(run[0])) out.push(run[0])
      } else {
        for (let k = 0; k + 1 < run.length; k++) {
          const a = run[k]
          const b = run[k + 1]
          if (ZH_STOP.has(a) && ZH_STOP.has(b)) continue
          out.push(a + b)
        }
      }
      i = j
      continue
    }
    if (LATIN_CHAR.test(ch)) {
      let j = i
      while (j < chars.length && LATIN_CHAR.test(chars[j])) j++
      const word = chars.slice(i, j).join('').replace(/^[.#+]+|[.#+]+$/g, '')
      if (word.length >= 2 || /^\d$/.test(word)) {
        if (!EN_STOP.has(word)) out.push(word)
      }
      i = j
      continue
    }
    i++
  }
  return out
}

/** @returns {Map<string, number>} term → frequency */
export function termFrequency(text) {
  const map = new Map()
  for (const term of terms(text)) {
    map.set(term, (map.get(term) ?? 0) + 1)
  }
  return map
}

export function idf(df, total) {
  return Math.log((total + 1) / ((df ?? 0) + 0.5)) + 1
}

/**
 * Signed hashing vector with sublinear TF and IDF weights, L2-normalized.
 * @param {string[]} tokens
 * @param {number} dim
 * @param {(term: string) => number} idfOf
 * @returns {Float32Array}
 */
export function hashVector(tokens, dim, idfOf) {
  const vec = new Float32Array(dim)
  const tf = new Map()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
  for (const [token, count] of tf) {
    const h = fnv1a(token)
    const index = h % dim
    const sign = (h & 0x80000000) !== 0 ? -1 : 1
    vec[index] += sign * (1 + Math.log(count)) * idfOf(token)
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm
  }
  return vec
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** BM25 over a term-frequency map. `stats` = {df, avgdl, total, dl}. */
export function bm25(termFreqMap, queryTerms, stats, { k1 = 1.2, b = 0.75 } = {}) {
  let score = 0
  const dl = stats.dl || 1
  for (const term of queryTerms) {
    const tf = termFreqMap.get(term)
    if (!tf) continue
    const df = stats.df.get(term) ?? 0
    const weight = idf(df, stats.total)
    score += (weight * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / (stats.avgdl || 1)))
  }
  return score
}

export function tokenizeQuery(query) {
  return terms(query)
}
