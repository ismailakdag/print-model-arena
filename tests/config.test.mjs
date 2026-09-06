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

test('Apps Script contract includes status, personal replacement, undo, and shared locking', () => {
  assert.match(appsScript, /action === 'status'/);
  assert.match(appsScript, /LockService\.getScriptLock\(\)/);
  assert.match(appsScript, /votesSheet\.getRange\(i \+ 1, headers\['Oy'\]/);
  assert.match(appsScript, /votesSheet\.deleteRow\(i \+ 1\)/);
  assert.match(appsScript, /if \(String\(cell\.getValue\(\)\)\.trim\(\)\)/);
});
