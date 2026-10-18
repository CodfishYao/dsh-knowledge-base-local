/**
 * Self-check for the PDF / Office extraction path.
 *
 * Fixtures are generated here, in the OS temp directory, so the test needs no
 * sample files and never touches a real knowledge base.
 *   node test/extract.test.mjs
 */
import assert from 'node:assert/strict'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canExtract, documentKindOf, extractDocumentBuffer, extractDocumentText } from '../src/extract_binary.js'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/** Minimal ZIP writer (stored + deflate) good enough for OOXML fixtures. */
function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.data, 'utf8')
    const crc = crc32(raw)
    const deflated = entry.stored ? null : deflateRawSync(raw, { level: 6 })
    const payload = deflated ?? raw
    const method = deflated ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, payload)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt16LE(0, 12)
    record.writeUInt16LE(0, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(payload.length, 20)
    record.writeUInt32LE(raw.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += local.length + name.length + payload.length
  }
  const body = Buffer.concat(chunks)
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, end])
}

function docxFixture() {
  const document = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>渠道手册</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>第一段正文：静态加密使用 AES-256-GCM。</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>条目一</w:t></w:r></w:p>',
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>列A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>列B</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值&copy;2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    '</w:body></w:document>',
  ].join('')
  return buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>渠道手册（属性）</dc:title></cp:coreProperties>' },
    { name: 'word/document.xml', data: document },
  ])
}

function xlsxFixture() {
  return buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="预算" sheetId="1" r:id="rIdS1"/><sheet name="空表" sheetId="2" r:id="rIdS2"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rIdS2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>项目</t></si><si><t>金额</t></si><si><t>服务器<delimiter/>扩容</t></si><si><r><t>富</t></r><r><rPr><b/></rPr><t>文本</t></r></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>备注A<brk/>备注B</t></is></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><f>SUM(B1:B1)</f><v>12800</v></c><c r="C2" t="s"><v>3</v></c></row></sheetData></worksheet>' },
    { name: 'xl/worksheets/sheet2.xml', data: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>' },
  ])
}

function pptxFixture() {
  return buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>' },
    { name: 'ppt/presentation.xml', data: '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>' },
    { name: 'ppt/slides/slide1.xml', data: '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:ph type="ctrTitle"/><p:txBody><a:p><a:r><a:t>季度回顾</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>要点：加密已上线</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/slides/slide10.xml', data: '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:ph type="title"/><p:txBody><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
  ])
}

/** One simple-font page (WinAnsi) + one CID page with a ToUnicode CMap. */
function pdfFixture() {
  const objects = []
  const cid = '你好知识库'
  const hex = [...cid].map((ch) => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  const bfchar = [...cid].map((ch) => `<${ch.charCodeAt(0).toString(16).padStart(4, '0')}> <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n')
  const content1 = 'BT\n/F1 12 Tf\n72 720 Td\n(Hello KB) Tj\n1 0 0 1 72 700 Tm\n[(Static) -2000 (Encryption)] TJ\nT*\n(second line here) Tj\nET\n'
  const content2 = `BT\n/F2 12 Tf\n72 680 Td\n<${hex}> Tj\nET\n`
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /KB-Fixed /CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${[...cid].length} beginbfchar\n${bfchar}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`

  // Fixed object numbers: every reference below points at a real object.
  //  1 Catalog  2 Pages  3 Page1  4 Page2  5 Font1(simple)  6 Contents1
  //  7 Font2(Type0)  8 Contents2  9 CIDFont  10 ToUnicode  11 FontDescriptor  12 Info
  objects.push(
    '<< /Type /Catalog /Pages 2 0 R /Info 12 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F2 7 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content1.length} >>\nstream\n${content1}endstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong /Encoding /Identity-H /DescendantFonts [9 0 R] /ToUnicode 10 0 R >>',
    `<< /Length ${content2.length} >>\nstream\n${content2}endstream`,
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /STSong /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> /FontDescriptor 11 0 R /DW 1000 >>',
    `<< /Length ${cmap.length} >>\nstream\n${cmap}endstream`,
    '<< /Type /FontDescriptor /FontName /STSong /Flags 4 /ItalicAngle 0 >>',
    '<< /Title (测试 PDF 标题) /Producer (fixture) >>',
  )

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefAt = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'binary')
}

/**
 * PDF 1.7 using a cross-reference STREAM and an object stream (ObjStm) — the
 * structure IEEE papers ship with. The catalog/pages/page dicts live compressed
 * inside the ObjStm; only the content stream, font, ObjStm and xref stream are
 * plain objects. Regression guard: an earlier parser read the ObjStm index from
 * /First (and without skipping the spaces between pairs) and silently lost all
 * compressed objects, so every page rendered empty.
 */
function objStmPdfFixture() {
  const content = 'BT\n/F1 12 Tf\n72 720 Td\n(OBJSTM PAGE TEXT) Tj\nET\n'
  const obj1 = `<< /Length ${content.length} >>\nstream\n${content}endstream`
  const obj2 = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  // Objects 3, 5 and 7 live inside the object stream (number 6).
  const bodies = [
    '<< /Type /Catalog /Pages 5 0 R >>',
    '<< /Type /Pages /Kids [7 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 5 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 2 0 R >> >> /Contents 1 0 R >>',
  ]
  let index = ''
  let offset = 0
  for (const [pos, body] of bodies.entries()) {
    const num = [3, 5, 7][pos]
    index += `${num} ${offset} `
    offset += body.length
  }
  const stmData = Buffer.from(index + bodies.join(''), 'binary')
  const stmCompressed = deflateSync(stmData)
  const obj6 = `<< /Type /ObjStm /N 3 /First ${index.length} /Length ${stmCompressed.length} /Filter /FlateDecode >>\nstream\n${stmCompressed.toString('binary')}endstream`

  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
  const off = {}
  off[1] = out.length
  out += `1 0 obj\n${obj1}\nendobj\n`
  off[2] = out.length
  out += `2 0 obj\n${obj2}\nendobj\n`
  off[6] = out.length
  out += `6 0 obj\n${obj6}\nendobj\n`

  // Cross-reference stream: 9 rows of W=[1 2 1] (type, field2, field3).
  const row = (type, f2, f3) => Buffer.from([type, (f2 >> 8) & 0xff, f2 & 0xff, f3])
  const rows = Buffer.concat([
    row(0, 0, 255), // 0 free
    row(1, off[1], 0), // 1 content stream
    row(1, off[2], 0), // 2 font
    row(2, 6, 0), // 3 catalog  -> ObjStm 6, index 0
    row(0, 0, 255), // 4 unused/free
    row(2, 6, 1), // 5 pages    -> ObjStm 6, index 1
    row(1, off[6], 0), // 6 the object stream itself
    row(2, 6, 2), // 7 page     -> ObjStm 6, index 2
    // 8 = this xref stream; its own offset is patched below
  ])
  off[8] = out.length
  const xrefDict = `<< /Type /XRef /Size 9 /W [1 2 1] /Root 3 0 R /Filter /FlateDecode /Length`
  const xrefCompressed = deflateSync(Buffer.concat([rows, row(1, off[8], 0)]))
  out += `8 0 obj\n${xrefDict} ${xrefCompressed.length} >>\nstream\n${xrefCompressed.toString('binary')}endstream\n`
  out += `startxref\n${off[8]}\n%%EOF\n`
  return Buffer.from(out, 'binary')
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'kb-extract-'))
  let passed = 0
  const ok = (name) => {
    passed++
    console.log(`ok   - ${name}`)
  }

  try {
    // ---- kind detection ----
    assert.equal(documentKindOf('a.PDF'), 'pdf')
    assert.equal(documentKindOf('a.docx'), 'docx')
    assert.equal(documentKindOf('a.xlsx'), 'xlsx')
    assert.equal(documentKindOf('a.pptx'), 'pptx')
    assert.equal(documentKindOf('a.doc'), 'ole')
    assert.equal(documentKindOf('a.txt'), '')
    assert.equal(canExtract('notes.docx'), true)
    assert.equal(canExtract('notes.txt'), false)
    ok('documentKindOf / canExtract')

    // ---- docx ----
    const docxPath = join(dir, 'channel.docx')
    await writeFile(docxPath, docxFixture())
    const docx = await extractDocumentText(docxPath)
    assert.equal(docx.ok, true, docx.error)
    assert.equal(docx.kind, 'docx')
    assert.match(docx.text, /渠道手册/)
    assert.match(docx.text, /AES-256-GCM/)
    assert.match(docx.text, /#/)
    assert.match(docx.text, /条目一/)
    assert.match(docx.text, /\| 列A/)
    assert.match(docx.text, /值©2|值&copy;2|值/)
    assert.ok(docx.title.includes('渠道手册'), `title=${docx.title}`)
    ok(`docx 段落/标题/列表/表格（${docx.text.split('\n').length} 行）`)

    // ---- xlsx ----
    const xlsxPath = join(dir, 'budget.xlsx')
    await writeFile(xlsxPath, xlsxFixture())
    const xlsx = await extractDocumentText(xlsxPath)
    assert.equal(xlsx.ok, true, xlsx.error)
    assert.equal(xlsx.kind, 'xlsx')
    assert.match(xlsx.text, /预算/)
    assert.match(xlsx.text, /服务器扩容/, '共享字符串里嵌套标记的多个文本段必须全部保留')
    assert.match(xlsx.text, /12800/)
    assert.match(xlsx.text, /备注A备注B/, 'inlineStr 的多段文本必须拼接')
    assert.match(xlsx.text, /富文本/, 'rich <si> 的多个 <r> 必须拼接')
    assert.ok(!/SUM\(B1:B1\)|<f>/.test(xlsx.text), '公式文本不应混入单元格值')
    assert.ok(!/空表[\s\S]*\|/.test(xlsx.text.split('空表')[1] ?? ''), '空 sheet 不应输出表格噪音')
    ok('xlsx 共享字符串/表格/多 sheet')

    // ---- pptx ----
    const pptxPath = join(dir, 'review.pptx')
    await writeFile(pptxPath, pptxFixture())
    const pptx = await extractDocumentText(pptxPath)
    assert.equal(pptx.ok, true, pptx.error)
    assert.match(pptx.text, /季度回顾/)
    assert.match(pptx.text, /加密已上线/)
    assert.match(pptx.text, /第十页/)
    const order = pptx.text.indexOf('季度回顾')
    const tenth = pptx.text.indexOf('第十页')
    assert.ok(order >= 0 && tenth > order, '幻灯片必须按数字顺序（slide1 在 slide10 之前）')
    ok('pptx 标题/正文/幻灯片数字排序')

    // ---- pdf ----
    const pdfPath = join(dir, 'sample.pdf')
    await writeFile(pdfPath, pdfFixture())
    const pdf = await extractDocumentText(pdfPath)
    assert.equal(pdf.ok, true, pdf.error)
    assert.equal(pdf.kind, 'pdf')
    assert.match(pdf.text, /Hello KB/)
    assert.match(pdf.text, /Static\s*Encryption/, 'TJ 的大负字距应拆成两个词')
    assert.match(pdf.text, /second line here/)
    assert.match(pdf.text, /你好知识库/, 'Identity-H + ToUnicode 的中文应可抽取')
    assert.equal(pdf.pages, 2, `pages=${pdf.pages}`)
    assert.ok(pdf.title.includes('PDF') || pdf.title.includes('测试'), `title=${pdf.title}`)
    ok(`pdf 简单字体 + CID/ToUnicode（pages=${pdf.pages}, warnings=${pdf.warnings.length}）`)

    // ---- pdf 1.7 with cross-reference stream + ObjStm compressed objects ----
    const stmPath = join(dir, 'objstm.pdf')
    await writeFile(stmPath, objStmPdfFixture())
    const stm = await extractDocumentText(stmPath)
    assert.equal(stm.ok, true, stm.error)
    assert.equal(stm.pages, 1, `pages=${stm.pages}`)
    assert.match(stm.text, /OBJSTM PAGE TEXT/, '压缩在 ObjStm 里的页面必须能渲染')
    assert.equal(stm.warnings.filter((w) => w.includes('未能解析')).length, 0, JSON.stringify(stm.warnings))
    ok('pdf 交叉引用流 + ObjStm 压缩对象（目录/页面树都能解析）')

    // ---- error branches ----
    const oleBuf = Buffer.alloc(512)
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(oleBuf, 0)
    const ole = extractDocumentBuffer(oleBuf, 'legacy.doc')
    assert.equal(ole.ok, false)
    assert.match(ole.error, /旧式|docx/)
    ok('旧式 OLE 返回明确错误')

    const zip = buildZip([{ name: 'readme.txt', data: 'hello' }])
    const plain = extractDocumentBuffer(zip, 'archive.zip')
    assert.equal(plain.ok, false)
    assert.match(plain.error, /Office|zip/)
    ok('普通 zip 不误判为 Office')

    const junk = extractDocumentBuffer(Buffer.from('just some plain text'), 'note.txt')
    assert.equal(junk.ok, false)
    assert.equal(junk.unsupported, true)
    ok('非文档字节 → unsupported')

    const missing = await extractDocumentText(join(dir, 'nope.pdf'))
    assert.equal(missing.ok, false)
    assert.match(missing.error, /不存在/)
    ok('缺失文件返回错误而不是抛出')

    const huge = await extractDocumentText(pdfPath, { maxBytes: 8 })
    assert.equal(huge.ok, false)
    assert.match(huge.error, /过大/)
    ok('超过 maxBytes 时拒绝')

    console.log(`\nextract: ${passed} passed, 0 failed`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function fixtures() {
  return { docx: docxFixture, xlsx: xlsxFixture, pptx: pptxFixture, pdf: pdfFixture, buildZip }
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exit(1)
  })
}
