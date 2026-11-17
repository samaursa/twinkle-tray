const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/electron.js'), 'utf8')
const ast = require('@babel/parser').parse(source, { sourceType: 'script', allowReturnOutsideFunction: true })
function handler(object, event) {
  return ast.program.body.find(node => {
    const call = node.expression
    return call?.type === 'CallExpression' && call.callee.object?.name === object
      && call.callee.property?.name === 'on' && call.arguments[0]?.value === event
  }).expression.arguments[1]
}
for (const hasTray of [false, true]) {
  test('restart on wake completes ' + (hasTray ? 'with' : 'without') + ' a tray icon', async () => {
    const calls = []
    const context = vm.createContext({
      console: { log() {} }, settings: { restartOnWake: true },
      recentlyWokeUpTimeout: false, handleChangeTimeout1: false, handleChangeTimeout2: false,
      blockBadDisplays: () => ({ release() {} }), setRecentlyInteracted() {},
      tray: hasTray ? { destroy: () => calls.push('destroy') } : null,
      app: { relaunch: () => calls.push('relaunch'), exit: () => calls.push('exit') },
      restoreGammaRampsOnQuit() {}, PowerEvents: { unregisterPowerSettingNotifications() {} },
      BrightnessKeys: { unregister() {} }, stopNativeBrightnessKeyRepeat() {},
      logger: { closeLogger: () => calls.push('closed') }
    })
    const resume = handler('powerMonitor', 'resume')
    const quit = handler('app', 'quit')
    await vm.runInContext('(' + source.slice(resume.start, resume.end) + ')()', context)
    assert.deepEqual(calls, ['relaunch', 'exit'])
    vm.runInContext('(' + source.slice(quit.start, quit.end) + ')()', context)
    assert.deepEqual(calls, hasTray ? ['relaunch', 'exit', 'destroy', 'closed'] : ['relaunch', 'exit', 'closed'])
  })
}
