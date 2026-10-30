import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { labelsFor } from '../server/locale-names.js';

const catalog = JSON.parse(readFileSync(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));

test('French needs no overlay: the catalogue already speaks it', () => {
  const labels = labelsFor('fr-FR');
  assert.equal(labels.items.size, 0);
  assert.equal(labels.families.size, 0);
  assert.equal(labels.quests.size, 0);
});

test('English item names come from the build locale, entities decoded', () => {
  const labels = labelsFor('en-US');
  assert.equal(labels.items.size, 357);
  assert.equal(labels.items.get('117'), "Gordon's Key");
  assert.equal(labels.items.get('1'), 'Golden Shield');
});

test('English families and quests cover the whole catalogue', () => {
  const labels = labelsFor('en-US');
  const familyIds = Object.keys(catalog.families);
  const questIds = Object.keys(catalog.quests);
  assert.equal(labels.families.size, familyIds.length);
  assert.equal(labels.quests.size, questIds.length);
  for (const id of familyIds) assert.ok(labels.families.get(id), `famille ${id} sans traduction`);
  for (const id of questIds) {
    const quest = labels.quests.get(id);
    assert.ok(quest?.name, `quête ${id} sans nom`);
    assert.ok(quest.text, `quête ${id} sans texte`);
  }
});

test('Labels are cached per locale', () => {
  assert.equal(labelsFor('en-US'), labelsFor('en-US'));
  assert.notEqual(labelsFor('en-US'), labelsFor('fr-FR'));
});
