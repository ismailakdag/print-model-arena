import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const vercelJson = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const appsScript = await readFile(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

test('deployment config targets Node 24 without legacy function runtime', () => {
  assert.equal(packageJson.engines.node, '24.x');
  assert.equal(vercelJson.functions, undefined);
  assert.equal(packageJson.scripts.test, 'node --test tests/*.test.mjs');
});

test('Apps Script contract includes named participant columns, legacy compatibility, undo, and shared locking', () => {
  assert.match(appsScript, /action === 'status'/);
  assert.match(appsScript, /LockService\.getScriptLock\(\)/);
  assert.match(appsScript, /PARTICIPANT_COLUMN_PREFIX = 'Oy · '/);
  assert.match(appsScript, /ensureParticipantColumn_/);
  assert.match(appsScript, /mirrorLegacyVote_/);
  assert.match(appsScript, /participantCell\.clearContent\(\)/);
  assert.match(appsScript, /shared_mode_disabled/);
  assert.match(appsScript, /contractVersion: 2/);
});
