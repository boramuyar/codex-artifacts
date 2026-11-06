#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import { openProject } from '../src/project.mjs'
import { openLibrary } from '../src/library.mjs'
import { serveMcp } from '../src/mcp.mjs'
import { startServer } from '../src/server.mjs'
import { callTool, guide, libraryToolDefinitions, toolDefinitions } from '../src/tools.mjs'

const help = [
  'dc-canvas init   --project ./my-canvas',
  'dc-canvas serve  [--library ./library] [--origin <folder>] [--port 4173]',
  'dc-canvas mcp    [--library ./library] [--origin <folder>]',
  'dc-canvas tool   <name> [--library ./library] [--origin <folder>] [--json JSON]',
  'dc-canvas tools  [--project ./my-canvas]',
  'dc-canvas guide',
  'dc-canvas export --project ./my-canvas [--frame Board.dc.html | --page main] [--output canvas.html]',
  '',
  'The origin defaults to the current directory. Use --project for a standalone canvas.',
  'Pipe JSON into tool to pass longer inputs.',
].join('\n')

const starter = {
  filename: 'Welcome.dc.html',
  title: 'Welcome board',
  html: [
    '<helmet><style>',
    'body{background:#eff0fa;color:#20243d;font:16px system-ui,sans-serif}',
    'main{box-sizing:border-box;min-height:100vh;display:grid;place-items:center;padding:32px}',
    'article{max-width:480px;padding:44px;border:1px solid #dce0f6;border-radius:22px;background:#fff;box-shadow:0 16px 50px #363ba113}',
    'small{color:#5346bc;font-weight:700;letter-spacing:.1em;text-transform:uppercase}',
    'h1{font-size:40px;letter-spacing:-.045em;line-height:1.08;margin:12px 0}',
    'p{color:#565b75;line-height:1.6}button{padding:12px 16px;background:#5044c8;color:white;border:0;border-radius:8px;font:inherit;cursor:pointer}',
    '</style></helmet>',
    '<main><article><small>Starter artboard</small><h1>Make something here.</h1>',
    '<p>This board shares its source with the editor and your agent. Click to see its state update.</p>',
    '<button onClick="{{increment}}">Count {{count}}</button>',
    '<sc-if value="{{clicked}}"><p>The board responded to your click.</p></sc-if></article></main>',
  ].join('\n'),
  js: [
    'class Component extends DCLogic {',
    '  state = { count: 0 }',
    '',
    '  renderVals() {',
    '    const { count } = this.state',
    '    return { count, clicked: count > 0, increment: () => this.setState({ count: count + 1 }) }',
    '  }',
    '}',
  ].join('\n'),
  props: { $preview: { width: 900, height: 560 } },
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      library: { type: 'string' },
      origin: { type: 'string' },
      port: { type: 'string', default: '4173' },
      host: { type: 'string', default: '127.0.0.1' },
      title: { type: 'string' },
      output: { type: 'string' },
      frame: { type: 'string' },
      page: { type: 'string' },
      json: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, name] = positionals
  const printJson = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  if (!command || command === 'help' || values.help) {
    process.stdout.write(help + '\n')
    return
  }
  if (command === 'guide') {
    process.stdout.write(guide)
    return
  }
  const libraryMode = !values.project && !['init', 'export'].includes(command)
  if (values.project && (values.library || values.origin)) throw new Error('Use either --project or --library with an optional --origin')
  if (!libraryMode && (values.library || values.origin)) throw new Error('Use tool canvas_export to export an artifact from the library')
  if (command === 'tools') {
    printJson(libraryMode ? libraryToolDefinitions : toolDefinitions)
    return
  }
  if (!['init', 'serve', 'mcp', 'tool', 'export'].includes(command)) throw new Error('Unknown command: ' + command)
  const project = libraryMode
    ? await openLibrary(path.resolve(values.library ?? './library'), values.origin ?? process.env.DC_CANVAS_ORIGIN ?? process.cwd())
    : await openProject(path.resolve(values.project ?? './project'))
  if (command === 'init') {
    const canvas = await project.list()
    if (values.title) await project.setTitle(values.title)
    if (!canvas.boards.length) await project.writeBoard({ ...starter, revision: null })
    printJson(await project.list())
  } else if (command === 'serve') {
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
    const server = await startServer(project, port, {
      host: values.host,
      containerName: process.env.DC_CANVAS_CONTAINER,
    })
    process.stdout.write((libraryMode ? 'Artifact library: ' : 'Canvas editor: ') + 'http://127.0.0.1:' + server.address().port + '\n')
  } else if (command === 'mcp') {
    await serveMcp(project)
  } else if (command === 'export') {
    const { output, frame, page } = values
    printJson(await callTool(project, 'canvas_export', Object.fromEntries(
      Object.entries({ filename: output, frame, page }).filter(([, value]) => value !== undefined),
    )))
  } else {
    let input = values.json
    if (input === undefined && !process.stdin.isTTY) {
      input = ''
      for await (const chunk of process.stdin) input += chunk
    }
    printJson(await callTool(project, name, input?.trim() ? JSON.parse(input) : {}))
  }
}

main().catch((error) => {
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
})
