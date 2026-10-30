#!/usr/bin/env node
// Checks every add-on of this repository without the site: addon.json fields,
// files the site tracks itself, and the declared entry and installer.
// Add-ons are grouped by kind: games/<id>/ today, applications/<id>/ later.
//   node scripts/check-addons.mjs
// The site applies the same rules when it installs an add-on
// (scripts/games-install.mjs, games/addons.js).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADDON_API = 1;
const SITE_FILES = ['manifest.js', 'assets'];
/** Folders that group add-ons by kind; a missing one is simply empty. */
const KINDS = ['games', 'applications'];
const problems = [];

const isDir = (path) => existsSync(path) && statSync(path).isDirectory();
const addons = KINDS.filter((kind) => isDir(resolve(ROOT, kind))).flatMap((kind) =>
  readdirSync(resolve(ROOT, kind))
    .filter((name) => isDir(resolve(ROOT, kind, name)))
    .map((id) => ({ kind, id, dir: resolve(ROOT, kind, id) })),
);
const ids = new Set();
for (const { kind, id, dir } of addons) {
  const fail = (message) => problems.push(`${kind}/${id} : ${message}`);
  if (!existsSync(resolve(dir, 'addon.json'))) {
    fail('addon.json manquant');
    continue;
  }
  if (ids.has(id)) fail('id déjà utilisé par un autre add-on');
  ids.add(id);
  let addon;
  try {
    addon = JSON.parse(readFileSync(resolve(dir, 'addon.json'), 'utf8'));
  } catch (error) {
    fail(`addon.json illisible (${error.message})`);
    continue;
  }
  if (addon.id !== id) fail(`id ${JSON.stringify(addon.id)} différent du dossier`);
  if (addon.chaosAddonApi !== ADDON_API) fail(`chaosAddonApi doit valoir ${ADDON_API}`);
  if (!/^\d+\.\d+\.\d+$/.test(addon.version ?? '')) fail('version x.y.z attendue');
  if (typeof addon.name !== 'string' || !addon.name) fail('name manquant');
  if (addon.server !== undefined) {
    if (!/^server\/[a-z0-9-]+\.js$/.test(addon.server)) fail('server doit être server/<nom>.js');
    else if (!existsSync(resolve(dir, addon.server))) fail(`${addon.server} introuvable`);
  }
  for (const name of SITE_FILES) if (existsSync(resolve(dir, name))) fail(`${name} appartient au site`);
  if (addon.data) {
    if (!/^[a-z0-9-]+$/.test(addon.data.dir ?? '')) fail('data.dir doit être un nom de dossier simple');
    else if (existsSync(resolve(dir, addon.data.dir))) fail(`${addon.data.dir}/ ne doit pas être versionné`);
    if (!addon.data.install) fail('data.install manquant');
  }
  if (addon.compose !== undefined && !/^[a-z][a-z0-9-]*$/.test(addon.compose?.profile ?? ''))
    fail('compose.profile doit être un nom de profil');
  if (!existsSync(resolve(dir, 'README.md'))) fail('README.md manquant');
}

if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else
  console.info(
    `${addons.length} add-on(s) conformes : ${addons.map(({ kind, id }) => `${kind}/${id}`).join(', ')}`,
  );
