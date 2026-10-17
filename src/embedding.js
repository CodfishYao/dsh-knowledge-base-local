/**
 * Three ways to produce vectors:
 *  - local: deterministic TF-IDF feature hashing, fully offline
 *  - llm:   a chat model writes a summary/keywords/questions profile, then the
 *           same local vectorizer embeds text + profile (no embedding API needed)
 *  - api:   an OpenAI-compatible /embeddings endpoint (dense vectors)
 * Any failure in llm/api mode falls back to local and records the reason.
 */
import { decodeVector, encodeVector, truncate } from './util.js'
import { cosine, hashVector, idf, termFrequency, terms } from './tokenize.js'

export function idfMap(stats) {
  return (term) => idf(stats?.df?.get?.(term) ?? stats?.df?.[term] ?? 0, stats?.total || 1)
}

export function emptyStats() {
  return { total: 0, totalTerms: 0, avgdl: 1, df: new Map() }
}

export function statsToJson(stats) {
  return {
    version: 1,
    total: stats.total,
    totalTerms: stats.totalTerms,
    avgdl: stats.avgdl,
    df: Object.fromEntries(stats.df),
  }
}

export function statsFromJson(raw) {
  const stats = emptyStats()
  if (!raw) return stats
  stats.total = Number(raw.total) || 0
  stats.totalTerms = Number(raw.totalTerms) || 0
  stats.avgdl = Number(raw.avgdl) || 1
  if (raw.df && typeof raw.df === 'object') {
    for (const [term, count] of Object.entries(raw.df)) stats.df.set(term, Number(count) || 0)
  }
  return stats
}

function signalWithTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 60000))
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
}

/** Ask the chat model for a compact semantic profile. Returns null on failure. */
export async function enrichWithLlm(ctx, { title, text }, settings, signal) {
  const llm = ctx?.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('LLM service is not available in this profile')
  }
  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {}
  const provider = settings.llm.provider || selection.provider
  const model = settings.llm.model || selection.model
  if (!provider || !model) throw new Error('no LLM provider/model configured')

  const body = truncate(text, settings.llm.maxChars)
  const prompt = [
    '你是知识库索引器。阅读文档后只输出一个 JSON 对象，不要 Markdown 代码块，不要额外解释。',
    'JSON 结构：',
    '{"summary":"不超过120字的客观摘要","keywords":["5-12个关键词"],"questions":["3-6个用户可能提出的问题"],"entities":["专有名词/产品/人名"]}',
    '用文档本身的语言写摘要与关键词。',
    '',
    `文档标题：${title}`,
    '文档正文：',
    body,
  ].join('\n')

  let output = ''
  const stream = llm.stream({
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: settings.llm.temperature,
    maxTokens: 900,
    signal: signalWithTimeout(signal, settings.llm.timeoutMs),
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') output += chunk.text
    else if (chunk.type === 'finish') {
      if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? 'LLM call failed')
      if (chunk.reason?.kind === 'aborted') throw new Error('LLM call aborted')
    }
  }
  const parsed = parseJsonLoose(output)
  if (!parsed) throw new Error('LLM returned no parseable JSON')
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.map(String).filter(Boolean).slice(0, 16) : []
  const questions = Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean).slice(0, 8) : []
  const entities = Array.isArray(parsed.entities) ? parsed.entities.map(String).filter(Boolean).slice(0, 16) : []
  return { provider, model, summary, keywords, questions, entities }
}

export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(unfenced)
  } catch {
    /* fall through */
  }
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1))
    } catch {
      /* fall through */
    }
  }
  return null
}

/** OpenAI-compatible embeddings. Returns {vectors, dim, model}. */
export async function embedWithApi(texts, settings, signal) {
  const conf = settings.embedding
  const endpoint = String(conf.endpoint ?? '').trim().replace(/\/+$/, '')
  if (endpoint === '') throw new Error('embedding.endpoint is empty')
  const model = String(conf.model ?? '').trim()
  if (model === '') throw new Error('embedding.model is empty')
  const apiKey = conf.apiKey || process.env.DSH_KB_EMBEDDING_API_KEY || ''
  const batchSize = Math.min(128, Math.max(1, Number(conf.batchSize) || 32))
  const vectors = []
  let dim = 0

  // Auto-detect DashScope native API based on endpoint or model name
  const isDashScope = /dashscope\.aliyuncs\.com/i.test(endpoint) || 
                      /text-embedding/i.test(model) ||
                      /\/api\/v1$/i.test(endpoint)
  const url = isDashScope 
    ? `${endpoint}/services/embeddings/text-embedding/text-embedding`
    : (/\/embeddings$/i.test(endpoint) ? endpoint : `${endpoint}/embeddings`)

  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize)
    let payload
    if (isDashScope) {
      // DashScope native format
      payload = {
        model,
        input: {
          texts: batch,
        },
        parameters: {
          text_type: 'document',
        },
      }
      if (Number(conf.dimensions) > 0) payload.parameters.dimension = Number(conf.dimensions)
    } else {
      // OpenAI-compatible format
      payload = { model, input: batch }
      if (Number(conf.dimensions) > 0) payload.dimensions = Number(conf.dimensions)
    }
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: signalWithTimeout(signal, conf.timeoutMs),
    })
    if (!response.ok) {
      const detail = truncate(await response.text().catch(() => ''), 300)
      throw new Error(`embeddings endpoint returned HTTP ${response.status}: ${detail}`)
    }
    const json = await response.json()

    // Parse response based on format
    let data
    if (isDashScope && json.output?.embeddings) {
      // DashScope response format
      data = json.output.embeddings
        .map((item) => ({
          embedding: item.embedding,
          index: item.text_index ?? 0,
        }))
        .sort((a, b) => a.index - b.index)
    } else if (Array.isArray(json?.data)) {
      // OpenAI response format
      data = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    } else {
      throw new Error('embeddings endpoint returned an unexpected payload')
    }

    if (!data || data.length !== batch.length) throw new Error('embeddings endpoint returned an unexpected payload')
    for (const item of data) {
      const values = item?.embedding
      if (!Array.isArray(values) || values.length === 0) throw new Error('embeddings endpoint returned an empty vector')
      if (dim === 0) dim = values.length
      if (values.length !== dim) throw new Error('embeddings endpoint returned inconsistent dimensions')
      const vec = Float32Array.from(values)
      let norm = 0
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
      norm = Math.sqrt(norm)
      if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm
      vectors.push(vec)
    }
  }
  if (dim === 0) throw new Error('embeddings endpoint returned no vectors')
  return { vectors, dim, model }
}

/**
 * Build the per-document index (chunks + vectors + metadata).
 * @returns {Promise<{mode:string, dim:number, status:string, error?:string, enrichment?:object, chunks:Array}>}
 */
export async function buildDocumentIndex({ ctx, meta, body, chunks, stats, settings, mode, signal }) {
  const wanted = mode === 'none' ? 'none' : ['local', 'llm', 'api'].includes(mode) ? mode : settings.vectorMode
  const idfOf = idfMap(stats)
  let modeUsed = wanted
  let fallbackError = ''
  let enrichment = null

  if (wanted === 'none') {
    return {
      mode: 'none',
      requestedMode: 'none',
      dim: 0,
      status: 'pending',
      error: '',
      enrichment: null,
      chunks: chunks.map((chunk) => {
        const tf = termFrequency(chunk.vectorText)
        return {
          i: chunk.i,
          heading: chunk.heading,
          start: chunk.start,
          end: chunk.end,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          text: chunk.text,
          tf: Object.fromEntries(tf),
          terms: tf.size,
          vec: null,
        }
      }),
    }
  }

  if (wanted === 'llm') {
    try {
      enrichment = await enrichWithLlm(ctx, { title: meta.title, text: body }, settings, signal)
    } catch (error) {
      fallbackError = `LLM enrichment failed: ${error instanceof Error ? error.message : String(error)}`
      modeUsed = 'local'
    }
  }

  const enrichedSuffix =
    enrichment && (enrichment.summary || enrichment.keywords.length > 0)
      ? [
          enrichment.summary ? `\n\n[摘要] ${enrichment.summary}` : '',
          enrichment.keywords.length > 0 ? `\n[关键词] ${enrichment.keywords.join('，')}` : '',
          enrichment.questions.length > 0 ? `\n[相关问题] ${enrichment.questions.join('；')}` : '',
          enrichment.entities.length > 0 ? `\n[实体] ${enrichment.entities.join('，')}` : '',
        ].join('')
      : ''

  const vectorTexts = chunks.map((chunk) => `${chunk.vectorText}${enrichedSuffix}`)
  let vectors = null
  let dim = settings.vectorDim

  if (wanted === 'api') {
    try {
      const result = await embedWithApi(vectorTexts, settings, signal)
      vectors = result.vectors
      dim = result.dim
      modeUsed = 'api'
    } catch (error) {
      fallbackError = `embedding API failed: ${error instanceof Error ? error.message : String(error)}`
      modeUsed = 'local'
    }
  }

  if (!vectors) {
    vectors = vectorTexts.map((text) => hashVector(terms(text), settings.vectorDim, idfOf))
    if (modeUsed === 'api') modeUsed = 'local'
  }

  const indexedChunks = chunks.map((chunk, index) => {
    const tf = termFrequency(vectorTexts[index])
    return {
      i: chunk.i,
      heading: chunk.heading,
      start: chunk.start,
      end: chunk.end,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      text: chunk.text,
      tf: Object.fromEntries(tf),
      terms: tf.size,
      vec: encodeVector(vectors[index]),
    }
  })

  const status = fallbackError ? 'fallback-local' : 'ok'
  return {
    mode: modeUsed,
    requestedMode: wanted,
    dim,
    status,
    error: fallbackError || undefined,
    enrichment,
    chunks: indexedChunks,
  }
}

export function decodeChunkVector(chunk) {
  return decodeVector(chunk.vec)
}

export function queryVectorFor(query, stats, settings) {
  const tokens = terms(query)
  return { tokens, vector: hashVector(tokens, settings.vectorDim, idfMap(stats)) }
}

export { cosine }
