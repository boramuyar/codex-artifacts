import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { exportDocument, previewDocument } from './pack.mjs'
import { callTool, guide } from './tools.mjs'

const appPolicy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'"
const staticFiles = new Map([
  ['/app.css', ['app.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/canvas-view.js', ['canvas-view.js', 'text/javascript']],
  ['/library.js', ['library.js', 'text/javascript']],
])
const writeTools = new Map([
  ['/api/board', 'dc_write'],
  ['/api/page', 'canvas_create_page'],
  ['/api/placement', 'canvas_place_frame'],
  ['/api/comments', 'comment_add'],
  ['/api/comments/resolve', 'comment_resolve'],
])

function send(response, status, content, type, headers = {}) {
  response.writeHead(status, {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  response.end(content)
}

function json(response, status, content) {
  send(response, status, JSON.stringify(content), 'application/json')
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4_000_000) throw new Error('Request exceeds 4 MB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function sendUi(response, filename, mime = 'text/html') {
  send(response, 200, await readFile(new URL('../ui/' + filename, import.meta.url)), mime, {
    'Content-Security-Policy': appPolicy,
  })
}

/** Serve the shared library or a standalone project over the local editor URL. */
export async function startServer(scope, port, { host = '127.0.0.1', containerName } = {}) {
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Use 127.0.0.1 or 0.0.0.0 for --host')
  if (containerName !== undefined && !/^[a-z\d][a-z\d_.-]*$/i.test(containerName)) {
    throw new Error('Invalid DC_CANVAS_CONTAINER name')
  }
  const library = scope.origin ? scope : null
  function launch(origin) {
    const args = library ? ['--library', scope.root, '--origin', origin.path] : ['--project', scope.root]
    return containerName
      ? { command: 'docker', args: ['exec', '-i', containerName, 'dc-canvas', 'mcp', ...args] }
      : {
          command: process.execPath,
          args: [fileURLToPath(new URL('../bin/dc-canvas.mjs', import.meta.url)), 'mcp', ...args],
        }
  }

  const server = createServer(async (request, response) => {
    const authority = '127.0.0.1:' + server.address().port
    if (request.headers.host !== authority) {
      json(response, 403, { error: 'Use the loopback URL shown by dc-canvas serve' })
      return
    }
    const origin = 'http://' + authority
    try {
      const { pathname, searchParams } = new URL(request.url, origin)
      const { method } = request
      if (method === 'POST' && (request.headers.origin !== origin
        || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? ''))) {
        json(response, 403, { error: 'Save requests must come from this canvas editor' })
        return
      }
      if (!['GET', 'POST'].includes(method)) {
        json(response, 405, { error: 'Method unavailable' })
        return
      }
      const staticFile = staticFiles.get(pathname)
      if (method === 'GET' && staticFile) {
        await sendUi(response, ...staticFile)
        return
      }
      if (method === 'GET' && pathname === '/') {
        await sendUi(response, library ? 'library.html' : 'index.html')
        return
      }
      if (library && method === 'GET' && pathname === '/api/library') {
        json(response, 200, { origin: library.origin.key, folders: await library.list(), launch: launch(library.origin) })
        return
      }
      if (library && method === 'POST' && pathname === '/api/artifacts') {
        const { origin: key, ...input } = await readJson(request)
        json(response, 201, await library.createArtifact(input, key))
        return
      }
      let entry
      let route = pathname
      if (library) {
        const match = /^\/artifacts\/([a-z0-9-]+)\/([a-z0-9-]+)(\/.*)?$/.exec(pathname)
        entry = match && await library.openArtifact(match[2], match[1])
        if (!entry) {
          json(response, 404, { error: 'Artifact not found' })
          return
        }
        route = match[3]
        if (method === 'GET' && !route) {
          const query = searchParams.toString()
          response.writeHead(308, { Location: entry.artifact.url + (query ? '?' + query : '') })
          response.end()
          return
        }
        if (method === 'GET' && route === '/') {
          await sendUi(response, 'index.html')
          return
        }
      }
      const project = entry?.project ?? scope
      const writeTool = writeTools.get(route)
      if (method === 'POST') {
        if (writeTool) json(response, 200, await callTool(project, writeTool, await readJson(request)))
        else json(response, 405, { error: 'Method unavailable' })
      } else if (route === '/api/canvas') {
        json(response, 200, { ...await project.list(), artifact: entry?.artifact, launch: launch(entry?.origin) })
      } else if (route === '/api/board') {
        json(response, 200, await project.readBoard(searchParams.get('filename')))
      } else if (route === '/api/preview') {
        const board = await project.readBoard(searchParams.get('filename'))
        send(response, 200, await previewDocument(project, board), 'text/html', {
          'Content-Security-Policy': 'sandbox allow-scripts',
        })
      } else if (route === '/api/export') {
        const frame = searchParams.get('frame')
        const page = searchParams.get('page')
        const filename = frame || project.type === 'single' ? 'artboard.html' : page ? 'page.html' : 'canvas.html'
        send(response, 200, await exportDocument(project, { frame, page }), 'text/html', {
          'Content-Disposition': 'attachment; filename="' + filename + '"',
        })
      } else if (route === '/api/guide') {
        send(response, 200, guide, 'text/plain')
      } else {
        json(response, 404, { error: 'Page not found' })
      }
    } catch (error) {
      json(response, 400, { error: error.message })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return server
}
