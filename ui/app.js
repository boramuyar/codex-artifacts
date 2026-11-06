import { canvasView } from './canvas-view.js'

const byId = (id) => document.getElementById(id)
const fields = ['html', 'js', 'props']
const pagePicker = byId('page-picker')
const editPage = byId('edit-page')
const artifactBase = location.pathname.replace(/\/$/, '')
const api = (route) => artifactBase + '/api/' + route
const state = {
  canvas: null, page: 'main', board: null, view: 'canvas', reading: 0, camera: undefined,
  placingComment: false, comments: false, pin: null, activeComment: null, posting: false,
  field: 'html', dirty: false, saving: false, saved: false, sourceError: '', conflict: '', latest: null, comparing: false,
  exporting: false, failedExport: null,
}
const isSingle = () => state.canvas?.type === 'single'
let pageSignature = ''
let commentsSignature = ''
let statusTimer
let refreshing

async function request(url, options) {
  const response = await fetch(url, options)
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}))
    throw new Error(error ?? 'Request failed')
  }
  return response
}

async function post(url, input) {
  const response = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return response.json()
}

function status(message, kind = 'quiet') {
  const indicator = byId('status')
  if (indicator.textContent === message && indicator.dataset.kind === kind) return
  clearTimeout(statusTimer)
  indicator.textContent = message
  indicator.dataset.kind = kind
  if (kind === 'notice') {
    statusTimer = setTimeout(() => { indicator.dataset.kind = 'quiet' }, 3200)
  }
}

function report(error) {
  status(error.message ?? String(error), 'error')
}

function pageBoards() {
  return state.canvas?.boards.filter(({ page }) => page === state.page) ?? []
}

function renderPickers() {
  const pages = state.canvas?.pages ?? []
  const pagesKey = JSON.stringify(pages)
  if (pagesKey !== pageSignature) {
    const edited = editPage.value
    pageSignature = pagesKey
    pagePicker.replaceChildren(...pages.map(({ title, id }) => new Option(title, id)), new Option('New page…', '__new'))
    editPage.replaceChildren(...pages.map(({ title, id }) => new Option(title, id)))
    editPage.value = pages.some(({ id }) => id === edited) ? edited : state.page
  }
  pagePicker.value = state.page
  pagePicker.disabled = !state.canvas

}

function openComments() {
  const boards = state.canvas?.boards ?? []
  const filenames = new Set(boards.map(({ filename }) => filename))
  return (state.canvas?.comments ?? []).filter(note => !note.resolvedAt && filenames.has(note.filename))
    .map((note, index) => ({ ...note, number: index + 1 }))
}

function renderComments(comments) {
  const { boards, pages } = state.canvas
  const signature = JSON.stringify([comments, boards.map(({ filename, title, page }) => [filename, title, page]), pages, state.activeComment])
  if (signature === commentsSignature) return
  commentsSignature = signature
  const items = comments.map((comment) => {
    const item = document.createElement('article')
    item.className = 'comment'
    item.id = 'comment-' + comment.id
    item.tabIndex = -1
    const board = boards.find(({ filename }) => filename === comment.filename)
    const heading = document.createElement('button')
    heading.type = 'button'
    heading.className = 'comment-link'
    heading.textContent = comment.number + ' · ' + board.title
    heading.setAttribute('aria-pressed', String(comment.id === state.activeComment))
    heading.addEventListener('click', () => showComment(comment.id, true).catch(report))
    const context = document.createElement('span')
    context.className = 'detail'
    context.textContent = isSingle() ? '' : pages.find(({ id }) => id === board.page)?.title ?? ''
    const body = document.createElement('p')
    body.textContent = comment.text
    const resolve = document.createElement('button')
    resolve.type = 'button'
    resolve.className = 'button'
    resolve.textContent = 'Resolve'
    resolve.addEventListener('click', async () => {
      resolve.disabled = true
      try {
        await post(api('comments/resolve'), { id: comment.id })
        await refreshAfterWrite()
      } catch (error) {
        report(error)
      } finally {
        resolve.disabled = false
      }
    })
    item.append(heading, context, body, resolve)
    return item
  })
  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'comment-hint'
    empty.textContent = 'No open comments.'
    items.push(empty)
  }
  byId('comment-list').replaceChildren(...items)
}

async function selectFrame(filename) {
  if (state.saving || state.posting) return false
  if (filename === state.board?.filename) return true
  if (!canLeave()) return false
  cancelComment()
  state.activeComment = null
  await loadBoard(filename)
  return filename === state.board?.filename
}

function pinComment(filename, x, y) {
  if (!state.placingComment || state.pin || state.posting) return
  state.pin = { filename, x, y }
  const board = state.canvas.boards.find((frame) => frame.filename === filename)
  byId('comment-target').textContent = 'New comment · ' + (board?.title ?? filename)
  render()
  byId('comment-text').focus()
}

async function showComment(id, reveal = false) {
  const note = openComments().find(comment => comment.id === id)
  const board = state.canvas?.boards.find(frame => frame.filename === note?.filename)
  if (!board || (reveal && !canLeave())) return
  if (reveal && board.page !== state.page) await switchPage(board.page, board.filename)
  else if (reveal && await selectFrame(board.filename) && state.view === 'preview') showView('canvas')
  if (!state.pin) state.placingComment = false
  state.activeComment = id
  state.comments = true
  render()
  if (reveal) view.revealFrame(board.filename)
  const item = byId('comment-' + id)
  item?.focus({ preventScroll: true })
  item?.scrollIntoView({ block: 'nearest' })
}

const view = canvasView({
  stage: byId('stage'),
  world: byId('world'),
  empty: byId('empty'),
  zoomLabel: byId('zoom-fit'),
  previewUrl: (query) => api('preview?' + query),
  selectFrame: (filename) => selectFrame(filename).catch(report),
  async focusFrame(filename) {
    try {
      if (await selectFrame(filename)) showView('preview')
    } catch (error) {
      report(error)
    }
  },
  pinComment,
  showComment: (id) => showComment(id).catch(report),
})

function render() {
  renderPickers()
  const single = isSingle()
  const boards = pageBoards()
  const focused = state.view === 'preview'
  const source = state.view === 'source'
  const visible = focused ? boards.filter(({ filename }) => filename === state.board?.filename) : boards
  const comments = openComments()
  const canComment = !source && Boolean(visible.length)
  const commentMode = !source && state.placingComment && (canComment || Boolean(state.pin))
  const listOpen = Boolean(!source && state.canvas && state.comments)
  byId('stage').hidden = source
  byId('source-panel').hidden = !source
  byId('design-tools').hidden = !state.canvas || source || (single && !visible.length)
  byId('design-tools').dataset.single = String(single)
  byId('view-canvas').hidden = !focused
  byId('zoom').hidden = single || !visible.length
  byId('edit-page-label').hidden = single
  byId('source-form').classList.toggle('single-source', single)
  byId('share-frame').hidden = single
  byId('share-page').hidden = single
  byId('export').textContent = single ? 'Download HTML' : 'Download all pages'
  byId('empty').querySelector('h1').textContent = single ? 'This artifact is empty' : 'This page is empty'
  byId('empty').querySelector('p').textContent = single
    ? 'Ask your agent to add a board to this artifact.'
    : 'Ask your agent to add a frame to this page.'
  byId('comments').disabled = source || !state.canvas
  byId('comments').setAttribute('aria-expanded', String(listOpen))
  byId('comments').textContent = comments.length ? 'Comments · ' + comments.length : 'Comments'
  byId('comments-panel').hidden = !listOpen
  byId('comment-count').textContent = comments.length + (comments.length === 1 ? ' open comment' : ' open comments')
  byId('comment-tool').disabled = (!canComment && !state.pin) || state.posting
  byId('comment-tool').setAttribute('aria-pressed', String(commentMode))
  byId('comment-placement').hidden = !commentMode || Boolean(state.pin)
  byId('comment-form').hidden = !commentMode || !state.pin
  byId('comment-text').readOnly = state.posting
  byId('save-comment').disabled = state.posting || !byId('comment-text').value.trim()
  byId('save-comment').textContent = state.posting ? 'Posting…' : 'Post comment'
  byId('cancel-comment').disabled = state.posting
  byId('stage').parentElement.classList.toggle('comments-open', listOpen)
  renderShare(boards)
  byId('view-source').setAttribute('aria-pressed', String(source))
  byId('view-source').textContent = source ? 'Back to ' + (single ? 'board' : 'canvas') : 'Source'
  byId('view-source').disabled = !state.board && !source
  if (!source) view.update({
    boards: visible, mode: single ? 'single' : focused ? 'focus' : 'design',
    selected: state.board?.filename, comments, commentMode, draft: state.pin, activeComment: state.activeComment,
  })
  if (listOpen) renderComments(comments)
  renderSource()
}

function showView(next) {
  const previous = state.view
  if (previous === 'canvas' && next === 'preview') state.camera = view.camera()
  if (next === 'source') {
    cancelComment()
    state.placingComment = false
  }
  state.view = next
  render()
  if (previous === 'preview' && next === 'canvas') view.restoreCamera(state.camera)
  else if (previous !== next && next !== 'source') view.fit()
}

function showField(active) {
  state.field = active
  renderSource()
  for (const button of document.querySelectorAll('[data-field]')) {
    button.setAttribute('aria-pressed', String(button.dataset.field === active))
  }
}

function sourceProps() {
  const props = JSON.parse(byId('edit-props').value)
  if (!props || Array.isArray(props) || typeof props !== 'object') throw new Error('Enter a valid JSON object in Props.')
  return props
}

function renderSource() {
  let invalid = false
  if (state.dirty && state.board) {
    try {
      sourceProps()
    } catch {
      invalid = true
    }
  }
  byId('edit-props').setAttribute('aria-invalid', String(invalid))
  const latest = state.comparing ? state.latest : null
  for (const field of fields) {
    const input = byId('edit-' + field)
    input.hidden = Boolean(latest) || field !== state.field
    input.readOnly = state.saving
  }
  byId('edit-title').readOnly = state.saving || Boolean(latest)
  editPage.disabled = state.saving || Boolean(latest)
  byId('latest-source').hidden = !latest
  if (latest) {
    byId('latest-source').textContent = state.field === 'props' ? JSON.stringify(latest.props, null, 2) : latest[state.field]
  }

  const kind = state.conflict || invalid || state.sourceError ? 'error' : state.saved ? 'success' : ''
  const message = state.sourceError || (state.conflict === 'removed' ? 'This frame was removed. Your draft is still available.'
    : latest ? 'Your draft is preserved. Use latest replaces it with the version shown here.'
    : state.conflict ? 'Source changed on disk. Compare the latest version before replacing your draft.'
    : invalid ? 'Enter a valid JSON object in Props.' : state.saved ? 'Board saved. The preview uses this version.' : '')
  const label = state.saving ? 'Saving…' : state.conflict ? 'Conflict' : invalid ? 'Props error'
    : state.sourceError ? 'Save failed' : state.dirty ? 'Unsaved edits' : state.saved ? 'Saved' : 'Up to date'
  byId('source-status').textContent = label
  byId('source-status').dataset.kind = kind
  byId('source-feedback').hidden = !message
  byId('source-feedback').dataset.kind = kind
  byId('source-message').textContent = message
  byId('compare-source').hidden = state.conflict !== 'changed'
  byId('compare-source').textContent = latest ? 'Back to draft' : 'View latest'
  byId('use-latest').hidden = !latest
  byId('save').disabled = !state.board || !state.dirty || invalid || Boolean(state.conflict) || state.saving
  byId('save').textContent = state.saving ? 'Saving…' : 'Save board'
}

function cancelComment() {
  state.pin = null
  byId('comment-text').value = ''
  byId('comment-error').hidden = true
}

function setBoard(board) {
  state.board = board
  state.dirty = false
  state.conflict = ''
  state.latest = null
  state.comparing = false
  state.sourceError = ''
  state.saved = false
  byId('edit-title').value = board?.title ?? ''
  byId('edit-filename').value = board?.filename ?? ''
  editPage.value = state.page
  byId('edit-html').value = board?.html ?? ''
  byId('edit-js').value = board?.js ?? ''
  byId('edit-props').value = JSON.stringify(board?.props ?? {}, null, 2)
  if (!board && state.view !== 'canvas') state.view = 'canvas'
  render()
}

async function loadBoard(filename) {
  const reading = ++state.reading
  const response = await request(api('board?' + new URLSearchParams({ filename })))
  const board = await response.json()
  if (reading !== state.reading) return
  state.page = state.canvas.boards.find((frame) => frame.filename === filename)?.page ?? state.page
  setBoard(board)
  status('Selected ' + board.title)
}

function canLeave() {
  return !state.saving && !state.posting && (!state.dirty || window.confirm('Discard your unsaved edits?'))
}

async function switchPage(id, filename) {
  state.reading += 1
  state.page = id
  state.view = 'canvas'
  state.placingComment = false
  state.activeComment = null
  cancelComment()
  setBoard(null)
  view.fit()
  if (filename) await loadBoard(filename)
}

function reloadCanvas() {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const previous = state.canvas
    state.canvas = await (await request(api('canvas'))).json()
    if (!previous && !pageBoards().length && state.canvas.boards.length) state.page = state.canvas.boards[0].page
    if (!state.canvas.pages.some(page => page.id === state.page)) state.page = state.canvas.pages[0]?.id ?? 'main'
    document.title = state.canvas.title + ' · DC Canvas'
    if (!previous) status('Canvas ready')
    byId('artifact-title').textContent = state.canvas.title
    byId('back-library').hidden = !state.canvas.artifact
    if (state.canvas.artifact) byId('back-library').href = '/?' + new URLSearchParams({ folder: state.canvas.artifact.origin })
    render()
    if (state.saving) return
    const current = state.canvas.boards.find(({ filename }) => filename === state.board?.filename)
    if (!state.board && isSingle() && pageBoards().length) {
      await loadBoard(pageBoards()[0].filename)
    } else if (state.board?.revision && !current) {
      if (state.dirty) {
        state.conflict = 'removed'
        state.latest = null
        state.comparing = false
        renderSource()
      }
      else setBoard(null)
    } else if (current && current.revision !== state.board?.revision) {
      if (state.dirty) {
        state.conflict = 'changed'
        if (state.latest && state.latest.revision !== current.revision) {
          state.latest = null
          state.comparing = false
        }
        renderSource()
      }
      else await loadBoard(current.filename)
    }
  })().finally(() => { refreshing = undefined })
  return refreshing
}

async function refreshAfterWrite() {
  await refreshing?.catch(() => {})
  return reloadCanvas()
}

byId('view-canvas').addEventListener('click', () => showView('canvas'))
byId('view-source').addEventListener('click', () => {
  if (state.view !== 'source') {
    if (!state.posting) showView('source')
    return
  }
  if (!canLeave()) return
  if (state.dirty) setBoard(state.latest ?? state.board)
  showView('canvas')
  reloadCanvas().catch(report)
})
pagePicker.addEventListener('change', async () => {
  const id = pagePicker.value
  pagePicker.value = state.page
  if (id === state.page || !canLeave()) return
  try {
    if (id === '__new') {
      const title = window.prompt('Page name')?.trim()
      if (!title) return
      const page = await post(api('page'), { title })
      await refreshAfterWrite()
      await switchPage(page.id)
    } else {
      await switchPage(id)
    }
  } catch (error) {
    report(error)
  }
})
function setCommentPlacement(enabled) {
  if (state.posting) return
  cancelComment()
  state.placingComment = enabled
  render()
}

byId('comment-tool').addEventListener('click', () => setCommentPlacement(!state.placingComment))
byId('zoom-fit').addEventListener('click', view.fit)
byId('zoom-in').addEventListener('click', () => view.zoomBy(1.25))
byId('zoom-out').addEventListener('click', () => view.zoomBy(1 / 1.25))
byId('comments').addEventListener('click', () => {
  state.comments = !state.comments
  render()
})
byId('close-comments').addEventListener('click', () => {
  byId('comments').click()
  byId('comments').focus()
})
byId('refresh').addEventListener('click', view.refresh)
function closeComposer() {
  setCommentPlacement(false)
  byId('comment-tool').focus()
}
byId('cancel-comment').addEventListener('click', closeComposer)
byId('comment-text').addEventListener('input', () => {
  byId('save-comment').disabled = !byId('comment-text').value.trim()
})
byId('comment-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!state.pin || byId('save-comment').disabled) return
  state.posting = true
  byId('comment-error').hidden = true
  render()
  let note
  try {
    note = await post(api('comments'), { ...state.pin, text: byId('comment-text').value })
  } catch {
    byId('comment-error').textContent = 'Couldn’t post this comment. Try again.'
    byId('comment-error').hidden = false
  } finally {
    state.posting = false
    if (note) {
      if (!state.canvas.comments.some(comment => comment.id === note.id)) state.canvas.comments.push(note)
      state.activeComment = note.id
      closeComposer()
      status('Comment posted', 'notice')
      refreshAfterWrite().catch(report)
    } else {
      render()
    }
  }
})

for (const button of document.querySelectorAll('[data-field]')) {
  button.addEventListener('click', () => showField(button.dataset.field))
}
byId('source-form').addEventListener('input', () => {
  state.dirty = true
  state.saved = false
  state.sourceError = ''
  renderSource()
})
byId('source-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!state.board || byId('save').disabled) return
  state.saving = true
  state.sourceError = ''
  renderSource()
  let saved
  try {
    saved = await post(api('board'), {
      filename: state.board.filename,
      title: byId('edit-title').value.trim(),
      html: byId('edit-html').value,
      js: byId('edit-js').value,
      props: sourceProps(),
      revision: state.board.revision,
      ...(isSingle() ? {} : { page: editPage.value }),
    })
    await refreshing?.catch(() => {})
  } catch (error) {
    if (state.board.revision && error.message.startsWith('Board changed since it was opened.')) {
      state.conflict = 'changed'
    } else {
      state.sourceError = 'Couldn’t save board. ' + error.message
    }
  } finally {
    state.saving = false
  }
  if (saved) {
    state.page = saved.page
    setBoard(saved)
    state.saved = true
    refreshAfterWrite().catch(report)
  }
  renderSource()
})
byId('compare-source').addEventListener('click', async () => {
  if (state.comparing) {
    state.comparing = false
    renderSource()
    return
  }
  const board = state.board
  const button = byId('compare-source')
  button.disabled = true
  try {
    const latest = await (await request(api('board?' + new URLSearchParams({ filename: board.filename })))).json()
    if (state.board !== board || state.view !== 'source' || state.conflict !== 'changed') return
    state.latest = latest
    state.comparing = true
    state.sourceError = ''
  } catch (error) {
    state.sourceError = 'Couldn’t load the latest source. ' + error.message
  } finally {
    button.disabled = false
    renderSource()
  }
})
byId('use-latest').addEventListener('click', () => {
  if (!state.latest) return
  state.page = state.latest.page
  setBoard(state.latest)
})
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.view === 'source') {
    event.preventDefault()
    byId('source-form').requestSubmit()
    return
  }
  if (event.key === 'Escape' && byId('share-menu').open) {
    event.preventDefault()
    byId('share-menu').open = false
    byId('share-menu').querySelector('summary').focus()
    return
  }
  if (event.key === 'Escape' && state.placingComment && !state.posting) {
    event.preventDefault()
    closeComposer()
    return
  }
  if (event.key === 'Escape' && state.view === 'preview' && !state.posting) {
    showView('canvas')
    return
  }
  if (event.key.toLowerCase() === 'c' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat
    && !event.target.closest?.('input, select, textarea, [contenteditable]')
    && !byId('comment-tool').disabled) {
    event.preventDefault()
    byId('comment-tool').click()
  }
})
window.addEventListener('beforeunload', (event) => {
  if (state.dirty) event.preventDefault()
})

byId('agent-setup').addEventListener('click', () => {
  if (!state.canvas) return
  const { artifact } = state.canvas
  byId('setup-scope').textContent = artifact
    ? 'Add this server to your agent’s MCP configuration. It can list and edit artifacts in ' + artifact.origin + '.'
    : 'Add this server to your agent’s MCP configuration. It works on the same files as this canvas.'
  byId('setup-config').textContent = JSON.stringify({
    mcpServers: { 'dc-canvas': state.canvas.launch },
  }, null, 2)
  byId('setup-dialog').showModal()
})
byId('copy-config').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(byId('setup-config').textContent)
    status('MCP configuration copied', 'notice')
    byId('setup-dialog').close()
  } catch (error) {
    report(error)
  }
})

function renderShare(boards) {
  const board = boards.find(({ filename }) => filename === state.board?.filename)
  const page = state.canvas?.pages.find(({ id }) => id === state.page)
  byId('share-frame').textContent = board ? 'Selected frame · ' + board.title : 'Selected frame'
  byId('share-page').textContent = page ? 'Current page · ' + page.title : 'Current page'
  byId('export').textContent = isSingle() ? 'Download HTML' : 'All pages'
  byId('share-frame').disabled = state.exporting || !board
  byId('share-page').disabled = state.exporting || !boards.length
  byId('export').disabled = state.exporting || !state.canvas?.boards.length
  byId('copy-link').disabled = state.exporting
  byId('retry-export').hidden = !state.failedExport || state.exporting
}

function shareFeedback(message, kind = '') {
  byId('share-feedback').hidden = !message
  byId('share-feedback').dataset.kind = kind
  byId('share-status').textContent = message
  renderShare(pageBoards())
}

async function download(target) {
  if (state.exporting) return
  const { selection, name, label } = target
  state.exporting = true
  state.failedExport = null
  shareFeedback('Preparing HTML · ' + label)
  let message, kind
  try {
    const response = await request(api('export?' + new URLSearchParams(selection)))
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
    message = 'Download started · ' + label
    kind = 'success'
  } catch {
    state.failedExport = target
    message = 'Couldn’t export HTML · ' + label
    kind = 'error'
  } finally {
    state.exporting = false
    shareFeedback(message, kind)
    if (!byId('share-menu').open) status(message, kind === 'error' ? 'error' : 'notice')
  }
}

byId('share-frame').addEventListener('click', () => {
  const { filename, title } = state.board
  download({ selection: { frame: filename }, name: filename.replace(/\.dc\.html$/i, '.html'), label: 'Selected frame · ' + title })
})
byId('share-page').addEventListener('click', () => {
  const page = state.canvas.pages.find(({ id }) => id === state.page)
  download({ selection: { page: state.page }, name: 'page.html', label: 'Current page · ' + page.title })
})
byId('export').addEventListener('click', () => download({
  selection: {}, name: isSingle() ? 'artboard.html' : 'canvas.html',
  label: isSingle() ? state.canvas.title : 'All pages',
}))
byId('retry-export').addEventListener('click', () => {
  if (state.failedExport) download(state.failedExport)
})
byId('copy-link').addEventListener('click', async () => {
  state.failedExport = null
  try {
    await navigator.clipboard.writeText(location.href)
    if (!state.exporting) shareFeedback('Local link copied.', 'success')
  } catch {
    if (!state.exporting) shareFeedback('Couldn’t copy the local link. Copy the address from the browser bar.', 'error')
  }
})
document.addEventListener('click', (event) => {
  const share = byId('share-menu')
  if (share.open && !share.contains(event.target)) share.open = false
})

byId('guide-link').href = api('guide')
setBoard(null)
reloadCanvas().catch(report)
setInterval(() => reloadCanvas().catch(report), 1400)
