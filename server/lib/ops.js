/**
 * Deck mutation as a log of operations.
 *
 * The alternative — asking the model to return a whole revised deck on each
 * chat message — costs ~1,300 output tokens (minutes on CPU-only inference) and
 * risks silently rewriting slides nobody mentioned. Ops are ~50 tokens, apply
 * deterministically, and leave untouched content provably untouched.
 *
 * Every op carries a computed inverse, so undo is exact rather than a re-run.
 */

const unescape = k => k.replace(/~1/g, '/').replace(/~0/g, '~')

function parsePointer(pointer) {
  if (typeof pointer !== 'string' || (pointer && !pointer.startsWith('/'))) {
    throw new Error(`Invalid JSON Pointer: ${JSON.stringify(pointer)}`)
  }
  return pointer === '' || pointer === '/' ? [] : pointer.split('/').slice(1).map(unescape)
}

/** Walks to the parent container of `pointer`, returning [parent, lastKey]. */
function resolveParent(root, pointer) {
  const parts = parsePointer(pointer)
  if (!parts.length) throw new Error('Cannot operate on the deck root')
  let cur = root
  for (const key of parts.slice(0, -1)) {
    const next = Array.isArray(cur) ? cur[Number(key)] : cur?.[key]
    if (next == null) throw new Error(`Path does not exist: ${pointer}`)
    cur = next
  }
  return [cur, parts[parts.length - 1]]
}

export function getAt(root, pointer) {
  const parts = parsePointer(pointer)
  let cur = root
  for (const key of parts) {
    if (cur == null) return undefined
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key]
  }
  return cur
}

const clone = v => (v === undefined ? undefined : structuredClone(v))

/**
 * Applies one op in place and returns its inverse.
 * Ops: replace | remove | insert | move
 */
function applyOne(deck, op) {
  const [parent, key] = resolveParent(deck, op.path)
  const isArr = Array.isArray(parent)
  const idx = isArr ? (key === '-' ? parent.length : Number(key)) : null

  if (isArr && key !== '-' && (!Number.isInteger(idx) || idx < 0)) {
    throw new Error(`Array index must be a non-negative integer: ${op.path}`)
  }

  switch (op.op) {
    case 'replace': {
      const prev = isArr ? parent[idx] : parent[key]
      if (prev === undefined) throw new Error(`Cannot replace a path that does not exist: ${op.path}`)
      if (op.value === undefined) throw new Error(`replace requires a value: ${op.path}`)
      if (isArr) parent[idx] = op.value; else parent[key] = op.value
      return { op: 'replace', path: op.path, value: clone(prev) }
    }

    case 'remove': {
      if (isArr) {
        if (idx >= parent.length) throw new Error(`Index out of range: ${op.path}`)
        const [prev] = parent.splice(idx, 1)
        return { op: 'insert', path: op.path, value: clone(prev) }
      }
      if (!(key in parent)) throw new Error(`Cannot remove a path that does not exist: ${op.path}`)
      const prev = parent[key]
      delete parent[key]
      // `insert`, not `replace`: the key is gone, and replace refuses a path
      // that does not exist. Recording replace here made undo throw for every
      // removal of an object property — a key stat, a subtitle, a visual, a
      // style — so the change could be made but never taken back.
      return { op: 'insert', path: op.path, value: clone(prev) }
    }

    case 'insert': {
      if (op.value === undefined) throw new Error(`insert requires a value: ${op.path}`)
      if (isArr) {
        // idx === length is a valid append; beyond that the caller is confused,
        // and clamping would record an inverse that cannot be replayed.
        if (idx > parent.length) {
          throw new Error(`Index ${idx} is past the end of a ${parent.length}-item list: ${op.path}`)
        }
        parent.splice(idx, 0, op.value)
        // The inverse names the index the item actually landed at, never "-".
        // An append records path ".../-", and "-" resolves to the END of the
        // list — so the inverse of every append was a remove one past the last
        // item, and undoing an added bullet threw instead of removing it.
        const at = op.path.replace(/\/-$/, `/${idx}`)
        return { op: 'remove', path: at }
      }
      const existed = key in parent
      const prev = parent[key]
      parent[key] = op.value
      return existed ? { op: 'replace', path: op.path, value: clone(prev) } : { op: 'remove', path: op.path }
    }

    case 'move': {
      const value = clone(getAt(deck, op.from))
      if (value === undefined) throw new Error(`move source does not exist: ${op.from}`)
      if (op.from === op.path) return { op: 'move', from: op.path, path: op.from }  // no-op

      applyOne(deck, { op: 'remove', path: op.from })
      try {
        applyOne(deck, { op: 'insert', path: op.path, value })
      } catch (err) {
        applyOne(deck, { op: 'insert', path: op.from, value })   // put it back
        throw err
      }
      return { op: 'move', from: op.path, path: op.from }
    }

    default:
      throw new Error(`Unknown op "${op.op}" (expected replace, remove, insert or move)`)
  }
}

/**
 * Applies ops to a COPY of the deck. All-or-nothing: if any op fails the
 * original is untouched and the error names the offending path, which the chat
 * surfaces so the user can retry rather than silently getting a half-edit.
 */
export function applyOps(deck, ops) {
  if (!Array.isArray(ops)) throw new Error('ops must be an array')
  const next = structuredClone(deck)
  const inverse = []
  for (const [i, op] of ops.entries()) {
    try { inverse.unshift(applyOne(next, op)) }
    catch (err) { throw new Error(`op ${i + 1}/${ops.length} (${op.op} ${op.path}): ${err.message}`) }
  }
  return { deck: next, inverse }
}

const shapeOf = v =>
  v === null || v === undefined ? 'empty' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : 'primitive'

/**
 * A replacement must keep the node's shape.
 *
 * Path-existence alone is not enough: a model asked to "make these bullets
 * punchier" will cheerfully replace a whole solution OBJECT with a bare string.
 * That passes an existence check, then breaks the renderer downstream, so the
 * shape is checked here where it can still be rejected cleanly.
 */
function assertShapeCompatible(deck, op) {
  if (op.op !== 'replace' && op.op !== 'insert') return
  const current = getAt(deck, op.path)
  if (current === undefined) return                 // insert of something new
  const want = shapeOf(current), got = shapeOf(op.value)
  if (want === 'empty' || got === 'empty') return   // nulling a section is legitimate
  if (want !== got) {
    throw new Error(`${op.path} holds ${want === 'primitive' ? 'text' : `an ${want}`}, but the change supplies ${got === 'primitive' ? 'text' : `an ${got}`}`)
  }
  // For objects, keep the keys the renderer depends on.
  if (want === 'object') {
    const missing = Object.keys(current).filter(k => !k.startsWith('_') && !(k in (op.value || {})))
    if (missing.length) throw new Error(`${op.path} would lose required field(s): ${missing.join(', ')}`)
  }
}

/**
 * Drops ops with bad paths or incompatible values instead of failing the whole
 * batch — one hallucinated op should not discard the good ones alongside it.
 */
export function filterValidOps(deck, ops) {
  const valid = [], rejected = []
  for (const op of ops) {
    try {
      assertShapeCompatible(deck, op)
      const probe = structuredClone(deck)
      applyOne(probe, op)
      valid.push(op)
    } catch (err) { rejected.push({ op, reason: err.message }) }
  }
  return { valid, rejected }
}

/** Human-readable op summary for the chat transcript. */
export function describeOp(op) {
  const where = (op.path || '').replace(/^\//, '').replace(/\//g, ' › ')
  switch (op.op) {
    case 'replace': return `updated ${where}`
    case 'remove':  return `removed ${where}`
    case 'insert':  return `added ${where}`
    case 'move':    return `moved ${(op.from || '').replace(/^\//, '')} → ${where}`
    default:        return `${op.op} ${where}`
  }
}
