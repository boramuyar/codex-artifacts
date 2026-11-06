import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite, directory, fileStatus, locked, openProject } from './project.mjs'

const keyPattern = /^[a-z0-9][a-z0-9-]{0,119}$/
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const validKey = (value) => typeof value === 'string' && keyPattern.test(value) && !reserved.test(value)

function originFolder(location) {
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(location)
  if (!windows && !path.posix.isAbsolute(location)) throw new Error('Use an absolute path for --origin')
  const canonical = windows ? path.win32.normalize(location).replace(/\\+$/, '').toLowerCase()
    : path.posix.normalize(location).replace(/\/+$/, '') || '/'
  const [prefix, ...segments] = windows
    ? canonical.replace(/^\\\\/, 'unc\\').split('\\')
    : ('root' + canonical).split('/')
  const parts = [prefix.replace(/:$/, ''), ...segments.filter(Boolean)]
  const plain = parts.map(slug).join('--')
  const reversible = parts.every((part) => slug(part) === part)
  const suffix = createHash('sha256').update(canonical).digest('hex').slice(0, 12)
  const key = reversible && validKey(plain) ? plain : plain.slice(0, 106) + '--' + suffix
  return { key, path: windows && canonical.endsWith(':') ? canonical + '\\' : canonical }
}

async function childDirectory(parent, key) {
  if (!validKey(key)) return null
  const target = path.join(parent, key)
  const status = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return status?.isDirectory() ? target : null
}

async function readMarker(folder, filename) {
  if (!folder) return null
  const target = path.join(folder, filename)
  if (!(await fileStatus(target))) return null
  return JSON.parse(await readFile(target, 'utf8'))
}

function artifactEntry(origin, id, marker) {
  if (marker?.id !== id || !['design', 'single'].includes(marker.type)
    || typeof marker.title !== 'string' || typeof marker.createdAt !== 'string') return null
  const { title, type, createdAt } = marker
  return { id, type, title, origin: origin.key, createdAt, url: '/artifacts/' + origin.key + '/' + id + '/' }
}

/**
 * Open a filesystem library with one default conversation origin.
 * Browser calls may select another registered origin. Agent calls use the default.
 */
export async function openLibrary(location, conversationOrigin) {
  await mkdir(location, { recursive: true })
  const root = await realpath(location)
  const origin = originFolder(conversationOrigin)
  const originRoot = await directory(root, origin.key)
  const originMarker = path.join(originRoot, 'origin.json')
  await locked(originMarker, async () => {
    const stored = await readMarker(originRoot, 'origin.json')
    if (stored && stored.path !== origin.path) throw new Error('Origin folder already belongs to ' + stored.path)
    if (!stored) await atomicWrite(originMarker, JSON.stringify(origin, null, 2) + '\n')
  })

  async function readOrigin(key) {
    const folder = await childDirectory(root, key)
    const entry = await readMarker(folder, 'origin.json')
    return entry?.key === key && typeof entry.path === 'string' ? entry : null
  }

  async function readArtifact(scope, id) {
    const folder = await childDirectory(path.join(root, scope.key), id)
    return artifactEntry(scope, id, await readMarker(folder, 'artifact.json'))
  }

  async function listArtifacts(scope) {
    const entries = await readdir(path.join(root, scope.key), { withFileTypes: true })
    const artifacts = await Promise.all(entries.filter((entry) => entry.isDirectory())
      .map((entry) => readArtifact(scope, entry.name)))
    return artifacts.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  return {
    root,
    origin,
    async list() {
      const entries = await readdir(root, { withFileTypes: true })
      const origins = await Promise.all(entries.filter((entry) => entry.isDirectory())
        .map((entry) => readOrigin(entry.name)))
      return Promise.all(origins.filter(Boolean).sort((a, b) => a.key.localeCompare(b.key))
        .map(async (scope) => ({ ...scope, artifacts: await listArtifacts(scope) })))
    },
    listArtifacts: () => listArtifacts(origin),
    async createArtifact({ type, title, id }, key = origin.key) {
      if (!['design', 'single'].includes(type)) throw new Error('Choose design or single for type')
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 160) {
        throw new Error('Give the artifact a title of up to 160 characters')
      }
      const scope = await readOrigin(key)
      if (!scope) throw new Error('Origin folder not found')
      id ??= (slug(title).slice(0, 80) || 'artifact') + '-' + randomUUID().slice(0, 8)
      if (!validKey(id)) throw new Error('Use a lowercase artifact ID such as release-checklist')
      const folder = path.join(root, scope.key, id)
      try {
        await mkdir(folder)
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Artifact already exists: ' + id)
        throw error
      }
      const marker = { id, type, title: title.trim(), createdAt: new Date().toISOString() }
      try {
        await atomicWrite(path.join(folder, 'artifact.json'), JSON.stringify(marker, null, 2) + '\n')
      } catch (error) {
        await rmdir(folder).catch(() => {})
        throw error
      }
      return artifactEntry(scope, id, marker)
    },
    async openArtifact(id, key = origin.key) {
      const scope = await readOrigin(key)
      const artifact = scope && await readArtifact(scope, id)
      if (!artifact) return null
      const project = await openProject(path.join(root, scope.key, id), artifact)
      return { artifact, project, origin: scope }
    },
  }
}
