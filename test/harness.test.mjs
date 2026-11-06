import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { openProject } from '../src/project.mjs'
import { openLibrary } from '../src/library.mjs'
import { callTool } from '../src/tools.mjs'

const entry = fileURLToPath(new URL('../bin/dc-canvas.mjs', import.meta.url))

async function temporaryProject(t) {
  const parent = await realpath(fileURLToPath(new URL('../', import.meta.url)))
  const root = await mkdtemp(path.join(parent, 'dc-canvas-test-'))
  t.after(async () => {
    const target = await realpath(root)
    assert.equal(path.dirname(target), parent)
    assert.match(path.basename(target), /^dc-canvas-test-/)
    await rm(target, { recursive: true })
  })
  return root
}

function cli(project, args, input) {
  const result = spawnSync(process.execPath, [entry, ...args, '--project', project], {
    input, encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('library agents see their origin and single artifacts enforce the one-board invariant', async (t) => {
  const root = await temporaryProject(t)
  const library = await openLibrary(root, 'C:/work/example')
  const other = await openLibrary(root, 'C:/work/other')
  const design = await callTool(library, 'artifact_create', { id: 'dashboard', type: 'design', title: 'Dashboard' })
  const single = await callTool(library, 'artifact_create', { id: 'one', type: 'single', title: 'One board' })
  await other.createArtifact({ id: 'private', type: 'design', title: 'Other origin' })
  assert.equal(design.url, '/artifacts/c--work--example/dashboard/')
  assert.equal((await openLibrary(root, 'c:\\work\\example\\')).origin.key, 'c--work--example')
  assert.equal((await library.list()).length, 2)

  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'artifact_list' } },
    { id: 4, method: 'tools/call', params: { name: 'canvas_list', arguments: { artifact: 'private' } } },
  ]
  const result = spawnSync(process.execPath, [entry, 'mcp', '--library', root, '--origin', 'C:/work/example'], {
    input: messages.map((message) => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n',
    encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  const [, definitions, listing, denied] = result.stdout.trim().split('\n').map(JSON.parse)
  assert(definitions.result.tools.find(({ name }) => name === 'dc_write').inputSchema.required.includes('artifact'))
  assert.deepEqual(listing.result.structuredContent.artifacts.map(({ id }) => id).sort(), ['dashboard', 'one'])
  assert.equal(denied.result.isError, true)

  const makeBoard = (filename) => callTool(library, 'dc_write', { artifact: single.id, filename, html: '<h1>Board</h1>' })
  const writes = await Promise.allSettled([makeBoard('First.dc.html'), makeBoard('Second.dc.html')])
  assert.equal(writes.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.match(writes.find(({ status }) => status === 'rejected').reason.message, /already has a board/)
  const { boards } = await callTool(library, 'canvas_list', { artifact: single.id })
  assert.equal(boards.length, 1)
  await makeBoard(boards[0].filename)
  await assert.rejects(callTool(library, 'canvas_create_page', { artifact: single.id, title: 'Extra' }), /design artifacts/)
  const exported = await callTool(library, 'canvas_export', { artifact: single.id })
  assert.match(await readFile(exported.path, 'utf8'), /<body class="single">/)
})

test('the plugin launcher writes a board and returns a working browser link', { timeout: 15000 }, async (t) => {
  const root = await temporaryProject(t)
  const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'mcp.json'), 'utf8'))
  const { command, args } = manifest.mcpServers['dc-canvas']
  const child = spawn(command, args.map((arg) => arg.replace('${PLUGIN_ROOT}/', pluginRoot)), {
    cwd: root,
    env: { ...process.env, DC_CANVAS_LIBRARY: path.join(root, 'library'), DC_CANVAS_ORIGIN: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  t.after(async () => { child.stdin.end(); await closed })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let id = 0
  async function request(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n')
    const line = await lines.next()
    assert(!line.done, stderr || 'Plugin stopped before replying')
    const reply = JSON.parse(line.value)
    assert.equal(reply.id, id)
    assert(!reply.error && !reply.result.isError, JSON.stringify(reply))
    return reply.result
  }
  async function tool(name, args) {
    return (await request('tools/call', { name, arguments: args })).structuredContent
  }

  await request('initialize', { protocolVersion: '2025-06-18' })
  const { tools } = await request('tools/list')
  assert(tools.some(({ name }) => name === 'artifact_open'))
  const { id: artifact } = await tool('artifact_create', { id: 'demo', type: 'single', title: 'Plugin demo' })
  await tool('dc_write', { artifact, filename: 'Demo.dc.html', html: '<h1>Plugin demo</h1>' })
  const { url } = await tool('artifact_open', { artifact })
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/artifacts\/.+\/demo\/$/)
  assert.equal((await tool('artifact_open', { artifact })).url, url)
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>DC Canvas<\/title>/)
  const response = await fetch(new URL('api/canvas', url))
  assert.equal(response.status, 200)
  const canvas = await response.json()
  assert.equal(canvas.boards[0].filename, 'Demo.dc.html')
  child.stdin.end()
  const [code] = await closed
  assert.equal(code, 0, stderr)
})

test('MCP writes a board the CLI can export with its assets', async (t) => {
  const root = await temporaryProject(t)
  const project = await openProject(root)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>'
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'asset_put', arguments: { filename: 'mark.svg', base64: Buffer.from(svg).toString('base64') } } },
    { id: 4, method: 'tools/call', params: {
      name: 'dc_write',
      arguments: {
        filename: 'Widget.dc.html',
        title: 'Widget & logo',
        html: '<img src="assets/mark.svg"><button onClick="{{press}}">{{label}}</button>',
        js: 'class Component extends DCLogic { renderVals(){return { label: "</script>", press: () => {} }} }',
        props: { $preview: { width: 640, height: 400 } },
      },
    } },
  ]
  const input = messages.map((message) => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n'
  const responses = cli(root, ['mcp'], input).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(responses.length, 4)
  assert.equal(responses[0].result.protocolVersion, '2025-06-18')
  assert(responses[1].result.tools.some((tool) => tool.name === 'dc_write'))
  assert(!responses[2].result.isError, responses[2].result.content[0].text)
  assert(!responses[3].result.isError, responses[3].result.content[0].text)
  assert.equal(responses[2].result.structuredContent.path, 'assets/mark.svg')
  assert.equal(responses[3].result.structuredContent.title, 'Widget & logo')

  const source = await project.readBoard('Widget.dc.html')
  assert.equal(source.js, messages[4].params.arguments.js)
  const exported = JSON.parse(cli(root, ['export']))
  const document = await readFile(exported.path, 'utf8')
  const [packed] = JSON.parse(/id="canvas-manifest">([^<]+)<\/script>/.exec(document)[1])
  const preview = gunzipSync(Buffer.from(packed.data, 'base64')).toString()
  const board = JSON.parse(/id="board-input">([^<]+)<\/script>/.exec(preview)[1])
  assert.equal(packed.width, 640)
  assert.equal(board.js, source.js)
  assert(board.html.includes('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')))
})

test('targeted edits preserve literal dollar text and revisions reject a stale save', async (t) => {
  const project = await openProject(await temporaryProject(t))
  const original = await callTool(project, 'dc_write', { filename: 'A.dc.html', html: '<h1>Title</h1><p>Title</p>' })
  await assert.rejects(callTool(project, 'dc_html_str_replace', {
    filename: original.filename, old_string: 'Title', new_string: 'New',
  }), /more than once/)
  const changed = await callTool(project, 'dc_html_str_replace', {
    filename: original.filename, old_string: 'Title', new_string: '$&', replace_all: true,
  })
  assert.equal(changed.html, '<h1>$&</h1><p>$&</p>')
  await assert.rejects(callTool(project, 'dc_write', {
    filename: original.filename, revision: original.revision, html: 'stale',
  }), /changed since/)
  await assert.rejects(callTool(project, 'dc_write', { filename: '../A.dc.html', html: 'escaped' }), /filename/)
})

test('pages, placements, and comments survive edits and scope standalone exports', async (t) => {
  const root = await temporaryProject(t)
  const project = await openProject(root)
  const first = await callTool(project, 'dc_write', { filename: 'First.dc.html', html: '<h1>First</h1>' })
  assert.equal((await project.list()).boards[0].page, 'main')
  await callTool(project, 'canvas_create_page', { id: 'flows', title: 'User flows' })
  await callTool(project, 'canvas_place_frame', { filename: first.filename, page: 'flows', x: -60, y: 16 })
  await callTool(project, 'dc_html_str_replace', { filename: first.filename, old_string: 'First', new_string: 'First flow' })
  await callTool(project, 'dc_write', { filename: 'Second.dc.html', page: 'flows', html: '<h1>Second flow</h1>' })
  await callTool(project, 'dc_write', { filename: 'Elsewhere.dc.html', html: '<h1>Elsewhere</h1>' })
  const [comment] = await Promise.all([
    callTool(project, 'comment_add', { filename: first.filename, x: 0.2, y: 0.6, text: 'Private comment' }),
    callTool(project, 'comment_add', { filename: 'Second.dc.html', x: 0.5, y: 0.5, text: 'Second note' }),
  ])
  await callTool(project, 'comment_resolve', { id: comment.id })
  const reopened = await openProject(root)
  const canvas = await reopened.list()
  const [flow, following] = canvas.boards.filter(({ page }) => page === 'flows')
  assert.deepEqual([flow.x, flow.y], [-60, 16])
  assert(following.x >= flow.x + flow.width)
  assert.equal(canvas.comments.length, 2)
  assert(canvas.comments.find(({ id }) => id === comment.id).resolvedAt)
  await assert.rejects(callTool(project, 'canvas_export', { frame: '' }), /Board not found/)

  const result = JSON.parse(cli(root, ['export', '--frame', first.filename]))
  const document = await readFile(result.path, 'utf8')
  assert(document.includes('<body class="single">'))
  assert(!document.includes('Private comment'))
  const entries = JSON.parse(/id="canvas-manifest">([^<]+)<\/script>/.exec(document)[1])
  assert.equal(entries.length, 1)
  assert(gunzipSync(Buffer.from(entries[0].data, 'base64')).toString().includes('First flow'))
  const page = JSON.parse(cli(root, ['export', '--page', 'flows']))
  const pageDocument = await readFile(page.path, 'utf8')
  const pageEntries = JSON.parse(/id="canvas-manifest">([^<]+)<\/script>/.exec(pageDocument)[1])
  assert.deepEqual(pageEntries.map(({ title }) => title), ['First', 'Second'])
})
