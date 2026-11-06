import { createInterface } from 'node:readline'
import { startServer } from './server.mjs'
import { callTool, guide, libraryToolDefinitions, toolDefinitions } from './tools.mjs'

const resource = { uri: 'dc-canvas://guide', name: 'Artboard authoring guide', mimeType: 'text/markdown' }
const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
const openTool = {
  name: 'artifact_open',
  description: 'Start or reuse the local viewer and return a browser URL for an artifact in this project.',
  inputSchema: {
    type: 'object',
    properties: { artifact: { type: 'string', description: 'Artifact ID from artifact_list or artifact_create.' } },
    required: ['artifact'],
    additionalProperties: false,
  },
}

/** Serve line-delimited MCP requests scoped to one origin or a standalone project. */
export async function serveMcp(scope) {
  const definitions = scope.origin ? [...libraryToolDefinitions, openTool] : toolDefinitions
  const instructions = scope.origin
    ? 'Conversation origin folder: ' + scope.origin.key + '\n\n' + guide
    : 'Standalone project mode. Use the board tools without an artifact ID.\n\n' + guide
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  const fail = (id, code, message) => send({ id, error: { code, message } })
  let protocolVersion
  let viewer

  async function openArtifact(input) {
    if (typeof input?.artifact !== 'string' || Object.keys(input).length !== 1) {
      throw new Error('Supply one artifact ID')
    }
    const entry = await scope.openArtifact(input.artifact)
    if (!entry) throw new Error('Artifact not found in this project: ' + input.artifact)
    if (!viewer) {
      viewer = await startServer(scope, 0)
      viewer.unref()
    }
    return { ...entry.artifact, url: 'http://127.0.0.1:' + viewer.address().port + entry.artifact.url }
  }

  for await (const line of input) {
    if (!line.trim()) continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      fail(null, -32700, 'Invalid JSON')
      continue
    }
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      fail(request?.id ?? null, -32600, 'Invalid request')
      continue
    }
    const { id, method, params } = request
    if (id === undefined) continue
    if (typeof id !== 'string' && typeof id !== 'number') {
      fail(null, -32600, 'Invalid request ID')
      continue
    }
    if (method === 'initialize') {
      protocolVersion = versions.has(params?.protocolVersion) ? params.protocolVersion : '2025-06-18'
      send({
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'dc-canvas', version: '0.3.0' },
          instructions,
        },
      })
    } else if (method === 'ping') {
      send({ id, result: {} })
    } else if (!protocolVersion) {
      fail(id, -32002, 'Initialize this MCP server first')
    } else if (method === 'tools/list') {
      send({ id, result: { tools: definitions } })
    } else if (method === 'resources/list') {
      send({ id, result: { resources: [resource] } })
    } else if (method === 'resources/read' && params?.uri === resource.uri) {
      send({ id, result: { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: instructions }] } })
    } else if (method === 'resources/read') {
      fail(id, -32602, 'Unknown resource')
    } else if (method === 'tools/call') {
      if (!definitions.some((tool) => tool.name === params?.name)) {
        fail(id, -32602, 'Unknown tool')
        continue
      }
      try {
        const result = params.name === openTool.name
          ? await openArtifact(params.arguments)
          : await callTool(scope, params.name, params.arguments)
        send({
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            ...(protocolVersion === '2025-06-18' ? { structuredContent: result } : {}),
          },
        })
      } catch (error) {
        send({ id, result: { isError: true, content: [{ type: 'text', text: error.message }] } })
      }
    } else {
      fail(id, -32601, 'Unknown method')
    }
  }
  viewer?.close()
}
