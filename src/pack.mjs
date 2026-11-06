import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { htmlText, scriptJson } from './project.mjs'

const runtime = await readFile(new URL('./board-runtime.js', import.meta.url), 'utf8')
const previewPolicy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'"

async function embedAssets(project, html) {
  const files = new Map()
  // Match literal asset references in attributes and CSS while leaving bindings intact.
  const references = /(\b(?:src|href|poster)\s*=\s*["']|url\(\s*["']?)(?:\.\/)?assets\/([a-z\d][a-z\d._-]*)(?=["')\s])/gi
  for (const [, , filename] of html.matchAll(references)) {
    if (!files.has(filename)) files.set(filename, await project.readAsset(filename))
  }
  return html.replace(references, (_, prefix, filename) => {
    const asset = files.get(filename)
    return prefix + 'data:' + asset.type + ';base64,' + asset.bytes.toString('base64')
  })
}

export async function previewDocument(project, board) {
  const input = scriptJson({ html: await embedAssets(project, board.html), js: board.js, props: board.props })
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="' + previewPolicy + '">',
    '<title>' + htmlText(board.title) + '</title>',
    '<style>body{margin:0}#board-error{position:fixed;z-index:99999;bottom:12px;left:12px;right:12px;margin:0;padding:12px;background:#381a26;color:#ffe2ea;white-space:pre-wrap;font:14px monospace;border-radius:8px}</style>',
    '</head><body><div id="board-root"></div><pre id="board-error" role="alert" hidden></pre>',
    '<script type="application/json" id="board-input">' + input + '</script>',
    '<script>' + runtime + '</script></body></html>',
  ].join('\n')
}

const exportLoader = String.raw`
(async () => {
  const entries = JSON.parse(document.querySelector('#canvas-manifest').textContent)
  const status = document.querySelector('#status')
  const main = document.querySelector('main')
  const single = document.body.classList.contains('single')
  const groupPages = new Set(entries.map((entry) => entry.page)).size > 1
  const groups = new Map()
  try {
    for (const entry of entries) {
      const compressed = Uint8Array.from(atob(entry.data), (character) => character.charCodeAt(0))
      const text = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      const section = document.createElement('section')
      const frame = document.createElement('iframe')
      frame.title = entry.title
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.width = entry.width
      frame.height = entry.height
      frame.srcdoc = text
      if (single) {
        section.append(frame)
        main.append(section)
        const fit = () => {
          const scale = Math.min(1, document.documentElement.clientWidth / entry.width)
          section.style.width = Math.floor(entry.width * scale) + 'px'
          section.style.height = Math.ceil(entry.height * scale) + 'px'
          frame.style.transform = 'scale(' + scale + ')'
        }
        fit()
        window.addEventListener('resize', fit)
        continue
      }
      const title = document.createElement(groupPages ? 'h3' : 'h2')
      title.textContent = entry.title
      section.append(title, frame)
      if (!groupPages) {
        main.append(section)
        continue
      }
      if (!groups.has(entry.page)) {
        const group = document.createElement('div')
        const heading = document.createElement('h2')
        heading.textContent = entry.pageTitle
        group.append(heading)
        main.append(group)
        groups.set(entry.page, group)
      }
      groups.get(entry.page).append(section)
    }
    status.textContent = single ? '' : entries.length ? entries.length + ' artboard' + (entries.length === 1 ? '' : 's') : 'This canvas is empty.'
  } catch (error) {
    status.textContent = 'Could not open this canvas. ' + error.message
  }
})()
`

export async function exportDocument(project, { frame, page } = {}) {
  const canvas = await project.list()
  if (canvas.type === 'single') {
    if (page != null) throw new Error('Page exports are available in design artifacts')
    if (!canvas.boards.length) throw new Error('Add a board before exporting this artifact')
    frame ??= canvas.boards[0].filename
  }
  const single = frame != null
  const pageOnly = page != null
  if (single && pageOnly) throw new Error('Choose either a frame or a page to export')
  const pageTitles = new Map(canvas.pages.map(({ id, title }) => [id, title]))
  if (pageOnly && !pageTitles.has(page)) throw new Error('Page not found: ' + page)
  const boards = canvas.boards.filter((board) => (!single || board.filename === frame) && (!pageOnly || board.page === page))
  if (single && !boards.length) throw new Error('Board not found: ' + frame)
  const title = single ? boards[0].title : pageOnly ? pageTitles.get(page) : canvas.title
  const entries = await Promise.all(boards.map(async ({ filename, page }) => {
    const board = await project.readBoard(filename)
    const preview = await previewDocument(project, board)
    return {
      title: board.title,
      width: board.width,
      height: board.height,
      page,
      pageTitle: pageTitles.get(page),
      mime: 'text/html',
      compressed: true,
      data: gzipSync(preview).toString('base64'),
    }
  }))
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + htmlText(title) + '</title>',
    '<style>html{background:#f4f4f5;color:#25262b;font:16px system-ui,sans-serif}body{margin:0;padding:clamp(12px,3vw,32px)}h1{margin:0;font-size:23px}h2,h3{font-size:14px;margin:0 0 10px}p{color:#5c6272;margin:6px 0 24px}section{margin:0 0 24px;max-width:100%;overflow:auto}iframe{display:block;border:0;background:white;transform-origin:0 0}.single{padding:0}.single section{margin:0 auto;overflow:hidden}.single #status:empty{display:none}.single #status{margin:0 auto;text-align:center;font-size:13px}</style>',
    single
      ? '</head><body class="single"><main></main><p id="status" role="status"></p>'
      : '</head><body><header><h1>' + htmlText(title) + '</h1><p id="status" role="status">Opening canvas…</p></header><main></main>',
    '<script type="application/json" id="canvas-manifest">' + scriptJson(entries) + '</script>',
    '<script>' + exportLoader + '</script></body></html>',
  ].join('\n')
}
