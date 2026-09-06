import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { VOTE_BY_DIRECTION } from '../app.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('first-run participant setup is an accessible modal with a named Sheet target', () => {
  assert.match(html, /id="participantModal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /aria-labelledby="participantModalTitle"/);
  assert.match(html, /<label for="participant">ad \/ rumuz<\/label>/);
  assert.match(html, /id="saveParticipant"[^>]*type="submit">Devam et<\/button>/);
  assert.match(html, /id="changeParticipant"[^>]*>adı değiştir<\/button>/);
  assert.match(app, /else openParticipantModal\(\)/);
  assert.match(app, /event\.key === 'Escape' && state\.participant/);
});

test('left and right controls, gestures, and keys have one explicit vote mapping', () => {
  assert.deepEqual(VOTE_BY_DIRECTION, { left: 'dislike', right: 'like' });
  assert.match(html, /id="dislikeButton"[^>]*data-direction="left"[^>]*data-vote="dislike"[^>]*aria-label="Sol: GEÇ, beğenmedim"/);
  assert.match(html, /id="likeButton"[^>]*data-direction="right"[^>]*data-vote="like"[^>]*aria-label="Sağ: BEĞENDİM"/);
  assert.match(html, /<strong>GEÇ<\/strong><small>beğenmedim<\/small>/);
  assert.match(html, /<strong>BEĞENDİM<\/strong><small>sağa<\/small>/);
  assert.match(css, /\.decision-button\.dislike \{ order:1;/);
  assert.match(css, /\.decision-button\.like \{ order:3;/);
  assert.match(css, /\.swipe-stamp\.dislike \{ left:/);
  assert.match(css, /\.swipe-stamp\.like \{ right:/);
  assert.match(css, /\.swipe-stamp\.dislike \{[^}]*transform-origin:0 50%/);
  assert.match(css, /\.swipe-stamp\.like \{[^}]*transform-origin:100% 50%/);
  assert.match(app, /event\.key === 'ArrowLeft'.*VOTE_BY_DIRECTION\.left/);
  assert.match(app, /event\.key === 'ArrowRight'.*VOTE_BY_DIRECTION\.right/);
  assert.match(app, /dx > 0 \? VOTE_BY_DIRECTION\.right : VOTE_BY_DIRECTION\.left/);
});

test('write destination is visible in setup, controls, arena, queue, and vote feedback', () => {
  const targetCopies = html.match(/Ana Sheet → Oy ·/g) || [];
  assert.ok(targetCopies.length >= 3);
  assert.match(html, /id="controlWriteTarget"/);
  assert.match(html, /id="arenaWriteTarget"/);
  assert.match(app, /const writeTarget = .*`Ana Sheet → Oy ·/);
  assert.match(app, /BEKLİYOR/);
  assert.match(app, /EŞİTLENDİ/);
  assert.match(app, /BAŞARISIZ/);
  assert.match(app, /toast\(`\$\{row\.Model\}.*\$\{writeTarget\(\)\} · bekliyor`\)/);
  assert.match(app, /toast\(`\$\{last\.name\} · geri alındı · \$\{writeTarget\(\)\} · bekliyor`\)/);
});

test('page close sends pending personal votes through the browser beacon path', () => {
  assert.match(app, /function flushQueueOnPageHide\(\)/);
  assert.match(app, /navigator\.sendBeacon\(API_URL/);
  assert.match(app, /pagehide.*flushQueueOnPageHide/);
});
