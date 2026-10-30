import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const pause = (ms) => new Promise((done) => setTimeout(done, ms));
export async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(50);
  }
  throw new Error('Timed out: ' + label);
}

export async function startBrowser({ commandTimeout = 20000 } = {}) {
  const executable = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
  ].find((path) => path && existsSync(path));
  assert.ok(executable, 'Set BROWSER_PATH to Chromium');
  const profile = mkdtempSync(resolve(tmpdir(), 'mugen-library-browser-'));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--disable-popup-blocking',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  await until(() => existsSync(resolve(profile, 'DevToolsActivePort')), 'browser');
  const [port, path] = readFileSync(resolve(profile, 'DevToolsActivePort'), 'utf8')
    .trim()
    .split(/\r?\n/);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((done, reject) => {
    socket.onopen = done;
    socket.onerror = reject;
  });
  const pending = new Map(),
    exceptions = [],
    consoleMessages = [];
  let sequence = 0;
  const send = (method, params = {}, sessionId) =>
    new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP timed out: ' + method));
      }, commandTimeout);
      pending.set(id, { done, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleMessages.push(
        message.params.args.map((item) => item.value ?? item.description).join(' '),
      );
      if (consoleMessages.length > 100) consoleMessages.shift();
    }
    if (message.method === 'Runtime.exceptionThrown')
      exceptions.push(message.params.exceptionDetails);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.done(message.result);
  };
  async function attach(targetId) {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    const command = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) => {
      const response = await command('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    return {
      command,
      evaluate,
      wait: (expression, label, timeout) => until(() => evaluate(expression), label, timeout),
    };
  }
  return {
    send,
    attach,
    exceptions,
    consoleMessages,
    async page(url) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const page = await attach(targetId);
      await page.command('Page.navigate', { url });
      return page;
    },
    async close() {
      try {
        await send('Browser.close');
      } catch {
        /* Closing Chromium can retire CDP before its reply. */
      }
      socket.close();
      child.kill();
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('browser_closed'));
      }
      pending.clear();
    },
  };
}
