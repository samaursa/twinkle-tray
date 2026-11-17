const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/modules/win32-displayconfig/index.js'), 'utf8')

function setup(initial) {
  const errors = []
  const exports = {}
  // Leave native startup enumeration pending; feed configurations through the
  // constructor's registered production callback without loading Windows DLLs.
  vm.runInNewContext(source, {
    module: { exports },
    require(name) {
      assert.equal(name, 'bindings')
      return () => ({ win32_queryDisplayConfig: () => true })
    },
    console: { error: (...args) => errors.push(args) }
  })
  let callback
  let removed
  exports.addDisplayChangeListener = listener => {
    callback = listener
    if (initial) listener(...initial)
    return listener
  }
  exports.removeDisplayChangeListener = listener => { removed = listener }
  const context = new exports.VerticalRefreshRateContext()
  return { context, errors, emit: (...args) => callback(...args),
    wasRemoved: () => removed === callback }
}

function display(rate = { Numerator: 144000, Denominator: 1000 }, x = 0) {
  return {
    inUse: true,
    sourceMode: { width: 1920, height: 1080, position: { x, y: -100 } },
    targetVideoSignalInfo: { vSyncFreq: rate }
  }
}

test('mixed null and malformed displays retain valid geometry and resolve readiness', async () => {
  const valid = display()
  const malformed = [null, undefined, {}, { inUse: true, sourceMode: null },
    { inUse: true, sourceMode: {} },
    { ...valid, sourceMode: { ...valid.sourceMode, width: NaN } },
    { ...valid, sourceMode: { ...valid.sourceMode, height: -1 } },
    { ...valid, sourceMode: { ...valid.sourceMode, position: { x: 0 } } },
    { ...valid, sourceMode: { ...valid.sourceMode, width: '1920' } }]
  const { context, emit, errors } = setup()
  const pendingRate = context.findVerticalRefreshRateForDisplayPoint(100, 0)
  emit(null, [valid, ...malformed, display(undefined, 1920)])
  assert.equal(await pendingRate, 144)
  assert.equal(context.geometry.length, 2)
  assert.equal(errors.length, 0)
  assert.equal(await context.findVerticalRefreshRateForDisplayPoint(-1, 0), undefined)
  assert.equal(await context.findVerticalRefreshRateForDisplayPoint(3840, 0), undefined)
  assert.equal(await context.findVerticalRefreshRateForDisplayPoint(10, 980), undefined)
  context.close()
})

test('missing target data and invalid refresh fractions use the approved 60Hz fallback', async () => {
  const brokenRates = [null, undefined, {}, { Numerator: 0, Denominator: 1 },
    { Numerator: 1, Denominator: 0 }, { Numerator: NaN, Denominator: 1 },
    { Numerator: 60, Denominator: Infinity }, { Numerator: -1, Denominator: 1 },
    { Numerator: '60', Denominator: 1 }, { Numerator: 60n, Denominator: 1 },
    { Numerator: Number.MAX_VALUE, Denominator: Number.MIN_VALUE }]
  const { context, emit, errors } = setup()
  for (const target of [null, undefined, {}, ...brokenRates.map(vSyncFreq => ({ vSyncFreq }))]) {
    emit(null, [{ ...display(), targetVideoSignalInfo: target }])
    assert.equal(await context.findVerticalRefreshRateForDisplayPoint(0, 0), 60)
  }
  assert.equal(errors.length, 0)
  context.close()
})

test('valid overlapping displays keep the minimum fractional rate and update on callbacks', async () => {
  const { context, emit } = setup([null, [display(), display({ Numerator: 60000, Denominator: 1001 })]])
  assert.equal(await context.findVerticalRefreshRateForDisplayPoint(0, 0), 60000 / 1001)
  emit(null, [display({ Numerator: 240, Denominator: 1 }), { ...display(), inUse: false }])
  assert.equal(await context.findVerticalRefreshRateForDisplayPoint(0, 0), 240)
  context.close()
})

test('malformed configuration and native callback errors resolve readiness and clear stale geometry', async () => {
  for (const args of [[null, undefined], [null, null], [null, {}], [new Error('native failure')]]) {
    const { context, emit } = setup(args)
    assert.equal(await context.findVerticalRefreshRateForDisplayPoint(0, 0), undefined)
    emit(null, [display()])
    assert.equal(await context.findVerticalRefreshRateForDisplayPoint(0, 0), 144)
    emit(...args)
    assert.equal(await context.findVerticalRefreshRateForDisplayPoint(0, 0), undefined)
    context.close()
  }
})

test('unexpected callback exceptions resolve readiness and retain the last complete geometry', async () => {
  const badDisplay = { get inUse() { throw new Error('bad descriptor') } }
  const { context, emit, errors } = setup([null, [badDisplay]])
  assert.equal(await context.findVerticalRefreshRateForDisplayPoint(0, 0), undefined)
  emit(null, [display()])
  emit(null, [badDisplay])
  assert.equal(await context.findVerticalRefreshRateForDisplayPoint(0, 0), 144)
  assert.equal(errors.length, 2)
  context.close()
})

test('closing before the first configuration settles pending queries and deregisters the callback', async () => {
  const { context, wasRemoved } = setup()
  const pending = context.findVerticalRefreshRateForDisplayPoint(0, 0)
  context.close()
  assert.equal(await pending, undefined)
  assert.equal(wasRemoved(), true)
})
