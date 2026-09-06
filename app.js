const SHEET_ID = '1tJtASEdnz5HCUtkVqlTua-t2XoYGmHxL3FgJO7Y4UVI';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
const API_URL = '/api/rate';

const state = {
  rows: [],
  mode: localStorage.getItem('print-lab-mode') || 'personal',
  participant: localStorage.getItem('print-lab-participant') || '',
  myVotes: JSON.parse(localStorage.getItem('print-lab-votes') || '{}'),
  filter: 'pending',
  search: '',
  sort: 'queue',
  currentId: null,
  recent: [],
  history: [],
  editingId: null,
  busy: false,
  sheetLive: false,
  writeAvailable: false,
  loadError: null,
};

const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 });

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; i += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = ''; continue;
    }
    cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.filter((r) => r.some((v) => v.trim() !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()])));
}

function numberValue(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9,.-]/g, '').replace(/\.(?=.*\.)/g, '').replace(',', '.');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentValue(value) {
  const parsed = numberValue(value);
  return parsed == null ? null : (String(value).includes('%') ? parsed : parsed * 100);
}

function slugify(value) {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function normalizeRow(row, index) {
  const cost = numberValue(row['Maliyet TL/adet']);
  const sale = numberValue(row['Satış fiyatı TL']);
  const profit = numberValue(row['Net kâr TL']);
  const margin = percentValue(row['Marj']);
  return {
    ...row,
    id: row['Kimlik'] || `${slugify(row['Model'])}_${index}`,
    index,
    cost,
    sale,
    profit,
    margin,
    grams: numberValue(row['Gram']),
    trayCount: numberValue(row['Tabla adet']),
    trayHours: numberValue(row['Tabla süre (sa)']),
    image: row['Görsel URL'] && row['Görsel URL'] !== 'görsel yok' ? row['Görsel URL'] : '',
    source: row['Kaynak'] || '',
    like: row['Beğeni'] || '',
    status: row['Durum'] || '',
  };
}

function isLiked(value) { return String(value).toLowerCase().includes('beğendim'); }
function isDisliked(value) { return String(value).toLowerCase().includes('beğenmedim'); }
function isVoted(row) {
  return state.mode === 'shared' ? Boolean(row.like) : Boolean(state.myVotes[row.id]);
}
function voteLabel(vote) { return vote === 'like' ? '👍 beğendim' : '👎 beğenmedim'; }
function formatMoney(value) { return value == null ? '—' : money.format(value); }
function formatPercent(value) { return value == null ? '—' : `${value.toFixed(1).replace('.', ',')}%`; }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'kaynak'; }
}

function visibleRows() {
  let rows = state.rows.filter((row) => {
    const haystack = `${row['Model']} ${row['Sınıf']} ${row.status}`.toLocaleLowerCase('tr-TR');
    return !state.search || haystack.includes(state.search.toLocaleLowerCase('tr-TR'));
  });
  if (state.filter === 'pending') rows = rows.filter((row) => !isVoted(row));
  if (state.filter === 'liked') rows = rows.filter((row) => state.mode === 'shared' ? isLiked(row.like) : state.myVotes[row.id] === 'like');
  if (state.filter === 'disliked') rows = rows.filter((row) => state.mode === 'shared' ? isDisliked(row.like) : state.myVotes[row.id] === 'dislike');
  if (state.sort === 'margin') rows.sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity));
  if (state.sort === 'profit') rows.sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity));
  if (state.sort === 'cost') rows.sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
  if (state.sort === 'queue') rows.sort((a, b) => Number(isVoted(a)) - Number(isVoted(b)) || a.index - b.index);
  return rows;
}

function counts() {
  const liked = state.mode === 'shared' ? state.rows.filter((r) => isLiked(r.like)).length : state.rows.filter((r) => state.myVotes[r.id] === 'like').length;
  const disliked = state.mode === 'shared' ? state.rows.filter((r) => isDisliked(r.like)).length : state.rows.filter((r) => state.myVotes[r.id] === 'dislike').length;
  const pending = state.rows.length - liked - disliked;
  return { liked, disliked, pending };
}

function currentRow() {
  if (state.editingId) {
    const editing = state.rows.find((row) => row.id === state.editingId);
    if (editing) return editing;
    state.editingId = null;
  }
  const rows = visibleRows();
  if (!rows.length) return null;
  if (!state.currentId || !rows.some((r) => r.id === state.currentId)) state.currentId = rows[0].id;
  return rows.find((r) => r.id === state.currentId) || rows[0];
}

function nextRow(row) {
  return visibleRows().find((candidate) => candidate.id !== row?.id) || null;
}

function previewMarkup(row) {
  if (!row) return '';
  return `
    <div class="model-visual">
      ${row.image ? `<img src="${escapeHtml(row.image)}" alt="" loading="eager" draggable="false">` : `<div class="visual-placeholder"><div class="visual-placeholder-inner"><span>${escapeHtml(row['Model'])}</span></div></div>`}
    </div>
    <div class="model-info"><small>sıradaki model</small><h3>${escapeHtml(row['Model'])}</h3></div>`;
}

function renderCard() {
  const row = currentRow();
  const card = $('#modelCard');
  card.className = 'model-card';
  card.removeAttribute('style');
  card.removeAttribute('tabindex');
  if (!row) {
    card.innerHTML = `<div class="empty-state"><div><strong>Bu görünümde model kalmadı.</strong><br><span class="muted">Filtreyi değiştirerek tüm kataloğa dönebilirsin.</span></div></div>`;
    $('#nextCard').innerHTML = '';
    return;
  }
  const revisiting = state.mode === 'personal' && state.editingId === row.id;
  const locked = isVoted(row) && !revisiting;
  const currentVote = state.mode === 'shared' ? (isLiked(row.like) ? 'like' : isDisliked(row.like) ? 'dislike' : '') : state.myVotes[row.id] || '';
  card.innerHTML = `
    <div class="swipe-stamp dislike" aria-hidden="true">geç</div>
    <div class="swipe-stamp like" aria-hidden="true">beğen</div>
    <div class="model-visual">
      ${row.image ? `<img src="${escapeHtml(row.image)}" alt="${escapeHtml(row['Model'])}" loading="eager" draggable="false">` : `<div class="visual-placeholder"><div class="visual-placeholder-inner"><span>${escapeHtml(row['Model'])}</span></div></div>`}
      <div class="visual-overlay"><span class="badge">${escapeHtml(row['Sınıf'] || '—')} sınıfı</span>${row.status ? `<span class="badge olive">${escapeHtml(row.status)}</span>` : ''}</div>
    </div>
    <div class="model-info">
      <div class="model-kicker"><span>${String(row.index + 1).padStart(3, '0')} / ${state.rows.length}</span><span>${row['Ölçek'] ? `ölçek ${escapeHtml(row['Ölçek'])}` : 'ölçek —'}</span></div>
      <h2>${escapeHtml(row['Model'])}</h2>
      <a class="model-source" href="${escapeHtml(row.source || '#')}" target="_blank" rel="noreferrer">${escapeHtml(hostOf(row.source))} ↗</a>
      <div class="economics">
        <div class="economic"><small>maliyet / adet</small><strong>${formatMoney(row.cost)}</strong></div>
        <div class="economic"><small>satış fiyatı</small><strong>${formatMoney(row.sale)}</strong></div>
        <div class="economic profit"><small>net kâr</small><strong>${formatMoney(row.profit)}</strong></div>
        <div class="economic profit"><small>marj</small><strong>${formatPercent(row.margin)}</strong></div>
      </div>
      <div class="meta-list">
        <div><small>gram</small><strong>${row.grams == null ? '—' : `${row.grams.toLocaleString('tr-TR')} g`}</strong></div>
        <div><small>tabla</small><strong>${row.trayCount == null ? '—' : `${row.trayCount} adet`}</strong></div>
        <div><small>süre</small><strong>${row.trayHours == null ? '—' : `${row.trayHours.toLocaleString('tr-TR')} sa`}</strong></div>
      </div>
      <div class="card-footer"><span class="${locked ? 'lock-note' : ''}">${revisiting ? `önceki karar: ${currentVote === 'like' ? 'beğendim' : 'beğenmedim'} · değiştirebilirsin` : locked ? (state.mode === 'shared' ? 'ortak karar işlendi' : `bu model ${state.participant || 'senin'} tarafından puanlandı`) : 'sola geç · sağa beğen'}</span>${row['Drive STL URL'] ? `<a href="${escapeHtml(row['Drive STL URL'])}" target="_blank" rel="noreferrer">STL ↗</a>` : ''}</div>
    </div>`;
  card.tabIndex = 0;
  $('#nextCard').innerHTML = previewMarkup(nextRow(row));
  bindCardGestures(card, row, locked);
}

function renderDecisionDock() {
  const row = currentRow();
  const locked = row && isVoted(row) && !(state.mode === 'personal' && state.editingId === row.id);
  const disabled = !row || locked || state.busy;
  $('#dislikeButton').disabled = disabled;
  $('#likeButton').disabled = disabled;
  $('#dislikeButton').classList.toggle('pending', state.busy);
  $('#likeButton').classList.toggle('pending', state.busy);
  $('#undoVote').disabled = state.mode !== 'personal' || !state.history.length || state.busy;
  $('#undoVote').classList.toggle('hidden', state.mode !== 'personal');
}

function renderStats() {
  const { liked, disliked, pending } = counts();
  $('#pendingCount').textContent = pending;
  $('#allCount').textContent = state.rows.length;
  $('#likedCount').textContent = liked;
  $('#dislikedCount').textContent = disliked;
  $('#statModels').textContent = state.rows.length || '—';
  const margins = state.rows.map((r) => r.margin).filter((v) => v != null);
  const profits = state.rows.map((r) => r.profit).filter((v) => v != null);
  $('#statMargin').textContent = margins.length ? formatPercent(margins.reduce((a, b) => a + b, 0) / margins.length) : '—';
  $('#statProfit').textContent = profits.length ? formatMoney(profits.reduce((a, b) => a + b, 0) / profits.length) : '—';
  $('#statImages').textContent = `${state.rows.filter((r) => r.image).length}`;
  const done = state.rows.length ? ((state.rows.length - pending) / state.rows.length) * 100 : 0;
  $('#progressLabel').textContent = `${state.rows.length - pending} / ${state.rows.length}`;
  $('#progressFill').style.width = `${done}%`;
  $('#progressHint').textContent = state.mode === 'shared' ? 'ortak kararlar' : `${state.participant || 'isim gir'} için kararlar`;
  $('#sessionNumber').textContent = state.recent.length;
  $('#sessionCopy').textContent = state.recent.length ? `${state.recent.length} model bu oturumda işlendi.` : 'Bu oturumda henüz karar yok.';
  $('#sessionBar').style.width = `${Math.min(100, state.recent.length * 10)}%`;
}

function renderRecent() {
  const list = $('#recentList');
  if (!state.recent.length) { list.innerHTML = '<span class="muted">Henüz karar yok.</span>'; return; }
  list.innerHTML = state.recent.slice(0, 5).map((item) => `<div class="recent-item"><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><b class="${item.vote}">${item.vote === 'like' ? 'LIKE' : 'NO'}</b></div>`).join('');
}

function renderMode() {
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#participantWrap').classList.toggle('hidden', state.mode !== 'personal');
  $('#sharedNote').classList.toggle('hidden', state.mode !== 'shared');
  $('#participant').value = state.participant;
}

function renderFilters() {
  document.querySelectorAll('[data-filter]').forEach((button) => button.classList.toggle('active', button.dataset.filter === state.filter));
}

function render() {
  renderMode(); renderFilters(); renderStats(); renderRecent(); renderCard(); renderDecisionDock();
}

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => el.classList.remove('show'), 3400);
}

function setConnection(mode, label) {
  const dot = $('.state-dot'); dot.className = `state-dot ${mode || ''}`;
  $('#connectionState span:last-child').textContent = label;
  $('#footerStatus').textContent = label === 'Sheet canlı' ? 'Kararlar canlı olarak Sheet’e yazılıyor.' : label;
}

async function loadSheet() {
  try {
    const response = await fetch(`${CSV_URL}&t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Sheet ${response.status}`);
    const text = await response.text();
    state.rows = parseCsv(text).map(normalizeRow);
    state.sheetLive = true;
    setConnection('live', 'Sheet canlı');
  } catch (error) {
    state.loadError = error;
    setConnection('demo', 'Sheet okunamadı');
    $('#footerStatus').textContent = 'Sheet okunamadı; bağlantıyı ve paylaşım iznini kontrol et.';
  }
  render();
}

async function loadParticipantVotes() {
  if (state.mode !== 'personal' || !state.participant) { render(); return; }
  try {
    const response = await fetch(`${API_URL}?participant=${encodeURIComponent(state.participant)}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'write endpoint unavailable');
    state.myVotes = { ...state.myVotes, ...(data.votes || {}) };
    state.writeAvailable = true;
    localStorage.setItem('print-lab-votes', JSON.stringify(state.myVotes));
    setConnection('live', 'Sheet canlı');
  } catch (error) {
    state.writeAvailable = false;
    setConnection('demo', 'yerel önizleme');
  }
  render();
}

async function persistVote(row, vote) {
  const body = { mode: state.mode, participant: state.participant, id: row.id, vote };
  try {
    const response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'write failed');
    state.writeAvailable = true;
    setConnection('live', 'Sheet canlı');
    return true;
  } catch (error) {
    state.writeAvailable = false;
    setConnection('demo', 'kayıt başarısız');
    return false;
  }
}

async function castVote(row, vote) {
  if (state.mode === 'personal' && !state.participant) {
    $('#participant').focus(); toast('Önce adını veya rumuzunu yaz.'); return;
  }
  const revisiting = state.mode === 'personal' && state.editingId === row.id;
  if (isVoted(row) && !revisiting) return;
  const previous = state.mode === 'shared' ? row.like : state.myVotes[row.id];
  const previousVote = state.mode === 'shared' ? (isLiked(previous) ? 'like' : isDisliked(previous) ? 'dislike' : '') : previous;
  if (revisiting && previousVote === vote) {
    state.editingId = null;
    state.currentId = null;
    render();
    toast('Kararın değişmedi. Sıraya devam edebilirsin.');
    return;
  }
  state.busy = true;
  setConnection('', 'karar kaydediliyor');
  if (state.mode === 'shared') row.like = voteLabel(vote);
  else {
    state.myVotes[row.id] = vote;
    localStorage.setItem('print-lab-votes', JSON.stringify(state.myVotes));
  }
  state.editingId = null;
  state.currentId = null;
  render();
  const saved = await persistVote(row, vote);
  if (!saved) {
    if (state.mode === 'shared') row.like = previous;
    else if (previous) state.myVotes[row.id] = previous; else delete state.myVotes[row.id];
    localStorage.setItem('print-lab-votes', JSON.stringify(state.myVotes));
    state.currentId = row.id;
    state.editingId = previous && state.mode === 'personal' ? row.id : null;
    toast('Karar Sheet’e kaydedilemedi. Değişiklik geri alındı; tekrar deneyebilirsin.');
  } else {
    state.recent = [{ id: row.id, name: row['Model'], vote }, ...state.recent.filter((item) => item.id !== row.id)].slice(0, 10);
    if (state.mode === 'personal') {
      state.history = [{ id: row.id, name: row['Model'], vote, previous: previousVote }, ...state.history.filter((item) => item.id !== row.id)].slice(0, 20);
    }
    toast(revisiting ? 'Kararın güncellendi.' : 'Karar Sheet’e işlendi.');
  }
  state.busy = false;
  render();
}

function animateVote(vote) {
  const row = currentRow();
  if (!row || state.busy) return;
  const revisiting = state.mode === 'personal' && state.editingId === row.id;
  if (isVoted(row) && !revisiting) return;
  if (state.mode === 'personal' && !state.participant) {
    $('#participant').focus();
    toast('Önce adını veya rumuzunu yaz.');
    return;
  }
  state.busy = true;
  renderDecisionDock();
  const card = $('#modelCard');
  const direction = vote === 'like' ? 1 : -1;
  card.classList.remove('dragging');
  card.classList.add('swipe-out');
  card.style.transform = `translate3d(${direction * Math.max(window.innerWidth, 760)}px, -18px, 0) rotate(${direction * 16}deg)`;
  card.style.opacity = '0';
  window.setTimeout(() => {
    state.busy = false;
    castVote(row, vote);
  }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220);
}

function bindCardGestures(card, row, locked) {
  if (locked) return;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let horizontal = false;

  const reset = () => {
    pointerId = null;
    horizontal = false;
    card.classList.remove('dragging');
    card.style.transform = '';
    card.querySelectorAll('.swipe-stamp').forEach((stamp) => { stamp.style.opacity = ''; });
  };

  card.addEventListener('pointerdown', (event) => {
    if (state.busy || event.button !== 0 || event.target.closest('a, button, input, select')) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    card.setPointerCapture(pointerId);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!horizontal && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { reset(); return; }
    if (Math.abs(dx) > 7) horizontal = true;
    if (!horizontal) return;
    event.preventDefault();
    const rotation = Math.max(-12, Math.min(12, dx / 18));
    card.style.transform = `translate3d(${dx}px, ${Math.abs(dx) * -.025}px, 0) rotate(${rotation}deg)`;
    const strength = Math.min(1, Math.max(0, (Math.abs(dx) - 20) / 90));
    card.querySelector('.swipe-stamp.like').style.opacity = dx > 0 ? String(strength) : '0';
    card.querySelector('.swipe-stamp.dislike').style.opacity = dx < 0 ? String(strength) : '0';
  });
  const release = (event) => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const threshold = Math.min(120, card.clientWidth * .22);
    if (horizontal && Math.abs(dx) >= threshold) {
      pointerId = null;
      animateVote(dx > 0 ? 'like' : 'dislike');
    } else reset();
  };
  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', reset);
}

function revisitLastVote() {
  if (state.mode !== 'personal' || state.busy || !state.history.length) return;
  const [last, ...rest] = state.history;
  state.history = rest;
  state.editingId = last.id;
  state.currentId = last.id;
  render();
  $('#modelCard').focus({ preventScroll: true });
  toast('Son karar açıldı. Sola veya sağa kaydırarak değiştirebilirsin.');
}

function bindEvents() {
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
    if (state.busy) return;
    state.mode = button.dataset.mode; state.filter = 'pending'; state.currentId = null; state.editingId = null;
    localStorage.setItem('print-lab-mode', state.mode); render();
    if (state.mode === 'personal' && state.participant) await loadParticipantVotes();
  }));
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { if (state.busy) return; state.filter = button.dataset.filter; state.currentId = null; state.editingId = null; render(); }));
  $('#saveParticipant').addEventListener('click', async () => {
    if (state.busy) return;
    const value = $('#participant').value.trim();
    if (!value) { toast('Bir ad veya rumuz yaz.'); return; }
    state.participant = value; localStorage.setItem('print-lab-participant', value); state.currentId = null; await loadParticipantVotes(); toast(`${value} için kişisel puanlama açıldı.`);
  });
  $('#participant').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#saveParticipant').click(); });
  $('#search').addEventListener('input', (event) => { if (state.busy) return; state.search = event.target.value; state.currentId = null; state.editingId = null; render(); });
  $('#sort').addEventListener('change', (event) => { if (state.busy) return; state.sort = event.target.value; state.currentId = null; state.editingId = null; render(); });
  $('#dislikeButton').addEventListener('click', () => animateVote('dislike'));
  $('#likeButton').addEventListener('click', () => animateVote('like'));
  $('#undoVote').addEventListener('click', revisitLastVote);
  $('#resetSession').addEventListener('click', () => { state.recent = []; state.history = []; state.editingId = null; render(); toast('Oturum özeti temizlendi. Sheet kararları korunur.'); });
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select')) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); animateVote('dislike'); }
    if (event.key === 'ArrowRight') { event.preventDefault(); animateVote('like'); }
  });
}

bindEvents();
renderMode();
loadSheet();
if (state.mode === 'personal' && state.participant) loadParticipantVotes();
