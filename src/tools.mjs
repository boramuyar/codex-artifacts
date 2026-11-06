import { readFile } from 'node:fs/promises'
import { exportDocument } from './pack.mjs'
import { record } from './project.mjs'

export const guide = await readFile(new URL('../GUIDE.md', import.meta.url), 'utf8')

const filename = { type: 'string', description: 'A project filename such as Dashboard.dc.html.' }
const text = { type: 'string' }
const number = { type: 'number' }
const page = { type: 'string', description: 'Page ID from canvas_list. Existing projects start with main.' }
const placement = { page, x: number, y: number }
const props = { type: 'object', description: 'Property metadata and optional $preview width and height.' }
const replacementFields = {
  filename,
  old_string: { type: 'string', minLength: 1 },
  new_string: text,
  replace_all: { type: 'boolean' },
}

function define(description, properties, required, run) {
  return { description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, run }
}

function replaceSource(project, input, field) {
  return project.replaceBoard(input.filename, (board) => {
    const source = board[field]
    const first = source.indexOf(input.old_string)
    if (first < 0) throw new Error('Text not found in ' + field)
    const after = first + input.old_string.length
    if (!input.replace_all && source.indexOf(input.old_string, after) >= 0) {
      throw new Error('Text occurs more than once. Use a unique match or set replace_all.')
    }
    const next = input.replace_all
      ? source.replaceAll(input.old_string, () => input.new_string)
      : source.slice(0, first) + input.new_string + source.slice(after)
    return { ...board, [field]: next }
  })
}

const tools = {
  canvas_list: define('List pages, artboards with positions and revisions, and pinned comments.', {}, [],
    (project) => project.list()),
  canvas_create_page: define('Create a page for related frames. Supply an optional lowercase ID.',
    { title: text, id: text }, ['title'], (project, input) => project.createPage(input.title, input.id)),
  canvas_place_frame: define('Move a frame to a page or set its x and y canvas coordinates. Supply both coordinates when positioning.',
    { filename, ...placement }, ['filename'], (project, input) => project.placeBoard(input)),
  dc_read: define('Read an artboard as separate template, logic and property fields.', { filename }, ['filename'],
    (project, input) => project.readBoard(input.filename)),
  dc_write: define('Create or replace a board. Send inner template markup, plain JS and optional property metadata.',
    {
      filename,
      title: text,
      html: { type: 'string', description: 'Markup inside <x-dc>, including optional <helmet><style>.' },
      js: { type: 'string', description: 'Optional class Component extends DCLogic with renderVals().' },
      props,
      ...placement,
      revision: { type: ['string', 'null'], description: 'Optional revision from dc_read. Pass null to require a new file.' },
    },
    ['filename', 'html'],
    (project, input) => project.writeBoard(input)),
  dc_html_str_replace: define('Replace exact text in the board template. A match must be unique unless replace_all is true.',
    replacementFields, ['filename', 'old_string', 'new_string'],
    (project, input) => replaceSource(project, input, 'html')),
  dc_js_str_replace: define('Replace exact text in the board logic. A match must be unique unless replace_all is true.',
    replacementFields, ['filename', 'old_string', 'new_string'],
    (project, input) => replaceSource(project, input, 'js')),
  dc_set_props: define('Replace the board property metadata, including $preview when supplied.', { filename, props },
    ['filename', 'props'], (project, input) => project.replaceBoard(input.filename, (board) => ({ ...board, props: input.props }))),
  comment_add: define('Pin a comment to a frame. Use x and y fractions from 0 to 1 inside the frame.',
    { filename, x: number, y: number, text }, ['filename', 'x', 'y', 'text'], (project, input) => project.addComment(input)),
  comment_resolve: define('Resolve a pinned comment using its ID from canvas_list.',
    { id: text }, ['id'], (project, input) => project.resolveComment(input.id)),
  asset_put: define('Store a Base64-encoded image, font, or video in assets/. Use the returned relative path in a board.',
    { filename: text, base64: text }, ['filename', 'base64'], (project, input) => {
      if (input.base64.length > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) {
        throw new Error('Expected Base64 for an asset up to 6 MB')
      }
      const bytes = Buffer.from(input.base64, 'base64')
      if (bytes.toString('base64').replace(/=+$/, '') !== input.base64.replace(/=+$/, '')) {
        throw new Error('Invalid Base64 asset')
      }
      return project.putAsset(input.filename, bytes)
    }),
  canvas_export: define('Write interactive HTML under exports/. Use frame for one standalone artboard, page for one page, or omit both for the whole canvas.',
    { filename: text, frame: { ...filename, description: 'The source artboard filename to share on its own.' }, page }, [],
    async (project, input) => project.writeExport(input.filename ?? (input.frame || project.type === 'single' ? 'artboard.html' : input.page ? 'page.html' : 'canvas.html'),
      await exportDocument(project, input))),
}

const artifactId = { type: 'string', description: 'Artifact ID from artifact_list or artifact_create.' }
const libraryTools = {
  artifact_list: define('List artifacts and their URLs in this conversation’s origin folder.', {}, [], async (library) => ({
    origin: library.origin,
    artifacts: await library.listArtifacts(),
  })),
  artifact_create: define('Create a design canvas with pages and frames, or a single-board artifact.',
    { type: { ...text, enum: ['design', 'single'] }, title: text, id: text }, ['type', 'title'],
    (library, input) => library.createArtifact(input)),
}

for (const [name, { description, inputSchema, run }] of Object.entries(tools)) {
  libraryTools[name] = define(description, { artifact: artifactId, ...inputSchema.properties },
    ['artifact', ...inputSchema.required], async (library, { artifact, ...input }) => {
      const entry = await library.openArtifact(artifact)
      if (!entry) throw new Error('Artifact not found in ' + library.origin.key + ': ' + artifact)
      return run(entry.project, input)
    })
}

const definitions = (registry) => Object.entries(registry)
  .map(([name, { description, inputSchema }]) => ({ name, description, inputSchema }))

export const toolDefinitions = definitions(tools)
export const libraryToolDefinitions = definitions(libraryTools)

/** Validate arguments and run a tool in either an origin scope or a standalone project. */
export async function callTool(scope, name, input = {}) {
  const registry = scope.origin ? libraryTools : tools
  if (!Object.hasOwn(registry, name)) throw new Error('Unknown tool: ' + name)
  const tool = registry[name]
  const { properties, required } = tool.inputSchema
  if (!record(input)) throw new Error('Tool arguments must be a JSON object')
  for (const key of required) {
    if (!Object.hasOwn(input, key)) throw new Error('Missing argument: ' + key)
  }
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(properties, key)) throw new Error('Unexpected argument: ' + key)
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const schema = properties[key]
    if (![schema.type].flat().includes(type) || (schema.minLength && value.length < schema.minLength)
      || (schema.enum && !schema.enum.includes(value))) {
      throw new Error('Invalid argument: ' + key)
    }
  }
  return tool.run(scope, input)
}
