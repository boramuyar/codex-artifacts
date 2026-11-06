const headerHeight = 28
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/** Render interactive frame previews and maintain a camera in design mode. */
export function canvasView({ stage, world, empty, zoomLabel, previewUrl, selectFrame, focusFrame, pinComment, showComment }) {
  const cards = new Map()
  let visible = []
  let mode = 'design'
  let placing = false
  let gesture
  let suppressClick = false
  let camera
  let manualZoom
  let scale = 1

  function reload(card) {
    const query = new URLSearchParams({ filename: card.board.filename, revision: card.board.revision, refresh: Date.now() })
    card.iframe.src = previewUrl(query)
  }

  function createCard(board) {
    const element = document.createElement('section')
    element.className = 'frame-card'
    const header = document.createElement('div')
    header.className = 'frame-head'
    const title = document.createElement('button')
    title.type = 'button'
    title.className = 'frame-title'
    title.addEventListener('click', (event) => {
      if (suppressClick && event.detail !== 0) return
      if (placing) pinComment(board.filename, 0.5, 0.5)
      else selectFrame(board.filename)
    })
    const focus = document.createElement('button')
    focus.type = 'button'
    focus.className = 'frame-focus'
    focus.textContent = 'Focus'
    focus.setAttribute('aria-label', 'Focus frame')
    focus.addEventListener('click', () => focusFrame(board.filename))
    header.append(title, focus)

    const surface = document.createElement('div')
    surface.className = 'frame-surface'
    const viewport = document.createElement('div')
    viewport.className = 'viewport'
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-scripts')
    viewport.append(iframe)

    const target = document.createElement('button')
    target.type = 'button'
    target.className = 'frame-target'
    target.addEventListener('click', (event) => {
      if (suppressClick && event.detail !== 0) return
      if (!placing) {
        selectFrame(board.filename)
        return
      }
      const bounds = surface.getBoundingClientRect()
      const x = event.detail === 0 ? 0.5 : clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
      const y = event.detail === 0 ? 0.5 : clamp((event.clientY - bounds.top) / bounds.height, 0, 1)
      pinComment(board.filename, x, y)
    })
    const pins = document.createElement('div')
    pins.className = 'pins'
    surface.append(viewport, target, pins)
    element.append(header, surface)
    world.append(element)
    return { element, header, title, focus, surface, iframe, target, pins, board: null, pinSignature: '' }
  }

  function layout() {
    if (!visible.length || !stage.clientWidth || !stage.clientHeight) return
    const design = mode === 'design'
    const positions = design ? visible : visible.map(board => ({ ...board, x: 0, y: 0 }))
    const width = stage.clientWidth
    const height = stage.clientHeight
    if (design) {
      if (!camera) {
        const left = Math.min(...positions.map(({ x }) => x))
        const top = Math.min(...positions.map(({ y }) => y))
        const contentWidth = Math.max(...positions.map((board) => board.x + board.width)) - left
        const contentHeight = Math.max(...positions.map((board) => board.y + board.height)) - top
        const topInset = width < 640 ? 108 : 78
        const availableHeight = Math.max(1, height - topInset - 24 - headerHeight)
        scale = clamp(Math.min((width - 48) / contentWidth, availableHeight / contentHeight), 0.001, 1)
        world.style.left = Math.round((width - contentWidth * scale) / 2 - left * scale) + 'px'
        world.style.top = Math.round(topInset + (availableHeight - contentHeight * scale) / 2 - top * scale) + 'px'
      } else {
        scale = camera.scale
        world.style.left = camera.x + 'px'
        world.style.top = camera.y + 'px'
      }
      world.style.width = '1px'
      world.style.height = '1px'
    } else {
      const board = positions[0]
      const inset = mode === 'focus' ? 24 : 0
      const availableWidth = width - inset * 2
      const heightFit = mode === 'focus' ? Math.max(1, height - 124) / board.height : Infinity
      scale = manualZoom ?? clamp(Math.min(availableWidth / board.width, heightFit), 0.001, 1)
      world.style.left = ''
      world.style.top = ''
      world.style.width = Math.ceil(board.width * scale) + 'px'
      world.style.height = Math.ceil(board.height * scale) + 'px'
    }
    for (const board of positions) {
      const card = cards.get(board.filename)
      card.element.style.left = Math.round(board.x * scale) + 'px'
      card.element.style.top = Math.round(board.y * scale) + 'px'
      card.element.style.width = Math.ceil(board.width * scale) + 'px'
      card.surface.style.height = Math.ceil(board.height * scale) + 'px'
      card.iframe.style.transform = 'scale(' + scale + ')'
    }
    zoomLabel.textContent = Math.round(scale * 100) + '%'
    zoomLabel.title = 'Fit to view · ' + Math.round(scale * 100) + '%'
  }

  function renderPins(card, comments, draft, activeComment) {
    const signature = JSON.stringify([comments.map(({ id, x, y, number }) => [id, x, y, number]), draft, activeComment])
    if (signature === card.pinSignature) return
    card.pinSignature = signature
    const pins = comments.map((comment) => {
      const pin = document.createElement('button')
      pin.type = 'button'
      pin.className = 'pin'
      pin.style.left = comment.x * 100 + '%'
      pin.style.top = comment.y * 100 + '%'
      pin.textContent = String(comment.number)
      pin.setAttribute('aria-label', 'Show comment ' + comment.number)
      pin.setAttribute('aria-pressed', String(comment.id === activeComment))
      pin.addEventListener('click', () => showComment(comment.id))
      return pin
    })
    if (draft) {
      const marker = document.createElement('span')
      marker.className = 'pin draft-pin'
      marker.style.left = draft.x * 100 + '%'
      marker.style.top = draft.y * 100 + '%'
      marker.textContent = '+'
      marker.setAttribute('aria-hidden', 'true')
      pins.push(marker)
    }
    card.pins.replaceChildren(...pins)
  }

  new ResizeObserver(layout).observe(stage)

  const fit = () => {
    camera = undefined
    manualZoom = undefined
    layout()
    stage.scrollTo(0, 0)
  }

  function zoomBy(factor, anchorX = stage.clientWidth / 2, anchorY = stage.clientHeight / 2) {
    if (!visible.length) return
    if (mode === 'design') {
      const next = clamp(scale * factor, 0.001, 3)
      camera = {
        x: anchorX - (anchorX - world.offsetLeft) * next / scale,
        y: anchorY - (anchorY - world.offsetTop) * next / scale,
        scale: next,
      }
      layout()
      return
    }
    const centerX = (stage.scrollLeft + anchorX - world.offsetLeft) / scale
    const centerY = (stage.scrollTop + anchorY - world.offsetTop) / scale
    manualZoom = clamp(scale * factor, 0.002, 3)
    layout()
    stage.scrollTo(world.offsetLeft + centerX * scale - anchorX, world.offsetTop + centerY * scale - anchorY)
  }

  stage.addEventListener('wheel', (event) => {
    const zooming = event.ctrlKey || event.metaKey
    if (!visible.length || (!zooming && mode !== 'design') || mode === 'single') return
    event.preventDefault()
    if (zooming) {
      const bounds = stage.getBoundingClientRect()
      if (event.deltaY) zoomBy(event.deltaY < 0 ? 1.2 : 1 / 1.2, event.clientX - bounds.left, event.clientY - bounds.top)
    } else {
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1
      camera = { x: world.offsetLeft - event.deltaX * units, y: world.offsetTop - event.deltaY * units, scale }
      layout()
    }
  }, { passive: false })

  stage.addEventListener('pointerdown', (event) => {
    if (mode !== 'design' || gesture || !visible.length || ![0, 1].includes(event.button)) return
    if (placing && event.button === 0) return
    if (event.target.closest('.frame-focus, .pin')) return
    suppressClick = false
    if (event.button === 1) event.preventDefault()
    // Keep a click on its original button, even when it can also start a pan.
    const capture = event.target.closest('.frame-title, .frame-target') ?? stage
    capture.setPointerCapture(event.pointerId)
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      camera: { x: world.offsetLeft, y: world.offsetTop, scale },
      dragged: false,
    }
  })

  stage.addEventListener('pointermove', (event) => {
    if (gesture?.pointerId !== event.pointerId) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (!gesture.dragged && Math.hypot(dx, dy) < 4) return
    gesture.dragged = true
    stage.dataset.dragging = 'true'
    const start = gesture.camera
    camera = { x: start.x + dx, y: start.y + dy, scale: start.scale }
    layout()
  })

  function finishGesture(event) {
    if (gesture?.pointerId !== event.pointerId) return
    const { dragged } = gesture
    gesture = undefined
    stage.dataset.dragging = 'false'
    if (!dragged) return
    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(event, finishGesture)

  return {
    fit,
    zoomBy,
    camera: () => camera,
    restoreCamera(previous) {
      camera = previous
      manualZoom = undefined
      layout()
      stage.scrollTo(0, 0)
    },
    revealFrame(filename) {
      const card = cards.get(filename)
      if (!card) return
      if (mode !== 'design') {
        card.surface.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        return
      }
      const { x, y, width, height } = card.board
      const topInset = stage.clientWidth < 640 ? 108 : 78
      const available = Math.max(1, stage.clientHeight - topInset - headerHeight - 24)
      const next = clamp(Math.min((stage.clientWidth - 48) / width, available / height), 0.001, 1)
      camera = {
        x: (stage.clientWidth - width * next) / 2 - x * next,
        y: topInset + (available - height * next) / 2 - y * next,
        scale: next,
      }
      layout()
    },
    refresh() {
      for (const card of cards.values()) reload(card)
    },
    update({ boards, mode: nextMode, selected, comments, commentMode, draft, activeComment }) {
      visible = boards
      mode = nextMode
      placing = commentMode
      stage.dataset.mode = mode
      stage.dataset.commenting = String(placing)
      const filenames = new Set(boards.map(({ filename }) => filename))
      for (const [filename, card] of cards) {
        if (filenames.has(filename)) continue
        card.element.remove()
        cards.delete(filename)
      }
      for (const board of boards) {
        const card = cards.get(board.filename) ?? createCard(board)
        cards.set(board.filename, card)
        const changed = card.board?.previewRevision !== board.previewRevision
        card.board = board
        if (changed) {
          card.title.textContent = board.title
          card.title.title = 'Click to select · Drag to pan'
          card.iframe.title = board.title
          card.iframe.width = board.width
          card.iframe.height = board.height
          reload(card)
        }
        card.header.hidden = mode !== 'design'
        const isSelected = board.filename === selected
        const clickToSelect = mode === 'design' && !isSelected
        card.title.setAttribute('aria-pressed', String(isSelected))
        card.focus.hidden = !isSelected || placing
        card.element.dataset.selected = String(isSelected)
        card.target.hidden = placing ? Boolean(draft) : !clickToSelect
        card.target.tabIndex = placing ? 0 : -1
        card.iframe.tabIndex = placing || clickToSelect ? -1 : 0
        card.target.setAttribute('aria-label', (placing ? 'Add comment to ' : 'Select ') + board.title)
        renderPins(card, comments.filter(({ filename }) => filename === board.filename),
          draft?.filename === board.filename ? draft : null, activeComment)
      }
      world.hidden = !boards.length
      empty.hidden = Boolean(boards.length)
      layout()
    },
  }
}
