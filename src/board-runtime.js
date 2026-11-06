(() => {
  const board = JSON.parse(document.querySelector('#board-input').textContent)
  const root = document.querySelector('#board-root')
  const template = document.createElement('template')
  template.innerHTML = board.html

  for (const helmet of template.content.querySelectorAll('helmet, sc-helmet')) {
    for (const style of helmet.querySelectorAll('style')) document.head.append(style.cloneNode(true))
    helmet.remove()
  }

  function lookup(expression, scope) {
    const key = expression.trim()
    if (key === 'true' || key === 'false') return key === 'true'
    if (key === 'null') return null
    if (/^-?\d+(?:\.\d+)?$/.test(key)) return Number(key)
    if (!/^[\w$]+(?:\.[\w$]+)*$/.test(key)) return undefined
    return key.split('.').reduce((value, part) => {
      return value != null && Object.hasOwn(value, part) ? value[part] : undefined
    }, scope)
  }

  function bind(value, scope) {
    const whole = /^\s*\{\{([^{}]+)\}\}\s*$/.exec(value)
    if (whole) return lookup(whole[1], scope)
    return value.replace(/\{\{([^{}]+)\}\}/g, (_, name) => lookup(name, scope) ?? '')
  }

  function renderChildren(source, destination, scope) {
    for (const child of source.childNodes) renderNode(child, destination, scope)
  }

  const blocked = new Set(['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link'])
  const booleanAttributes = new Set(['checked', 'disabled', 'multiple', 'selected', 'hidden', 'readonly', 'required', 'open'])

  function renderNode(source, destination, scope) {
    if (source.nodeType === Node.TEXT_NODE) {
      destination.append(document.createTextNode(String(bind(source.textContent, scope) ?? '')))
      return
    }
    if (source.nodeType !== Node.ELEMENT_NODE || blocked.has(source.localName)) return
    if (source.localName === 'sc-if') {
      if (bind(source.getAttribute('value') ?? '', scope)) renderChildren(source, destination, scope)
      return
    }
    if (source.localName === 'sc-for') {
      const items = bind(source.getAttribute('list') ?? '', scope)
      const alias = source.getAttribute('as') || 'item'
      if (Array.isArray(items)) {
        items.forEach((item, index) => renderChildren(source, destination, { ...scope, [alias]: item, $index: index }))
      }
      return
    }

    const element = document.createElementNS(source.namespaceURI, source.localName)
    for (const attribute of source.attributes) {
      const { name } = attribute
      const value = bind(attribute.value, scope)
      const event = /^(?:sc-camel-)?on-?([a-z-]+)$/i.exec(name)
      if (event) {
        if (typeof value === 'function') {
          const eventName = event[1].replaceAll('-', '').toLowerCase()
          const textInput = element.localName === 'textarea'
            || (element.localName === 'input' && !['checkbox', 'radio', 'file'].includes(source.type))
          element.addEventListener(eventName === 'change' && textInput ? 'input' : eventName, (eventObject) => {
            try {
              Promise.resolve(value.call(logic, eventObject)).catch(showError)
            } catch (error) {
              showError(error)
            }
          })
        }
        continue
      }
      if (value == null || (value === false && booleanAttributes.has(name))) continue
      if (typeof value === 'function' || typeof value === 'object') continue
      if (attribute.namespaceURI) element.setAttributeNS(attribute.namespaceURI, name, String(value))
      else element.setAttribute(name, value === true && booleanAttributes.has(name) ? '' : String(value))
    }
    renderChildren(source, element, scope)
    destination.append(element)
  }

  function showError(error) {
    document.querySelector('#board-error').hidden = false
    document.querySelector('#board-error').textContent = error.message ?? String(error)
  }

  let logic
  let queued = false
  let didMount = false

  function render() {
    const scope = { ...logic.props, ...logic.renderVals() }
    const fragment = document.createDocumentFragment()
    renderChildren(template.content, fragment, scope)
    // Recreating the template should keep keyboard focus in the same control.
    const selector = 'button, input, textarea, select, a[href], [tabindex]'
    const active = document.activeElement
    const focusIndex = [...root.querySelectorAll(selector)].indexOf(active)
    const selection = focusIndex >= 0 ? [active.selectionStart, active.selectionEnd] : []
    root.replaceChildren(fragment)
    if (focusIndex >= 0) {
      const replacement = root.querySelectorAll(selector)[focusIndex]
      replacement?.focus({ preventScroll: true })
      if (selection[0] != null) replacement?.setSelectionRange?.(...selection)
    }
  }

  class DCLogic {
    state = {}

    constructor(props) {
      this.props = props
    }

    setState(update, callback) {
      const changes = typeof update === 'function' ? update(this.state, this.props) : update
      this.state = { ...this.state, ...changes }
      this.forceUpdate()
      if (typeof callback === 'function') queueMicrotask(() => callback.call(this))
    }

    forceUpdate() {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        try {
          render()
          if (didMount) this.componentDidUpdate?.()
        } catch (error) {
          showError(error)
        }
      })
    }

    renderVals() {
      return {}
    }
  }

  try {
    const props = Object.fromEntries(Object.entries(board.props)
      .filter(([name]) => !name.startsWith('$'))
      .map(([name, definition]) => [name, definition?.default]))
    const Component = new Function('DCLogic', board.js + '\nreturn typeof Component === "undefined" ? DCLogic : Component')(DCLogic)
    logic = new Component(props)
    render()
    didMount = true
    logic.componentDidMount?.()
    window.addEventListener('pagehide', () => logic.componentWillUnmount?.(), { once: true })
  } catch (error) {
    showError(error)
  }
})()
