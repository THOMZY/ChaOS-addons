import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const { fr, en } = JSON.parse(await readFile(new URL('../../client/host-locales.json', import.meta.url), 'utf8'));

const pagePath = new URL('../../web/index.html', import.meta.url);

test('Minecraft setup page binds every localized instruction without replacing its markup', async () => {
  const html = await readFile(pagePath, 'utf8');
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(keys, [
    'minecraft.title',
    'minecraft.clientNotInstalled',
    'minecraft.setupInstructionStart',
    'minecraft.webClientName',
    'minecraft.setupInstructionInto',
    'minecraft.serverPortInstruction',
    'minecraft.startItWith',
    'minecraft.manualDownload',
    'minecraft.savePageInstruction',
  ]);
  for (const key of keys) {
    assert.ok(fr[key], `Missing French translation: ${key}`);
    assert.ok(en[key], `Missing English translation: ${key}`);
  }
  assert.match(html, /<code>games\/minecraft\/web\/eaglercraft\.html<\/code>/);
  assert.match(
    html,
    /<strong data-i18n="minecraft\.webClientName">EaglerCraft 1\.8\.8 web client<\/strong>/,
  );
  assert.match(html, /<code>docker compose --profile minecraft up minecraft<\/code>/);
  assert.match(html, /registerAddonTranslations/);
  assert.match(html, /document\.documentElement\.lang = getLanguage\(\)/);
  const moduleSource = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(moduleSource, 'Expected a module script to load shared localization.');
  assert.doesNotThrow(() => new vm.Script('(async () => {' + moduleSource.replace(/^\s*import\s+.*?;\s*$/gm, '') + '})()'));
});
