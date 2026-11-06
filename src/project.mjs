import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const assetTypes = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
])

const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const boardPattern = /^[a-z\d][a-z\d _-]{0,110}\.dc\.html$/i
const assetPattern = /^[a-z\d][a-z\d._-]{0,119}$/i
const defaultPage = { id: 'main', title: 'Main' }

function pagesFrom(index) {
  const pages = Array.isArray(index.pages) ? index.pages : []
  return pages.some(({ id }) => id === defaultPage.id) ? pages : [defaultPage, ...pages]
}

function notesFrom(index) {
  return Array.isArray(index.comments) ? index.comments : []
}

export function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function htmlText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function decodeHtml(value) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" }
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (match) => entities[match])
}

export function scriptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function boardName(filename) {
  if (typeof filename !== 'string' || !boardPattern.test(filename) || reserved.test(filename)) {
    throw new Error('Use a board filename such as Dashboard.dc.html')
  }
  return filename
}

function assetName(filename) {
  if (typeof filename !== 'string' || !assetPattern.test(filename) || reserved.test(filename)) {
    throw new Error('Use a simple asset filename with a supported extension')
  }
  if (!assetTypes.has(path.extname(filename).toLowerCase())) throw new Error('Unsupported asset file type')
  return filename
}

/** Return the status of a regular file, or null when it is absent. */
export async function fileStatus(filename) {
  const status = await lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (status && !status.isFile()) throw new Error('Expected a regular file at ' + filename)
  return status
}

/** Ensure a real child directory exists without following links. */
export async function directory(parent, name) {
  const target = path.join(parent, name)
  await mkdir(target).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  if (!(await lstat(target)).isDirectory()) throw new Error('Expected a regular directory at ' + target)
  return target
}

/** Publish complete file contents with a rename within the same directory. */
export async function atomicWrite(filename, content) {
  const temporary = path.join(path.dirname(filename), '.' + randomUUID() + '.tmp')
  await writeFile(temporary, content, { flag: 'wx' })
  try {
    await rename(temporary, filename)
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** Run an update under a sibling lock shared by CLI, MCP, and HTTP processes. */
export async function locked(filename, update) {
  const lockFile = filename + '.lock'
  for (let attempt = 0; ; attempt += 1) {
    const lock = await open(lockFile, 'wx').catch((error) => {
      if (error.code === 'EEXIST' && attempt < 80) return null
      throw error
    })
    if (!lock) {
      await delay(25)
      continue
    }
    try {
      return await update()
    } finally {
      await lock.close()
      await unlink(lockFile)
    }
  }
}

function attribute(attributes, name) {
  const pattern = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27)', 'i')
  const match = pattern.exec(attributes)
  return match ? decodeHtml(match[1] ?? match[2]) : undefined
}

function dimension(value, fallback) {
  return Number.isInteger(value) && value > 0 && value <= 20000 ? value : fallback
}

function position(value) {
  return Number.isFinite(value) && Math.abs(value) <= 200000
}

function parseBoard(filename, source) {
  const template = /<x-dc(?=[\s>])([^>]*)>([\s\S]*?)<\/x-dc\s*>/i.exec(source)
  if (!template) throw new Error(filename + ' needs an <x-dc> template')
  const logic = Array.from(source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi))
    .find((match) => /(?:^|\s)data-dc-script(?=\s|=|$)/i.test(match[1]))
  const props = JSON.parse(attribute(logic?.[1] ?? '', 'data-props') ?? '{}')
  if (!record(props)) throw new Error(filename + ' has invalid data-props')
  const preview = props.$preview ?? {}
  const title = /<title(?:\s[^>]*)?>([^<]*)<\/title\s*>/i.exec(source)?.[1]
  let js = logic?.[2] ?? ''
  if (attribute(logic?.[1] ?? '', 'data-encoding') === 'json') js = JSON.parse(js)
  const x = Number(attribute(template[1], 'data-x'))
  const y = Number(attribute(template[1], 'data-y'))
  const previewRevision = createHash('sha256').update(JSON.stringify([title, template[2], js, props])).digest('hex')
  return {
    filename,
    title: title ? decodeHtml(title) : filename.slice(0, -8),
    width: dimension(preview.width, 960),
    height: dimension(preview.height, 640),
    page: attribute(template[1], 'data-page') ?? defaultPage.id,
    ...(position(x) && position(y) ? { x, y } : {}),
    html: template[2],
    js,
    props,
    previewRevision,
    revision: createHash('sha256').update(source).digest('hex'),
  }
}

function serializeBoard({ filename, title = filename.slice(0, -8), html, js = '', props = {}, page, x, y }) {
  if (typeof html !== 'string' || /<\/?x-dc(?:\s|>)/i.test(html)) {
    throw new Error('Pass the inner markup of <x-dc> as html')
  }
  if (/<script(?:\s|>)/i.test(html)) throw new Error('Put script code in the js field')
  if (typeof js !== 'string' || typeof title !== 'string' || !record(props)) {
    throw new Error('Expected text for title and js, and an object for props')
  }
  if (props.$preview !== undefined) {
    if (!record(props.$preview)) throw new Error('$preview must be an object')
    for (const key of ['width', 'height']) {
      const value = props.$preview[key]
      if (value !== undefined && !dimension(value, 0)) {
        throw new Error('$preview.' + key + ' must be an integer between 1 and 20000')
      }
    }
  }
  // JSON encoding preserves JavaScript containing literal HTML script terminators.
  const encoded = /<\/script\b/i.test(js)
  const logic = '<script type="text/x-dc" data-dc-script data-props="' + htmlText(JSON.stringify(props)) + '"'
    + (encoded ? ' data-encoding="json">' + scriptJson(js) : '>' + js) + '</script>'
  const placement = (page && page !== defaultPage.id ? ' data-page="' + htmlText(page) + '"' : '')
    + (position(x) && position(y) ? ' data-x="' + x + '" data-y="' + y + '"' : '')
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>'
    + htmlText(title) + '</title>\n</head>\n<body>\n<x-dc' + placement + '>' + html + '</x-dc>\n' + logic + '\n</body>\n</html>\n'
}

/** Open a board store and enforce the artifact's layout constraints. */
export async function openProject(location, { type = 'design', title } = {}) {
  await mkdir(location, { recursive: true })
  const root = await realpath(location)
  const indexPath = path.join(root, 'canvas.json')

  async function boardFiles() {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && boardPattern.test(entry.name) && !reserved.test(entry.name))
      .map((entry) => entry.name)
  }

  function requireDesign() {
    if (type === 'single') throw new Error('Pages and frame placement are available in design artifacts')
  }

  async function readIndex() {
    return await fileStatus(indexPath) ? JSON.parse(await readFile(indexPath, 'utf8')) : {}
  }

  async function updateIndex(update) {
    return locked(indexPath, async () => {
      const index = await readIndex()
      const result = await update(index)
      await atomicWrite(indexPath, JSON.stringify(index, null, 2) + '\n')
      return result
    })
  }

  async function placement(input, current) {
    const page = input.page ?? current?.page ?? defaultPage.id
    if (input.page !== undefined && !pagesFrom(await readIndex()).some(({ id }) => id === page)) {
      throw new Error('Page not found: ' + page)
    }
    if (input.x !== undefined || input.y !== undefined) {
      if (!position(input.x) || !position(input.y)) throw new Error('Supply finite x and y positions between -200000 and 200000')
      return { page, x: input.x, y: input.y }
    }
    return { page, x: page === current?.page ? current.x : undefined, y: page === current?.page ? current.y : undefined }
  }

  async function readBoard(filename) {
    const target = path.join(root, boardName(filename))
    if (!(await fileStatus(target))) throw new Error('Board not found: ' + filename)
    return parseBoard(filename, await readFile(target, 'utf8'))
  }

  async function updateBoard(filename, update) {
    const target = path.join(root, boardName(filename))
    return locked(target, async () => {
      const current = await fileStatus(target) ? await readBoard(filename) : null
      const next = await update(current)
      const source = serializeBoard({ ...next, filename })
      const board = parseBoard(filename, source)
      await atomicWrite(target, source)
      return board
    })
  }

  return {
    root,
    type,
    readBoard,
    async list() {
      const index = await readIndex()
      const pages = pagesFrom(index)
      const pageIds = new Set(pages.map(({ id }) => id))
      const filenames = await boardFiles()
      if (type === 'single' && filenames.length > 1) throw new Error('Single artifacts contain at most one board')
      const order = Array.isArray(index.order) ? index.order.filter((name) => filenames.includes(name)) : []
      const boards = await Promise.all([...new Set([...order, ...filenames.sort()])].map(async (filename) => {
        const { title, width, height, revision, previewRevision, page, x, y } = await readBoard(filename)
        return { filename, title, width, height, revision, previewRevision, page: pageIds.has(page) ? page : defaultPage.id, x, y }
      }))
      const nextX = new Map()
      for (const board of boards) {
        const cursor = nextX.get(board.page) ?? 0
        board.x ??= cursor
        board.y ??= 0
        nextX.set(board.page, Math.max(cursor, board.x + board.width + 64))
      }
      return { title: title ?? (typeof index.title === 'string' ? index.title : path.basename(root)), root, type, pages, boards, comments: notesFrom(index) }
    },
    async setTitle(title) {
      await updateIndex((index) => { index.title = title })
    },
    async createPage(title, id = 'page-' + randomUUID()) {
      requireDesign()
      if (!title.trim() || title.length > 100) throw new Error('Give the page a title of up to 100 characters')
      if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error('Use a lowercase page ID such as user-flows')
      return updateIndex((index) => {
        const pages = pagesFrom(index)
        if (pages.some((page) => page.id === id)) throw new Error('Page already exists: ' + id)
        const page = { id, title: title.trim() }
        index.pages = [...pages, page]
        return page
      })
    },
    placeBoard(input) {
      requireDesign()
      return updateBoard(input.filename, async (current) => {
        if (!current) throw new Error('Board not found: ' + input.filename)
        return { ...current, ...await placement(input, current) }
      })
    },
    async addComment({ filename, x, y, text }) {
      await readBoard(filename)
      if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
        throw new Error('Comment positions must be between 0 and 1')
      }
      if (!text.trim() || text.length > 3000) throw new Error('Write a comment of up to 3000 characters')
      return updateIndex((index) => {
        const comment = { id: randomUUID(), filename, x, y, text: text.trim(), createdAt: new Date().toISOString() }
        index.comments = [...notesFrom(index), comment]
        return comment
      })
    },
    async resolveComment(id) {
      return updateIndex((index) => {
        const comment = notesFrom(index).find((note) => note.id === id)
        if (!comment) throw new Error('Comment not found')
        comment.resolvedAt ??= new Date().toISOString()
        return comment
      })
    },
    writeBoard(input) {
      const write = () => updateBoard(input.filename, async (current) => {
        if (input.revision !== undefined && input.revision !== (current?.revision ?? null)) {
          throw new Error('Board changed since it was opened. Reload before saving.')
        }
        return { ...input, ...await placement(input, current) }
      })
      if (type === 'design') return write()
      return locked(path.join(root, 'single-board'), async () => {
        if (input.page !== undefined || input.x !== undefined || input.y !== undefined) requireDesign()
        const filenames = await boardFiles()
        if (filenames.some((filename) => filename !== input.filename)) {
          throw new Error('This single artifact already has a board. Edit it using its existing filename.')
        }
        return write()
      })
    },
    replaceBoard(filename, update) {
      return updateBoard(filename, (board) => {
        if (!board) throw new Error('Board not found: ' + filename)
        return update(board)
      })
    },
    async putAsset(filename, bytes) {
      const name = assetName(filename)
      const target = path.join(await directory(root, 'assets'), name)
      await locked(target, async () => {
        await fileStatus(target)
        await atomicWrite(target, bytes)
      })
      return { path: 'assets/' + name, bytes: bytes.length }
    },
    async readAsset(filename) {
      const name = assetName(filename)
      const target = path.join(await directory(root, 'assets'), name)
      if (!(await fileStatus(target))) throw new Error('Asset not found: assets/' + name)
      const bytes = await readFile(target)
      return { bytes, type: assetTypes.get(path.extname(name).toLowerCase()) }
    },
    async writeExport(filename, content) {
      if (!/^[a-z\d][a-z\d_-]{0,110}\.html$/i.test(filename) || reserved.test(filename)) {
        throw new Error('Use an export filename such as canvas.html')
      }
      const target = path.join(await directory(root, 'exports'), filename)
      await locked(target, async () => {
        await fileStatus(target)
        await atomicWrite(target, content)
      })
      return { path: target, bytes: Buffer.byteLength(content) }
    },
  }
}
