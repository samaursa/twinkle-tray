const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../src/Monitors.js'), 'utf8')
const ast = require('@babel/parser').parse(source, { sourceType: 'script' })
const names = ['handleMonitorMessage', 'setBrightness', 'setVCP', 'setHighLevelBrightness',
  'waitForDDCWrite', 'lastDDCWrite', 'queueMonitorMessage', 'monitorMessageQueue', 'pendingMonitorWrites']
const declarations = ast.program.body.filter(node => names.includes(node.id?.name || node.declarations?.[0]?.id?.name))
function setup() {
  let now = 1000
  const calls = []
  const errors = []
  const id = 'DISPLAY#TEST#ONE'
  const monitor = { id, hwid: id.split('#'), type: 'ddcci', brightness: 20, brightnessMax: 100,
    brightnessType: 0x10, highLevelSupported: { brightness: true }, features: { '0x12': [25, 100] } }
  const record = (id, code, value) => { calls.push({ id, code, value, time: now }) }
  const context = vm.createContext({
    performance: { now: () => now }, wait: async ms => { now += ms },
    isDDCBlocked: () => false, busyLevel: 0,
    ddcci: { _setVCP: record, _setHighLevelBrightness: (id, value) => record(id, 0x10, value) },
    monitors: { ONE: monitor }, settings: {}, ddcBrightnessVCPs: {}, vcpCache: {},
    vcpStr: code => '0x' + Number(code).toString(16).toUpperCase(),
    saveFeatureSnapshot() {}, classifyDDCError: error => error.message,
    console: { log: (...args) => errors.push(args) }
  })
  vm.runInContext(declarations.map(node => source.slice(node.start, node.end)).join('\n'), context)
  return { context, monitor, calls, errors }
}

test('hardware and VCP writes share a per-monitor completion cooldown', async () => {
  const { context, monitor, calls } = setup()
  await context.handleMonitorMessage({ type: 'brightness', id: monitor.id, brightness: 30 })
  await context.handleMonitorMessage({ type: 'vcp', monitor: monitor.id, code: 0x12, value: 25 })
  assert.equal(calls.length, 2)
  assert.ok(calls[1].time - calls[0].time >= 100)
  assert.equal(monitor.brightness, 30)
  await context.setVCP('DISPLAY#TEST#TWO', 0x12, 25)
  assert.equal(calls[2].time, calls[1].time)
})

test('failed writes retain recovery time and do not update tracked values', async () => {
  const { context, monitor, calls } = setup()
  context.ddcci._setVCP = () => { throw new Error('device failed') }
  const result = await context.setVCP(monitor.id, 0x12, 50)
  assert.equal(result, false)
  assert.equal(monitor.features['0x12'][0], 25)
  context.ddcci._setVCP = (id, code, value) => calls.push({ id, code, value, time: context.performance.now() })
  await context.setVCP(monitor.id, 0x12, 40)
  assert.equal(calls[0].time, 1100)
  assert.equal(monitor.features['0x12'][0], 40)
})

test('queued fades coalesce to the latest value without crossing refresh or discrete commands', async () => {
  const { context } = setup()
  const handled = []
  let release
  const started = new Promise(resolve => { release = resolve })
  context.handleMonitorMessage = async message => {
    handled.push(message)
    if (handled.length === 1) await started
  }
  const brightness = value => ({ type: 'brightness', id: 'ONE', brightness: value })
  const vcp = (code, value) => ({ type: 'vcp', monitor: 'ONE', code, value })
  context.queueMonitorMessage(brightness(1))
  await Promise.resolve()
  context.queueMonitorMessage(brightness(2))
  context.queueMonitorMessage(brightness(3))
  context.queueMonitorMessage(vcp(0x12, 10))
  context.queueMonitorMessage(vcp(0x12, 20))
  context.queueMonitorMessage({ type: 'refreshMonitors' })
  context.queueMonitorMessage(brightness(4))
  context.queueMonitorMessage(vcp(0x60, 15))
  context.queueMonitorMessage(vcp(0x60, 17))
  const done = context.queueMonitorMessage(brightness(5))
  release()
  await done
  assert.deepEqual(handled, [brightness(1), brightness(3), vcp(0x12, 20),
    { type: 'refreshMonitors' }, brightness(4), vcp(0x60, 15), vcp(0x60, 17), brightness(5)])
})

test('the message queue awaits a paced brightness write before accepting a contrast write', async () => {
  const { context, monitor, calls } = setup()
  context.queueMonitorMessage({ type: 'brightness', id: monitor.id, brightness: 30 })
  const done = context.queueMonitorMessage({ type: 'vcp', monitor: monitor.id, code: 0x12, value: 25 })
  await done
  assert.equal(calls.length, 2)
  assert.ok(calls[1].time - calls[0].time >= 100)
})
