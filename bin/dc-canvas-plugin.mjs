import { homedir } from 'node:os'
import path from 'node:path'
import { openLibrary } from '../src/library.mjs'
import { serveMcp } from '../src/mcp.mjs'

try {
  const data = process.env.DC_CANVAS_LIBRARY || path.join(homedir(), '.dc-canvas', 'library')
  const library = await openLibrary(path.resolve(data), process.env.DC_CANVAS_ORIGIN || process.cwd())
  await serveMcp(library)
} catch (error) {
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
}
