const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

const source = fs.readFileSync(path.join(root, 'src/electron.js'), 'utf8')
const ast = require('@babel/parser').parse(source, { sourceType: 'script', allowReturnOutsideFunction: true })
const names = [
  'updateBrightnessThrottle', 'flushBrightnessThrottle', 'applyLinkedFeatures',
  'updateBrightness', 'normalizeBrightness', 'transitionBrightness', 'stopBrightnessTransition',
  'hasRecentlyInteracted', 'brightnessInteractionVersion', 'setRecentlyInteracted', 'idleCheckShort',
  'currentTransition', 'brightnessThrottleTargets', 'idleInteractionVersion'
]
const declarations = ast.program.body.filter(node =>
  names.includes(node.id?.name || node.declarations?.[0]?.id?.name)
)

function setup() {
  let now = 1000
  let nextId = 0
  const timers = new Map()
  const schedule = (callback, delay, repeat = false) => {
    const id = ++nextId
    timers.set(id, { callback, delay, due: now + delay, repeat })
    return id
  }
  const clear = id => timers.delete(id)
  const tick = ms => {
    const end = now + ms
    while (true) {
      const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0]
      if (!next || next[1].due > end) break
      const [id, timer] = next
      now = timer.due
      if (timer.repeat) timer.due += timer.delay
      else clear(id)
      timer.callback()
    }
    now = end
  }
  const monitors = Object.fromEntries(['ONE', 'TWO'].map(key => [key, {
    id: 'DISPLAY#TEST#' + key, key, hwid: ['DISPLAY', 'TEST', key],
    type: 'ddcci', brightness: 20, min: 0, max: 100, features: { '0x12': [20, 100] }
  }]))
  const messages = []
  const context = vm.createContext({
    monitors, Date: { now: () => now },
    setTimeout: schedule, clearTimeout: clear,
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: clear,
    settings: {
      updateInterval: 100,
      monitorFeaturesSettings: { TEST: { '0x12': { linked: true } } },
      monitorFeatures: { TEST: { '0x12': true } }
    },
    monitorsThread: { send: message => messages.push(message) },
    shouldSkipDisplay: () => false, usesExtendedMinimum: () => false, usesGammaSlider: () => false,
    Utils: require('../src/Utils'), isWindowsUserIdle: false, recentlyWokeUp: false,
    setTrayPercent() {}, updateKnownDisplays() {}, sendToAllWindows() {},
    console: { log() {}, error(error) { throw error } },
    debug: { error(label, error) { throw error } }
  })
  vm.runInContext(declarations.map(node => source.slice(node.start, node.end)).join('\n'), context)
  return { context, monitors, messages, tick }
}

test('linked contrast does not cancel a two-monitor brightness fade', () => {
  const { context, monitors, messages, tick } = setup()
  context.updateBrightnessThrottle(monitors.ONE.id, 20, false, false, '0x12')
  tick(50)
  context.transitionBrightness(23)
  for (let i = 0; i < 4; i++) tick(100)
  for (const monitor of Object.values(monitors)) {
    assert.equal(monitor.brightness, 23)
    assert.equal(monitor.features['0x12'][0], 23)
    assert.equal(messages.filter(message => message.id === monitor.id).length, 3)
  }
})

test('explicit profile targets do not depend on time-of-day settings', () => {
  const { context, monitors, tick } = setup()
  context.transitionBrightness(undefined, { [monitors.ONE.id]: 24 }, 2, true)
  for (let i = 0; i < 3; i++) tick(100)
  assert.equal(monitors.ONE.brightness, 24)
  assert.equal(monitors.TWO.brightness, 20)
})

test('wake cancels the interval before it can emit another dimming step', () => {
  const { context, messages, tick } = setup()
  context.transitionBrightness(0)
  context.recentlyWokeUp = true
  tick(100)
  assert.equal(messages.length, 0)
  assert.equal(vm.runInContext('currentTransition', context), null)
})

test('an adjustment after wake takes precedence over the delayed idle restore', () => {
  const { context, tick } = setup()
  let restores = 0
  let saves = 0
  context.settings.detectIdleTimeEnabled = true
  Object.assign(context, {
    isUserIdle: true, userIdleDimmed: true, lastIdleTime: 60,
    powerMonitor: { getSystemIdleTime: () => 0 }, getIdleSettingValue: () => 30,
    notIdleMonitor: false, idleMonitorBlock: null,
    blockBadDisplays: () => ({ release() {} }),
    setKnownBrightness: () => { restores++ }, updateKnownDisplays: () => { saves++ },
    applyCurrentAdjustmentEvent() {}
  })
  context.idleCheckShort()
  assert.equal(restores, 1)
  context.setRecentlyInteracted(true)
  tick(4000)
  assert.equal(restores, 1)
  assert.equal(saves, 1)
  assert.equal(context.isUserIdle, false)
})

test('rapid slider changes retain the latest value independently per monitor', () => {
  const { context, monitors, messages, tick } = setup()
  context.updateBrightnessThrottle(monitors.ONE.id, 30, true, false)
  tick(10)
  context.updateBrightnessThrottle(monitors.TWO.id, 50, true, false)
  context.updateBrightnessThrottle(monitors.ONE.id, 31, true, false)
  context.updateBrightnessThrottle(monitors.ONE.id, 32, true, false)
  context.updateBrightnessThrottle(monitors.TWO.id, 51, true, false)
  tick(100)
  for (const [monitor, levels] of [[monitors.ONE, [30, 32]], [monitors.TWO, [50, 51]]]) {
    assert.deepEqual(messages.filter(message => message.id === monitor.id).map(message => message.brightness), levels)
  }
})

test('a newer direct brightness update supersedes a queued slider value', () => {
  const { context, monitors, messages, tick } = setup()
  context.updateBrightnessThrottle(monitors.ONE.id, 30, true, false)
  context.updateBrightnessThrottle(monitors.ONE.id, 31, true, false)
  context.updateBrightness(monitors.ONE.id, 40)
  tick(100)
  assert.deepEqual(messages.filter(message => message.id === monitors.ONE.id).map(message => message.brightness), [30, 40])
  assert.equal(monitors.ONE.features['0x12'][0], 40)
})

test('a queued independent VCP write cannot cancel a newer fade', () => {
  const { context, monitors, tick } = setup()
  context.settings.monitorFeaturesSettings.TEST['0x12'].linked = false
  context.updateBrightnessThrottle(monitors.ONE.id, 40, false, false, 0x12)
  context.updateBrightnessThrottle(monitors.ONE.id, 42, false, false, 0x12)
  context.transitionBrightness(24)
  tick(500)
  assert.equal(monitors.ONE.features['0x12'][0], 42)
  assert.equal(monitors.ONE.brightness, 24)
  assert.equal(monitors.TWO.brightness, 24)
})

test('moving an unlinked flyout slider sends only that monitor before the panel can close', () => {
  const panel = fs.readFileSync(path.join(root, 'src/components/BrightnessPanel.jsx'), 'utf8')
  const tree = require('@babel/parser').parse(panel, { sourceType: 'module', plugins: ['jsx'] })
  const component = tree.program.body.find(node => node.declarations?.[0]?.id.name === 'BrightnessPanel')
  const handler = component.declarations[0].init.arguments[0].body.body
    .find(node => node.declarations?.[0]?.id.name === 'handleChange')
  const events = []
  const monitor = { id: 'DISPLAY#TEST#ONE', brightness: 20 }
  const state = { monitors: { ONE: monitor, TWO: { id: 'DISPLAY#TEST#TWO', brightness: 50 } } }
  const context = vm.createContext({
    state, numMonitors: 2, isAdjustableDisplay: () => true,
    setState: update => Object.assign(state, update(state)),
    window: {
      pauseMonitorUpdates: () => events.push('pause'),
      updateBrightness: (id, level) => events.push([id, level])
    }
  })
  vm.runInContext(panel.slice(handler.start, handler.end) + '\nhandleChange(37, { props: { hwid: "ONE" } })', context)
  assert.deepEqual(events, ['pause', [monitor.id, 37]])
  assert.equal(state.monitors.ONE.brightness, 37)
  assert.equal(state.monitors.TWO.brightness, 50)
  assert.equal(monitor.brightness, 20)
})


test('a shortcut keeps its explicit contrast after a throttled brightness action', async () => {
  const { context, monitors, tick } = setup()
  const state = {
    lastRefreshMonitors: 1000, hotkeyThrottle: [], doingHotkey: false, hotkeyCycleIndexes: [],
    minMax: value => Math.max(0, Math.min(100, value)), pauseMonitorUpdates() {},
    panelState: 'visible'
  }
  Object.assign(context, state)
  const hotkeyDeclarations = ast.program.body.filter(node =>
    ['doHotkey', 'getHotkeyLinkedFeatureOverrides'].includes(node.id?.name)
  )
  vm.runInContext(hotkeyDeclarations.map(node => source.slice(node.start, node.end)).join('\n'), context)
  context.settings.monitorFeaturesSettings.TEST['0x12'] = { linked: true, max: 50, min: 0, maxVisual: 50 }
  context.updateBrightnessThrottle(monitors.ONE.id, 20, true, false)
  tick(10)
  await context.doHotkey({
    id: 'shortcut',
    actions: [
      { type: 'set', target: 'brightness', allMonitors: true, value: '10' },
      { type: 'set', target: 'contrast', allMonitors: true, value: '50' }
    ]
  })
  tick(400)
  for (const monitor of Object.values(monitors)) {
    assert.equal(monitor.brightness, 10)
    assert.equal(monitor.features['0x12'][0], 25)
  }
})

test('a shortcut that wakes the idle monitor also wins over the first restore', () => {
  const { context, tick } = setup()
  let restores = 0
  let saves = 0
  context.settings.detectIdleTimeEnabled = true
  Object.assign(context, {
    isUserIdle: true, userIdleDimmed: true, lastIdleTime: 60,
    powerMonitor: { getSystemIdleTime: () => 0 }, getIdleSettingValue: () => 30,
    notIdleMonitor: false, idleMonitorBlock: null,
    blockBadDisplays: () => ({ release() {} }),
    setKnownBrightness: () => { restores++ }, updateKnownDisplays: () => { saves++ },
    applyCurrentAdjustmentEvent() {}
  })
  context.setRecentlyInteracted(true)
  context.idleCheckShort()
  assert.equal(restores, 0)
  tick(4000)
  assert.equal(restores, 0)
  assert.equal(saves, 1)
  assert.equal(context.isUserIdle, false)
})
