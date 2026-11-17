const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../src/electron.js'), 'utf8')
const ast = require('@babel/parser').parse(source, { sourceType: 'script', allowReturnOutsideFunction: true })
const names = ['idleContrastSession', 'captureIdleContrast', 'idleOwnsContrast', 'finishIdleContrastRestore', 'deferFeatureUpdate', 'deferLinkedFeatureUpdate', 'flushDeferredFeatureUpdates', 'writeIdleContrast', 'restoreIdleContrast', 'recordIdleAdjustment',
  'handleCommandLine', 'applyProfileBrightness', 'startIdleCheckShort', 'idleCheckShort', 'getIdleSettingValue', 'applyLinkedFeatures', 'updateBrightness',
  'updateBrightnessThrottle', 'flushBrightnessThrottle', 'brightnessThrottleTargets', 'normalizeBrightness',
  'stopBrightnessTransition', 'currentTransition', 'transitionBrightness', 'hasEnabledLinkedFeaturesForMonitor',
  'hasRecentlyInteracted', 'setRecentlyInteracted', 'brightnessInteractionVersion', 'idleInteractionVersion']
const declarations = ast.program.body.filter(n => names.includes(n.id?.name || n.declarations?.[0]?.id?.name))
function setup() {
  let time = 1000, idle = 60, nextId = 0
  const timers = new Map(), messages = [], reads = []
  const schedule = (fn, delay, repeat = false) => {
    const id = ++nextId
    timers.set(id, { fn, delay, repeat, due: time + delay })
    return id
  }
  const tick = amount => {
    const end = time + amount
    while (true) {
      const next = [...timers].sort((a,b) => a[1].due - b[1].due)[0]
      if (!next || next[1].due > end) break
      time = next[1].due
      if (next[1].repeat) next[1].due += next[1].delay
      else timers.delete(next[0])
      next[1].fn()
    }
    time = end
  }
  const monitors = {}
  for (const [model, brightness, contrast] of [['LINK', 60, 40], ['FREE', 70, 33]]) {
    const id = 'DISPLAY#' + model + '#' + model
    monitors[model] = { id, key: model, hwid: id.split('#'), type: 'ddcci', brightness,
      min: 0, max: 100, features: { '0x12': [contrast, 100] } }
  }
  const context = vm.createContext({
    settings: { updateInterval: 100, detectIdleTimeEnabled: true, detectIdleTimeMinutes: 0,
      detectIdleTimeSeconds: 30, detectIdleContrastEnabled: true, detectIdleContrastLevel: 5,
      monitorFeatures: { LINK: { '0x12': true }, FREE: { '0x12': true } },
      monitorFeaturesSettings: { LINK: { '0x12': { linked: true, min: 0, max: 50, maxVisual: 50 } } } },
    monitors, Date: { now: () => time }, setTimeout: schedule, clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => timers.delete(id),
    isUserIdle: false, userIdleDimmed: false, isWindowsUserIdle: false, recentlyWokeUp: false,
    notIdleMonitor: false, lastIdleTime: 60, lastKnownDisplays: {}, preIdleMonitors: {}, monitorRefreshGeneration: 1,
    powerMonitor: { getSystemIdleTime: () => idle }, isFocusedWindowFullscreen: () => false, isMediaPlaying: () => false,
    blockBadDisplays: () => ({ release() {} }), idleMonitorBlock: null,
    getVCP: async (monitor, code, cached) => {
      reads.push({ id: monitor.id, code, cached })
      return monitor.key === 'LINK' ? 40 : 33
    },
    monitorsThread: { send: message => messages.push(message) },
    deferredFeatureUpdates: new Map(), deferredLinkedFeatureUpdates: new Map(),
    Utils: require('../src/Utils'), usesExtendedMinimum: () => false, usesGammaSlider: () => false,
    shouldSkipDisplay: () => false, setTrayPercent() {}, sendToAllWindows() {},
    updateKnownDisplays() {}, applyCurrentAdjustmentEvent() {},
    setKnownBrightness: () => {
      context.updateBrightness(monitors.LINK.id, 60)
      context.updateBrightness(monitors.FREE.id, 70)
    },
    console: { log() {}, error: error => { throw error } },
    debug: { error: (message, error) => { throw error } }
  })
  vm.runInContext(declarations.map(n => source.slice(n.start, n.end)).join('\n'), context)
  const session = () => vm.runInContext('idleContrastSession', context)
  const lastContrast = model => messages.filter(m => m.type === 'vcp' && m.code === 18 && m.monitor === monitors[model].id).at(-1)?.value
  return { context, monitors, messages, reads, timers, tick, session, lastContrast, setIdle: value => { idle = value } }
}

test('idle contrast dims linked and independent controls and restores exact raw values', async () => {
  const s = setup()
  await s.context.startIdleCheckShort()
  assert.equal(s.reads.length, 2)
  assert.ok(s.reads.every(read => read.cached === false))
  s.context.idleCheckShort()
  assert.equal(s.monitors.LINK.brightness, 0)
  assert.equal(s.lastContrast('LINK'), 3)
  assert.equal(s.lastContrast('FREE'), 5)
  s.setIdle(0)
  s.context.idleCheckShort()
  assert.equal(s.lastContrast('LINK'), 40)
  assert.equal(s.lastContrast('FREE'), 33)
  s.tick(4000)
  assert.equal(s.lastContrast('LINK'), 40)
  assert.equal(s.lastContrast('FREE'), 33)
  assert.equal(s.session(), null)
})

test('smooth brightness cannot replace the requested idle contrast or continue after wake', async () => {
  const s = setup()
  s.context.settings.idleTransitionSpeed = 10
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.tick(700)
  assert.equal(s.monitors.LINK.brightness, 0)
  assert.equal(s.lastContrast('LINK'), 3)
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  assert.equal(s.lastContrast('LINK'), 40)
  assert.equal(s.monitors.LINK.brightness, 60)
})

test('manual linked brightness wins while unlinked contrast is restored on wake', async () => {
  const s = setup()
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.context.recordIdleAdjustment(s.monitors.LINK.id)
  s.context.updateBrightnessThrottle(s.monitors.LINK.id, 25, true, false)
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  assert.equal(s.lastContrast('LINK'), 25)
  assert.equal(s.lastContrast('FREE'), 33)
  assert.equal(s.monitors.LINK.brightness, 25)
})

test('manual independent brightness restores saved contrast instead of leaving it idle-dimmed', async () => {
  const s = setup()
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.context.recordIdleAdjustment(s.monitors.FREE.id)
  s.context.updateBrightnessThrottle(s.monitors.FREE.id, 25, true, false)
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  assert.equal(s.lastContrast('FREE'), 33)
  assert.equal(s.monitors.FREE.brightness, 25)
})

test('manual contrast after immediate wake restoration survives the delayed retry', async () => {
  const s = setup()
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.setIdle(0)
  s.context.idleCheckShort()
  s.context.recordIdleAdjustment(s.monitors.FREE.id, 0x12)
  s.context.updateBrightnessThrottle(s.monitors.FREE.id, 70, false, false, 0x12)
  s.tick(4000)
  assert.equal(s.lastContrast('FREE'), 70)
  assert.equal(s.monitors.FREE.brightness, 70)
})

test('unreadable contrast is left untouched and brightness still dims', async () => {
  const s = setup()
  s.context.getVCP = async () => -1
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.tick(100)
  assert.equal(s.monitors.LINK.brightness, 0)
  assert.equal(s.messages.filter(m => m.code === 18).length, 0)
})

test('waking during an outstanding snapshot cannot dim a monitor after wake', async () => {
  const s = setup()
  let release
  s.context.getVCP = () => new Promise(resolve => { release = resolve })
  const capture = s.context.startIdleCheckShort()
  await Promise.resolve()
  s.setIdle(0)
  s.context.idleCheckShort()
  release(40)
  await capture
  s.tick(4000)
  assert.equal(s.messages.filter(m => m.code === 18 && m.value < 10).length, 0)
  assert.equal(s.monitors.LINK.brightness, 60)
})

test('a previous idle retry cannot reset a newer idle cycle', async () => {
  const s = setup()
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.setIdle(0)
  s.context.idleCheckShort()
  const oldCallback = s.timers.get(s.session().restoreTimer).fn
  s.setIdle(60)
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  oldCallback()
  assert.equal(s.context.isUserIdle, true)
  assert.equal(s.context.userIdleDimmed, true)
  assert.equal(s.lastContrast('LINK'), 3)
})

test('disabling idle contrast preserves existing brightness-linked behavior', async () => {
  const s = setup()
  s.context.settings.detectIdleContrastEnabled = false
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  assert.equal(s.reads.length, 0)
  assert.equal(s.lastContrast('LINK'), 0)
  assert.equal(s.lastContrast('FREE'), undefined)
})

test('manual contrast before wake cannot be overwritten by linked brightness restoration', async () => {
  const s = setup()
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.context.recordIdleAdjustment(s.monitors.LINK.id, 0x12)
  s.context.updateBrightnessThrottle(s.monitors.LINK.id, 70, false, false, 0x12)
  s.tick(100)
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  assert.equal(s.lastContrast('LINK'), 35)
  assert.equal(s.monitors.LINK.brightness, 60)
})

test('idle contrast clears stale trailing writes and rejects deferred linked replay', async () => {
  const s = setup()
  s.context.updateBrightnessThrottle(s.monitors.LINK.id, 80, false, false, 0x12)
  s.context.updateBrightnessThrottle(s.monitors.LINK.id, 90, false, false, 0x12)
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.context.applyLinkedFeatures(s.monitors.LINK, 90)
  s.tick(500)
  assert.equal(s.lastContrast('LINK'), 3)
})

test('idle contrast uses raw maxima and never raises contrast that is already lower', async () => {
  const s = setup()
  s.monitors.LINK.features['0x12'][1] = 255
  s.context.getVCP = async monitor => monitor.key === 'LINK' ? 85 : 1
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  assert.equal(s.lastContrast('LINK'), 6)
  assert.equal(s.lastContrast('FREE'), 1)
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  assert.equal(s.lastContrast('LINK'), 85)
  assert.equal(s.lastContrast('FREE'), 1)
})

test('contrast restoration waits for feature enrichment and retains its raw original', async () => {
  const s = setup()
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  for (const monitor of Object.values(s.monitors)) monitor.featuresPending = true
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  assert.ok(s.session())
  assert.equal(s.session().phase, 'pendingRestore')
  for (const monitor of Object.values(s.monitors)) monitor.featuresPending = false
  s.context.flushDeferredFeatureUpdates()
  s.tick(100)
  assert.equal(s.lastContrast('LINK'), 40)
  assert.equal(s.lastContrast('FREE'), 33)
  assert.equal(s.session(), null)
})

test('scripted brightness during a snapshot cancels dimming without requiring keyboard input', async () => {
  const s = setup()
  let release
  let first = true
  s.context.getVCP = () => {
    if (!first) return Promise.resolve(33)
    first = false
    return new Promise(resolve => { release = resolve })
  }
  const capture = s.context.startIdleCheckShort()
  await Promise.resolve()
  s.context.recordIdleAdjustment(s.monitors.FREE.id)
  s.context.updateBrightnessThrottle(s.monitors.FREE.id, 25, true, false)
  release(40)
  await capture
  assert.equal(s.monitors.FREE.brightness, 25)
  assert.equal(s.session(), null)
  assert.equal(s.context.isUserIdle, false)
})

test('a new idle cycle retains an unresolved original contrast until controls return', async () => {
  const s = setup()
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  for (const monitor of Object.values(s.monitors)) monitor.featuresPending = true
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  s.setIdle(60)
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  for (const monitor of Object.values(s.monitors)) monitor.featuresPending = false
  s.context.flushDeferredFeatureUpdates()
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  assert.equal(s.lastContrast('LINK'), 40)
  assert.equal(s.lastContrast('FREE'), 33)
})

test('manual CLI contrast and a tray-selected profile survive idle wake restoration', async () => {
  const s = setup()
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.context.handleCommandLine(null, [], '', ['--monitornum=1', '--vcp=18:35'])
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  assert.equal(s.lastContrast('LINK'), 35)
  s.setIdle(60)
  await s.context.startIdleCheckShort()
  s.context.idleCheckShort()
  s.context.applyProfileBrightness({ monitors: { [s.monitors.LINK.id]: 25, [s.monitors.FREE.id]: 30 } }, true)
  s.setIdle(0)
  s.context.idleCheckShort()
  s.tick(4000)
  assert.equal(s.monitors.LINK.brightness, 25)
  assert.equal(s.lastContrast('LINK'), 25)
  assert.equal(s.monitors.FREE.brightness, 30)
})
