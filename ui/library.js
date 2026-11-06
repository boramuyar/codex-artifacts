const byId = (id) => document.getElementById(id)
const list = byId('artifacts')
const originPicker = byId('artifact-origin')
const status = byId('library-status')
const retry = byId('library-retry')
const currentUrl = new URL(location.href)
let library
let signature
let refreshing

function element(tag, text, className) {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

function folderLabel(folder) {
  return folder.path.split(/[\\/]/).filter(Boolean).at(-1) ?? folder.key
}

function artifactCard(artifact) {
  const item = element('li', '', 'artifact-card')
  const link = element('a', '', 'artifact-link')
  link.href = artifact.url
  const design = artifact.type === 'design'
  const cover = element('div', '', 'artifact-cover ' + (design ? 'design-cover' : 'single-cover'))
  cover.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < (design ? 2 : 1); i += 1) {
    const frame = element('span', '', 'cover-frame')
    frame.append(element('i', ''), element('i', ''), element('i', ''))
    cover.append(frame)
  }
  const content = element('div', '', 'artifact-content')
  content.append(element('h2', artifact.title), element('span', design ? 'Design' : 'Single', design ? 'tag design' : 'tag'))
  link.append(cover, content)
  item.append(link)
  return item
}

function render() {
  const folder = library.folders.find(({ key }) => key === originPicker.value)
  const artifacts = folder?.artifacts ?? []
  const key = JSON.stringify([folder?.key, artifacts])
  if (key !== signature) {
    signature = key
    const focused = list.contains(document.activeElement) ? document.activeElement.href : null
    const cards = artifacts.map(artifactCard)
    list.replaceChildren(...cards)
    if (focused) cards.find(card => card.firstChild.href === focused)?.firstChild.focus()
  }
  byId('artifact-count').textContent = artifacts.length + (artifacts.length === 1 ? ' artifact' : ' artifacts')
  byId('library-state').hidden = Boolean(artifacts.length)
  byId('library-skeleton').hidden = true
  list.hidden = !artifacts.length
  retry.hidden = true
  status.textContent = artifacts.length ? '' : 'Artifacts appear here when an agent saves them to this folder.'
}

async function refresh() {
  if (refreshing) return
  refreshing = true
  retry.disabled = true
  try {
    const response = await fetch('/api/library')
    if (!response.ok) throw new Error('Couldn’t load the artifact library.')
    const next = await response.json()
    const selected = originPicker.value || currentUrl.searchParams.get('folder') || next.origin
    const labels = next.folders.map(folderLabel)
    if (JSON.stringify(next.folders.map(({ key, path }) => [key, path])) !==
        JSON.stringify(library?.folders.map(({ key, path }) => [key, path]))) {
      originPicker.replaceChildren(...next.folders.map(({ key }, index) =>
        new Option(labels.filter(label => label === labels[index]).length > 1 ? key : labels[index], key)))
    }
    originPicker.value = next.folders.some(({ key }) => key === selected) ? selected : next.origin
    originPicker.disabled = !next.folders.length
    library = next
    render()
  } catch {
    byId('library-state').hidden = false
    byId('library-skeleton').hidden = true
    status.textContent = 'Couldn’t load the artifact library. Try again.'
    retry.hidden = false
  } finally {
    retry.disabled = false
    refreshing = false
  }
}

originPicker.addEventListener('change', () => {
  currentUrl.searchParams.set('folder', originPicker.value)
  history.replaceState(null, '', currentUrl)
  render()
})
retry.addEventListener('click', refresh)
byId('library-agent').addEventListener('click', () => {
  const folder = library?.folders.find(({ key }) => key === originPicker.value)
  if (!folder) return
  const launch = { ...library.launch, args: [...library.launch.args] }
  const originArg = launch.args.lastIndexOf('--origin')
  if (originArg >= 0) launch.args[originArg + 1] = folder.path
  byId('library-scope').textContent = 'Add this MCP server to your agent to create and edit artifacts in ' + folderLabel(folder) + '.'
  byId('library-config').textContent = JSON.stringify({ mcpServers: { 'dc-canvas': launch } }, null, 2)
  byId('library-copy').textContent = 'Copy config'
  byId('library-setup').showModal()
})
byId('library-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(byId('library-config').textContent)
    byId('library-copy').textContent = 'Copied'
  } catch {
    byId('library-copy').textContent = 'Select the configuration to copy'
  }
})

refresh()
setInterval(refresh, 4000)
