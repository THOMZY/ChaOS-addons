// Standalone UI regression: real browser hit-testing, mocked stream, no ROM/core.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}
const client = resolve(import.meta.dirname, '../client');
const server = createServer((req, res) => {
  const file = req.url.slice(1);
  if (
    [
      'gameboy.js',
      'gameboy.css',
      'gameboy-frame-codec.js',
      'stream-state.js',
      'volume.js',
    ].includes(file)
  ) {
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
    return res.end(readFileSync(join(client, file)));
  }
  if (req.url === '/gameboy-api/status') {
    res.setHeader('Content-Type', 'application/json');
    return res.end('{"model":"DMG"}');
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/gameboy.css">
  <style>body{margin:0;background:#101311}.wm-win{width:620px;height:800px;margin:20px auto}textarea{position:absolute;top:0;left:0;width:40px;height:15px}</style>
  <textarea id="chat"></textarea><div class="wm-win" tabindex="-1"><div id="gameboy-body"></div></div>
  <script>
  window.sent=[];window.libraryOpens=0;window.open=()=>{libraryOpens++;return null};
  window.WebSocket=class {
    constructor(){window.socket=this;this.readyState=1;setTimeout(()=>{this.onopen?.();window.changeModel('DMG',true)},0)}
    send(data){sent.push(JSON.parse(data))}close(){this.readyState=3}
  };
  window.changeModel=(model,hello=false)=>socket.onmessage({data:JSON.stringify({type:hello?'hello':'rom',id:1,proto:4,canControl:true,model,width:model==='AGB'?240:160,height:model==='AGB'?160:144,title:'Diagnostic',generation:1})});
  </script><script type="module">import{mountWindow}from'/gameboy.js';window.owner=mountWindow();window.ready=true;</script>`);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const executable = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
assert.ok(executable, 'Set BROWSER_PATH to a Chromium executable');
const profile = mkdtempSync(join(tmpdir(), 'gb-shell-browser-'));
let browser, socket;
let sequence = 0;
const pending = new Map(),
  errors = [];
try {
  browser = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  await until(() => existsSync(join(profile, 'DevToolsActivePort')), 'browser startup');
  const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8')
    .trim()
    .split(/\r?\n/);
  socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((done, reject) => {
    socket.onopen = done;
    socket.onerror = reject;
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }, 15000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    message.error
      ? call.reject(new Error(JSON.stringify(message.error)))
      : call.resolve(message.result);
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => {
    const value = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  await send('Runtime.enable', {}, sessionId);
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1000, height: 850, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` }, sessionId);
  await until(() => evaluate('!!window.ready'), 'mounted shell');
  const position = async (selector) =>
    evaluate(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
  const pointer = async (type, p) =>
    send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }, sessionId);
  const click = async (selector) => {
    const p = await position(selector);
    await pointer('mousePressed', p);
    await pointer('mouseReleased', p);
  };
  await click('#gb-startbtn');
  await until(
    () =>
      evaluate(
        'window.socket?.readyState===1 && document.querySelector(".gb-shell").dataset.model==="DMG"',
      ),
    'started stream',
  );
  await delay(80);
  for (const model of ['DMG', 'AGB', 'CGB', 'AGB', 'DMG']) {
    await evaluate(`changeModel('${model}')`);
    await delay(60);
    assert.equal(
      await evaluate('document.querySelector(".gb-shell").dataset.model'),
      model === 'AGB' ? 'AGB' : 'DMG',
    );
    assert.deepEqual(
      await evaluate(
        '[document.querySelectorAll("#gb-power").length,document.querySelectorAll("input[type=range]").length,document.querySelectorAll(".gb-art svg").length]',
      ),
      [1, 1, 0],
    );
    const display = await evaluate(`(()=>{
      const shell=document.querySelector('.gb-shell');
      const screen=document.getElementById('gb-screen').getBoundingClientRect();
      const body=document.querySelector('.gb-case').getBoundingClientRect();
      return {ratio:screen.width/screen.height, coverage:screen.width/body.width,
        obscured:[...shell.querySelectorAll('[data-btn]')].some(button=>{
          const r=button.getBoundingClientRect();
          return r.left<screen.right && r.right>screen.left && r.top<screen.bottom && r.bottom>screen.top;
        })};
    })()`);
    assert.ok(
      Math.abs(display.ratio - (model === 'AGB' ? 1.5 : 10 / 9)) < 0.001,
      'native screen aspect ratio',
    );
    assert.ok(display.coverage > (model === 'AGB' ? 0.57 : 0.81), 'enlarged screen coverage');
    assert.equal(display.obscured, false, 'controls never overlap the enlarged display');
    assert.equal(
      await evaluate(
        'document.querySelector(".gb-keyboard").getBoundingClientRect().top >= document.querySelector(".gb-hud").getBoundingClientRect().bottom',
      ),
      true,
      'keyboard legend sits below status',
    );
    assert.equal(
      await evaluate(
        'getComputedStyle(document.querySelector(".gb-advance-controls")).display !== "none"',
      ),
      model === 'AGB',
      'shoulder shortcuts only on Advance',
    );
    if (model === 'AGB') {
      assert.equal(
        await evaluate('document.querySelector(".gb-brand")'),
        null,
        'no Nintendo logo on Advance',
      );
      assert.ok(
        await evaluate(`(()=>{
        const screen=document.getElementById('gb-screen').getBoundingClientRect();
        const bezel=document.querySelector('.gb-bezel').getBoundingClientRect();
        const logo=document.querySelector('.gb-advance-logo').getBoundingClientRect();
        const scale=document.querySelector('.gb-case').getBoundingClientRect().width/620;
        return Math.abs((logo.top+logo.bottom)/2-((screen.bottom+6*scale)+(bezel.bottom-2*scale))/2)<scale;
      })()`),
        'logo vertically centered in the black strip below the screen',
      );
      assert.ok(
        await evaluate(`(()=>{
        const body=document.querySelector('.gb-case').getBoundingClientRect();
        return document.getElementById('gb-lib').getBoundingClientRect().top >= body.top+15*(body.width/620);
      })()`),
        'library button stays within the upper rim',
      );
    }
    const buttons = [
      'up',
      'down',
      'left',
      'right',
      'a',
      'b',
      'start',
      'select',
      ...(model === 'AGB' ? ['l', 'r'] : []),
    ];
    for (const btn of buttons) {
      const selector = `[data-btn="${btn}"]`,
        p = await position(selector);
      assert.equal(
        await evaluate(
          `document.elementFromPoint(${p.x},${p.y})?.closest('[data-btn]')?.dataset.btn`,
        ),
        btn,
        `${model}: ${btn} is not obstructed`,
      );
      await evaluate('sent=[]');
      await pointer('mousePressed', p);
      assert.equal(
        await evaluate(`document.querySelector('${selector}').classList.contains('active')`),
        true,
        `${model}: ${btn} pressed`,
      );
      // Release outside the console: pointer capture must still release input.
      await pointer('mouseMoved', { x: 2, y: 830 });
      await pointer('mouseReleased', { x: 2, y: 830 });
      assert.deepEqual(
        await evaluate('sent.filter(m=>m.type==="input")'),
        [
          { type: 'input', btn, down: true },
          { type: 'input', btn, down: false },
        ],
        `${model}: ${btn} input pair`,
      );
      assert.equal(
        await evaluate(`document.querySelector('${selector}').classList.contains('active')`),
        false,
      );
    }
    await click('#gb-power');
    assert.equal(
      await evaluate('document.getElementById("gb-power").getAttribute("aria-checked")'),
      'false',
    );
    await click('#gb-power');
    assert.equal(
      await evaluate('document.getElementById("gb-power").getAttribute("aria-checked")'),
      'true',
    );
    await click('#gb-vol');
    await evaluate('document.getElementById("gb-vol").focus()');
    await send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      sessionId,
    );
    await send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      sessionId,
    );
    assert.equal(
      await evaluate('document.getElementById("gb-volpct").textContent'),
      await evaluate('document.getElementById("gb-vol").value'),
    );
    await click('#gb-lib');
    // Screenshots retain the launch overlay to show the design with no ROM.
    if (process.env.GAMEBOY_SCREENSHOTS && model !== 'CGB') {
      await evaluate('document.getElementById("gb-start").hidden=false');
      const folder = resolve(process.env.GAMEBOY_SCREENSHOTS);
      mkdirSync(folder, { recursive: true });
      const clip = await evaluate(
        `(()=>{const r=document.querySelector('.gb-shell').getBoundingClientRect();return {x:r.x-20,y:Math.max(0,r.y-20),width:r.width+40,height:r.height+40,scale:1}})()`,
      );
      const screenshot = await send('Page.captureScreenshot', { format: 'png', clip }, sessionId);
      writeFileSync(
        join(folder, `${model.toLowerCase()}.png`),
        Buffer.from(screenshot.data, 'base64'),
      );
      await evaluate('document.getElementById("gb-start").hidden=true');
    }
    console.info(
      `PASS ${model}: all pointer controls, release outside, power, volume, library, model swap`,
    );
  }
  // Remote holds survive local release; delayed own echoes never re-press a key.
  await evaluate(
    `socket.onmessage({data:JSON.stringify({type:'controls',players:[{id:1,buttons:['a']}]})})`,
  );
  assert.equal(
    await evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    false,
  );
  await evaluate(
    `socket.onmessage({data:JSON.stringify({type:'controls',players:[{id:2,buttons:['a']}]})})`,
  );
  await click('[data-btn=a]');
  assert.equal(
    await evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    true,
  );
  await evaluate(`socket.onmessage({data:JSON.stringify({type:'controls',players:[]})})`);
  assert.equal(
    await evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    false,
  );
  // Keyboard and pointer can hold the same key independently.
  await evaluate('document.getElementById("gb-canvas").focus();sent=[]');
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 },
    sessionId,
  );
  await click('[data-btn=a]');
  assert.equal(
    await evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    true,
  );
  assert.deepEqual(await evaluate('sent.filter(m=>m.type==="input")'), [
    { type: 'input', btn: 'a', down: true },
  ]);
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 },
    sessionId,
  );
  assert.deepEqual(await evaluate('sent.filter(m=>m.type==="input")'), [
    { type: 'input', btn: 'a', down: true },
    { type: 'input', btn: 'a', down: false },
  ]);
  // Focused buttons support Space and release if focus leaves before keyup.
  await evaluate('document.querySelector("[data-btn=b]").focus();sent=[]');
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
    sessionId,
  );
  assert.equal(
    await evaluate('document.querySelector("[data-btn=b]").classList.contains("active")'),
    true,
  );
  await evaluate('document.getElementById("chat").focus()');
  assert.deepEqual(await evaluate('sent.filter(m=>m.type==="input")'), [
    { type: 'input', btn: 'b', down: true },
    { type: 'input', btn: 'b', down: false },
  ]);
  await evaluate('sent=[]');
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 },
    sessionId,
  );
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 },
    sessionId,
  );
  assert.deepEqual(
    await evaluate('sent.filter(m=>m.type==="input")'),
    [],
    'text input does not control game',
  );
  // Touch cancellation and a model change cannot leave a direction held.
  const touch = await position('[data-btn=up]');
  await send(
    'Input.dispatchTouchEvent',
    { type: 'touchStart', touchPoints: [{ ...touch, id: 1 }] },
    sessionId,
  );
  assert.equal(
    await evaluate('document.querySelector("[data-btn=up]").classList.contains("active")'),
    true,
  );
  await send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }, sessionId);
  assert.equal(
    await evaluate('document.querySelector("[data-btn=up]").classList.contains("active")'),
    false,
  );
  await evaluate('document.getElementById("gb-canvas").focus();sent=[]');
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 },
    sessionId,
  );
  await evaluate('changeModel("AGB")');
  assert.deepEqual(await evaluate('sent.filter(m=>m.type==="input")'), [
    { type: 'input', btn: 'a', down: true },
    { type: 'input', btn: 'a', down: false },
  ]);
  // Small window still exposes each control within its bounds.
  for (const model of ['DMG', 'AGB']) {
    await evaluate(
      `changeModel('${model}');document.querySelector('.wm-win').style.cssText='width:300px;height:390px;margin:0'`,
    );
    await delay(100);
    const bounds = await evaluate(
      `(()=>{const h=document.getElementById('gameboy-body').getBoundingClientRect();return [...document.querySelectorAll('[data-btn],#gb-power,#gb-vol,#gb-lib,#gb-screen')].every(e=>{const r=e.getBoundingClientRect();return r.left>=h.left && r.right<=h.right && r.top>=h.top && r.bottom<=h.bottom})})()`,
    );
    assert.equal(bounds, true, `${model}: small window bounds`);
    await click('[data-btn=a]');
  }
  assert.equal(await evaluate('libraryOpens'), 5);
  assert.deepEqual(errors, []);
  await evaluate('owner.destroy()');
  console.info('PASS mixed keyboard/pointer input, small windows, no browser exceptions');
} finally {
  socket?.close();
  browser?.kill();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  for (const call of pending.values()) clearTimeout(call.timer);
}
