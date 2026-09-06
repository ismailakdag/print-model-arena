const SHEET_ID = '1tJtASEdnz5HCUtkVqlTua-t2XoYGmHxL3FgJO7Y4UVI';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
const API_URL = '/api/rate';
const QUEUE_STORAGE_KEY = 'print-lab-write-queue-v2';

export function parseCsv(text) {
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
  return rows
    .filter((values) => values.some((value) => value.trim() !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header.trim(), (values[index] || '').trim()])));
}

export function hasUsableImageUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate || /^(g[oö]rsel yok|yok|n\/a|null|undefined|-)$/i.test(candidate)) return false;
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
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

export function normalizeRow(row, sourceIndex) {
  return {
    ...row,
    id: String(row.Kimlik || `${slugify(row.Model)}_${sourceIndex}`).trim(),
    index: sourceIndex,
    cost: numberValue(row['Maliyet TL/adet']), sale: numberValue(row['Satış fiyatı TL']),
    profit: numberValue(row['Net kâr TL']), margin: percentValue(row.Marj), grams: numberValue(row.Gram),
    trayCount: numberValue(row['Tabla adet']), trayHours: numberValue(row['Tabla süre (sa)']),
    image: String(row['Görsel URL']).trim(), source: row.Kaynak || '', like: row.Beğeni || '', status: row.Durum || '',
  };
}

export function prepareRows(rawRows) {
  const rows = rawRows.map((row, sourceIndex) => ({ row, sourceIndex }))
    .filter(({ row }) => hasUsableImageUrl(row['Görsel URL']))
    .map(({ row, sourceIndex }) => normalizeRow(row, sourceIndex));
  return { rows, sourceCount: rawRows.length, excludedCount: rawRows.length - rows.length };
}

function operationKey(payload) {
  return [payload.mode, String(payload.participant || '').trim().toLocaleLowerCase('tr-TR'), payload.id].join(':');
}

function operationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `vote-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class PersistentVoteQueue {
  constructor({ storage, send, onChange = () => {}, now = () => Date.now(), schedule = setTimeout, random = Math.random, storageKey = QUEUE_STORAGE_KEY } = {}) {
    this.storage = storage; this.send = send; this.onChange = onChange; this.now = now;
    this.schedule = schedule; this.random = random; this.storageKey = storageKey;
    this.online = true; this.running = false; this.timer = null; this.items = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(this.storage?.getItem(this.storageKey) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => item?.payload?.id && ['personal', 'shared'].includes(item.payload.mode))
        .map((item) => ({ ...item, status: 'pending' }));
    } catch { return []; }
  }

  persist() {
    this.storage?.setItem(this.storageKey, JSON.stringify(this.items));
    this.onChange(this.snapshot());
  }

  snapshot() {
    return {
      total: this.items.length,
      pending: this.items.filter((item) => ['pending', 'sending'].includes(item.status)).length,
      failed: this.items.filter((item) => item.status === 'failed').length,
      online: this.online,
      items: this.items.map((item) => ({ ...item, payload: { ...item.payload } })),
    };
  }

  enqueue(payload) {
    const key = operationKey(payload);
    const replacement = [...this.items].reverse().find((item) => item.key === key && item.status !== 'sending');
    const item = { operationId: operationId(), key, payload: { ...payload }, attempts: 0, nextAttemptAt: this.now(), status: 'pending', error: '', createdAt: this.now() };
    if (replacement) this.items[this.items.indexOf(replacement)] = item; else this.items.push(item);
    this.persist(); void this.pump(); return item;
  }

  setOnline(online) { this.online = Boolean(online); this.persist(); if (this.online) void this.pump(); }

  retryNow() {
    for (const item of this.items) { item.status = 'pending'; item.attempts = 0; item.nextAttemptAt = this.now(); item.error = ''; }
    this.persist(); void this.pump();
  }

  async pump() {
    if (this.running || !this.online || !this.send) return;
    const item = this.items.find((candidate) => candidate.status === 'pending');
    if (!item) return;
    const wait = Math.max(0, Number(item.nextAttemptAt || 0) - this.now());
    if (wait > 0) {
      if (!this.timer) this.timer = this.schedule(() => { this.timer = null; void this.pump(); }, wait);
      return;
    }
    this.running = true; item.status = 'sending'; this.persist();
    try {
      await this.send({ ...item.payload, operationId: item.operationId });
      this.items.splice(this.items.indexOf(item), 1);
    } catch (error) {
      item.attempts += 1; item.error = String(error?.message || 'Kayıt başarısız');
      if (error?.retryable === false || item.attempts >= 6) item.status = 'failed';
      else {
        item.status = 'pending';
        const backoff = Math.min(60000, 1000 * (2 ** (item.attempts - 1)));
        item.nextAttemptAt = this.now() + backoff + Math.round(backoff * .2 * this.random());
      }
    } finally { this.running = false; this.persist(); }
    void this.pump();
  }
}

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

if (isBrowser) {
  const storage = window.localStorage;
  const safeJson = (key, fallback) => { try { return JSON.parse(storage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } };
  const savedMode = storage.getItem('print-lab-mode');
  const state = {
    rows: [], sourceCount: 0, excludedCount: 0, loading: true,
    mode: ['personal', 'shared'].includes(savedMode) ? savedMode : 'personal',
    participant: storage.getItem('print-lab-participant') || '', myVotes: {}, filter: 'pending', search: '', sort: 'queue', currentId: null,
    recent: [], history: [], transitioning: false, sheetLive: false, loadError: null, queue: null,
    queueStatus: { total: 0, pending: 0, failed: 0, online: navigator.onLine },
  };
  const $ = (selector) => document.querySelector(selector);
  const money = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 });
  const voteStorageKey = () => `print-lab-votes-v2:${state.participant.trim().toLocaleLowerCase('tr-TR')}`;
  const saveVotes = () => storage.setItem(voteStorageKey(), JSON.stringify(state.myVotes));
  const isLiked = (value) => String(value).toLocaleLowerCase('tr-TR').includes('beğendim');
  const isDisliked = (value) => String(value).toLocaleLowerCase('tr-TR').includes('beğenmedim');
  const isVoted = (row) => state.mode === 'shared' ? Boolean(row.like) : Boolean(state.myVotes[row.id]);
  const voteLabel = (vote) => vote === 'like' ? '👍 beğendim' : '👎 beğenmedim';
  const formatMoney = (value) => value == null ? '—' : money.format(value);
  const formatPercent = (value) => value == null ? '—' : `${value.toFixed(1).replace('.', ',')}%`;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'kaynak'; } };

  function setConnection(mode, label) {
    $('.state-dot').className = `state-dot ${mode || ''}`;
    $('#connectionState span:last-child').textContent = label;
  }

  function toast(message) {
    const element = $('#toast'); element.textContent = message; element.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3600);
  }

  function visibleRows() {
    let rows = state.rows.filter((row) => {
      const haystack = `${row.Model} ${row.Sınıf} ${row.status}`.toLocaleLowerCase('tr-TR');
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
    const liked = state.rows.filter((row) => state.mode === 'shared' ? isLiked(row.like) : state.myVotes[row.id] === 'like').length;
    const disliked = state.rows.filter((row) => state.mode === 'shared' ? isDisliked(row.like) : state.myVotes[row.id] === 'dislike').length;
    return { liked, disliked, pending: Math.max(0, state.rows.length - liked - disliked) };
  }

  function currentRow() {
    const rows = visibleRows();
    if (!rows.length) return null;
    if (!state.currentId || !rows.some((row) => row.id === state.currentId)) state.currentId = rows[0].id;
    return rows.find((row) => row.id === state.currentId) || rows[0];
  }

  const nextRow = (row) => visibleRows().find((candidate) => candidate.id !== row?.id) || null;
  const imageMarkup = (row, alt = '') => `<img src="${escapeHtml(row.image)}" alt="${escapeHtml(alt)}" loading="eager" draggable="false" referrerpolicy="no-referrer">`;

  function removeBrokenImage(id) {
    if (!state.rows.some((row) => row.id === id)) return;
    state.rows = state.rows.filter((row) => row.id !== id); state.excludedCount += 1; state.currentId = null;
    toast('Görseli açılamayan model desteden çıkarıldı.'); render();
  }

  function previewMarkup(row) {
    if (!row) return '';
    return `<div class="model-visual">${imageMarkup(row)}</div><div class="model-info"><small>sıradaki model</small><h3>${escapeHtml(row.Model)}</h3></div>`;
  }

  function emptyMarkup() {
    if (state.loading) return '<div class="empty-state"><div class="loader"></div><strong>Görselli modeller hazırlanıyor…</strong></div>';
    if (state.loadError) return '<div class="empty-state"><strong>Sheet okunamadı.</strong><span>Bağlantıyı veya paylaşım iznini kontrol edip sayfayı yenile.</span></div>';
    if (!state.rows.length && state.sourceCount) return `<div class="empty-state"><strong>Gösterilebilecek model yok.</strong><span>Sheet’teki ${state.sourceCount} satırın hiçbirinde kullanılabilir bir Görsel URL bulunamadı.</span></div>`;
    if (!state.rows.length) return '<div class="empty-state"><strong>Sheet boş.</strong><span>Görsel URL içeren model satırı eklenince deste burada görünecek.</span></div>';
    return '<div class="empty-state"><strong>Bu görünümde model kalmadı.</strong><span>Filtreyi veya arama metnini değiştirerek kataloğa dönebilirsin.</span></div>';
  }

  function renderCard() {
    const row = currentRow();
    const card = $('#modelCard'); card.className = 'model-card'; card.removeAttribute('style'); card.removeAttribute('tabindex');
    if (!row) { card.innerHTML = emptyMarkup(); $('#nextCard').innerHTML = ''; return; }
    const locked = isVoted(row);
    const currentVote = state.mode === 'shared' ? (isLiked(row.like) ? 'like' : isDisliked(row.like) ? 'dislike' : '') : state.myVotes[row.id] || '';
    card.innerHTML = `
      <div class="swipe-wash dislike" aria-hidden="true"></div><div class="swipe-wash like" aria-hidden="true"></div>
      <div class="swipe-stamp dislike" aria-hidden="true">GEÇ</div><div class="swipe-stamp like" aria-hidden="true">BEĞEN</div>
      <div class="model-visual">${imageMarkup(row, row.Model)}<div class="visual-overlay"><span class="badge">${escapeHtml(row.Sınıf || '—')} sınıfı</span>${row.status ? `<span class="badge olive">${escapeHtml(row.status)}</span>` : ''}</div></div>
      <div class="model-info"><div class="model-kicker"><span>${String(row.index + 1).padStart(3, '0')} · görselli sıra</span><span>${row.Ölçek ? `ölçek ${escapeHtml(row.Ölçek)}` : 'ölçek —'}</span></div>
        <h2>${escapeHtml(row.Model)}</h2>
        ${hasUsableImageUrl(row.source) ? `<a class="model-source" href="${escapeHtml(row.source)}" target="_blank" rel="noreferrer">${escapeHtml(hostOf(row.source))} ↗</a>` : '<span class="model-source">kaynak belirtilmemiş</span>'}
        <div class="economics"><div class="economic"><small>maliyet / adet</small><strong>${formatMoney(row.cost)}</strong></div><div class="economic"><small>satış fiyatı</small><strong>${formatMoney(row.sale)}</strong></div><div class="economic profit"><small>net kâr</small><strong>${formatMoney(row.profit)}</strong></div><div class="economic profit"><small>marj</small><strong>${formatPercent(row.margin)}</strong></div></div>
        <div class="meta-list"><div><small>gram</small><strong>${row.grams == null ? '—' : `${row.grams.toLocaleString('tr-TR')} g`}</strong></div><div><small>tabla</small><strong>${row.trayCount == null ? '—' : `${row.trayCount} adet`}</strong></div><div><small>süre</small><strong>${row.trayHours == null ? '—' : `${row.trayHours.toLocaleString('tr-TR')} sa`}</strong></div></div>
        <div class="card-footer"><span class="${locked ? 'lock-note' : ''}">${locked ? `${currentVote === 'like' ? 'Beğenildi' : 'Geçildi'} · ${state.mode === 'shared' ? 'ortak karar kilitli' : 'kişisel kararın'}` : 'sola geç · sağa beğen'}</span>${row['Drive STL URL'] ? `<a href="${escapeHtml(row['Drive STL URL'])}" target="_blank" rel="noreferrer">STL ↗</a>` : ''}</div>
      </div>`;
    card.tabIndex = 0; card.querySelector('img').addEventListener('error', () => removeBrokenImage(row.id), { once: true });
    $('#nextCard').innerHTML = previewMarkup(nextRow(row)); bindCardGestures(card, locked);
  }

  function renderStats() {
    const { liked, disliked, pending } = counts();
    $('#pendingCount').textContent = pending; $('#allCount').textContent = state.rows.length; $('#likedCount').textContent = liked; $('#dislikedCount').textContent = disliked;
    $('#statModels').textContent = state.loading ? '—' : state.rows.length;
    const margins = state.rows.map((row) => row.margin).filter((value) => value != null); const profits = state.rows.map((row) => row.profit).filter((value) => value != null);
    $('#statMargin').textContent = margins.length ? formatPercent(margins.reduce((a, b) => a + b, 0) / margins.length) : '—';
    $('#statProfit').textContent = profits.length ? formatMoney(profits.reduce((a, b) => a + b, 0) / profits.length) : '—';
    $('#statImages').textContent = state.loading ? '—' : state.rows.length; $('#excludedCount').textContent = state.excludedCount;
    const done = state.rows.length ? ((state.rows.length - pending) / state.rows.length) * 100 : 0;
    $('#progressLabel').textContent = `${state.rows.length - pending} / ${state.rows.length}`; $('#progressFill').style.width = `${done}%`;
    $('#progressHint').textContent = state.mode === 'shared' ? 'ortak kararlar' : `${state.participant || 'isim gir'} için kararlar`;
    $('#sessionNumber').textContent = state.recent.length; $('#sessionCopy').textContent = state.recent.length ? `${state.recent.length} karar anında uygulandı.` : 'Bu oturumda henüz karar yok.';
    $('#sessionBar').style.width = `${Math.min(100, state.recent.length * 10)}%`;
  }

  function renderRecent() {
    $('#recentList').innerHTML = state.recent.length
      ? state.recent.slice(0, 5).map((item) => `<div class="recent-item"><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><b class="${item.vote}">${item.vote === 'like' ? 'BEĞEN' : 'GEÇ'}</b></div>`).join('')
      : '<span class="muted">Henüz karar yok.</span>';
  }

  function renderQueue() {
    const status = state.queueStatus; const element = $('#queueStatus'); const retry = $('#retryQueue');
    retry.classList.toggle('hidden', !status.failed);
    if (!status.online) { element.className = 'queue-status offline'; element.innerHTML = `<strong>Çevrimdışı</strong><span>${status.total} karar cihazda güvende; bağlantı gelince gönderilecek.</span>`; return; }
    if (status.failed) { element.className = 'queue-status failed'; element.innerHTML = `<strong>${status.failed} kayıt bekliyor</strong><span>Otomatik denemeler tamamlanamadı. Kararlar cihazda tutuluyor.</span>`; return; }
    if (status.pending) { element.className = 'queue-status syncing'; element.innerHTML = `<strong>${status.pending} karar eşitleniyor</strong><span>Oylamaya devam edebilirsin.</span>`; return; }
    element.className = 'queue-status synced'; element.innerHTML = '<strong>Tüm kararlar eşitlendi</strong><span>Bekleyen Sheet kaydı yok.</span>';
  }

  function renderChrome() {
    document.querySelectorAll('[data-mode]').forEach((button) => { const active = button.dataset.mode === state.mode; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
    document.querySelectorAll('[data-filter]').forEach((button) => button.classList.toggle('active', button.dataset.filter === state.filter));
    $('#participantWrap').classList.toggle('hidden', state.mode !== 'personal'); $('#sharedNote').classList.toggle('hidden', state.mode !== 'shared'); $('#participant').value = state.participant;
    const row = currentRow(); const locked = row && isVoted(row); const disabled = !row || locked || state.transitioning;
    $('#dislikeButton').disabled = disabled; $('#likeButton').disabled = disabled; $('#undoVote').disabled = state.mode !== 'personal' || !state.history.length || state.transitioning;
    $('#undoVote').classList.toggle('hidden', state.mode !== 'personal');
  }

  function render() { renderChrome(); renderStats(); renderRecent(); renderQueue(); renderCard(); }

  function queuedVotesForCurrentIdentity() {
    return state.queue.items.filter((item) => item.payload.mode === state.mode && (state.mode === 'shared' || item.payload.participant === state.participant));
  }

  function applyQueuedVotes() {
    for (const item of queuedVotesForCurrentIdentity()) {
      const { action = 'vote', id, vote } = item.payload;
      if (state.mode === 'personal') { if (action === 'undo') delete state.myVotes[id]; else state.myVotes[id] = vote; }
      else if (action !== 'undo') { const row = state.rows.find((candidate) => candidate.id === id); if (row) row.like = voteLabel(vote); }
    }
    if (state.mode === 'personal' && state.participant) saveVotes();
  }

  async function sendWrite(payload) {
    let response;
    try { response = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
    catch { throw new Error('Ağa ulaşılamadı'); }
    let data = {}; try { data = await response.json(); } catch { /* use safe status message */ }
    if (!response.ok || !data.ok) { const error = new Error(data.message || data.error || `Kayıt servisi ${response.status}`); error.retryable = response.status >= 500 || response.status === 429; throw error; }
    state.sheetLive = true; setConnection('live', 'Sheet canlı'); return data;
  }

  async function loadSheet() {
    state.loading = true; render();
    try {
      const response = await fetch(`${CSV_URL}&t=${Date.now()}`, { cache: 'no-store' }); if (!response.ok) throw new Error(`Sheet ${response.status}`);
      const prepared = prepareRows(parseCsv(await response.text())); Object.assign(state, prepared, { sheetLive: true, loadError: null });
      applyQueuedVotes(); setConnection('live', 'Sheet canlı');
      $('#footerStatus').textContent = prepared.excludedCount ? `${prepared.excludedCount} görselsiz/geçersiz satır desteye alınmadı.` : 'Yalnız kullanılabilir görsel URL içeren modeller gösteriliyor.';
    } catch (error) { state.loadError = error; state.rows = []; setConnection('error', 'Sheet okunamadı'); $('#footerStatus').textContent = 'Sheet okunamadı; bağlantıyı ve paylaşım iznini kontrol et.'; }
    finally { state.loading = false; render(); if (state.queueStatus.online) void state.queue.pump(); }
  }

  async function loadParticipantVotes() {
    if (state.mode !== 'personal' || !state.participant) return;
    state.myVotes = safeJson(voteStorageKey(), {}); applyQueuedVotes(); render();
    try {
      const response = await fetch(`${API_URL}?participant=${encodeURIComponent(state.participant)}`, { cache: 'no-store' }); const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || data.error);
      state.myVotes = { ...(data.votes || {}) }; applyQueuedVotes(); saveVotes(); setConnection('live', 'Sheet canlı');
    } catch { setConnection(state.queueStatus.total ? 'warning' : 'error', state.queueStatus.total ? 'eşitleme bekliyor' : 'oylar okunamadı'); }
    render();
  }

  function optimisticVote(row, vote) {
    const previous = state.myVotes[row.id] || '';
    if (state.mode === 'shared') row.like = voteLabel(vote); else { state.myVotes[row.id] = vote; saveVotes(); }
    if (state.mode === 'personal') state.history = [{ id: row.id, name: row.Model, vote, previous }, ...state.history.filter((item) => item.id !== row.id)].slice(0, 20);
    state.recent = [{ id: row.id, name: row.Model, vote }, ...state.recent.filter((item) => item.id !== row.id)].slice(0, 10);
    state.queue.enqueue({ action: 'vote', mode: state.mode, participant: state.participant, id: row.id, vote }); renderStats(); renderRecent(); renderQueue();
  }

  function animateVote(vote) {
    const row = currentRow(); if (!row || state.transitioning || isVoted(row)) return;
    if (state.mode === 'personal' && !state.participant) { $('#participant').focus(); toast('Önce adını veya rumuzunu yaz.'); return; }
    state.transitioning = true; optimisticVote(row, vote);
    const card = $('#modelCard'); const direction = vote === 'like' ? 1 : -1;
    card.querySelector(`.swipe-stamp.${vote}`).style.opacity = '1'; card.querySelector(`.swipe-wash.${vote}`).style.opacity = '1';
    card.classList.add('swipe-out', vote); card.style.transform = `translate3d(${direction * Math.max(innerWidth, 760)}px, -18px, 0) rotate(${direction * 16}deg)`; card.style.opacity = '0';
    setTimeout(() => { state.transitioning = false; state.currentId = null; render(); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220);
  }

  function undoLastVote() {
    if (state.mode !== 'personal' || state.transitioning || !state.history.length) return;
    const [last, ...rest] = state.history; state.history = rest;
    if (last.previous) { state.myVotes[last.id] = last.previous; state.queue.enqueue({ action: 'vote', mode: 'personal', participant: state.participant, id: last.id, vote: last.previous }); }
    else { delete state.myVotes[last.id]; state.queue.enqueue({ action: 'undo', mode: 'personal', participant: state.participant, id: last.id }); }
    saveVotes(); state.recent = state.recent.filter((item) => item.id !== last.id); state.currentId = last.id; render();
    $('#modelCard').focus({ preventScroll: true }); toast('Son karar geri alındı; Sheet kaydı arka planda güncelleniyor.');
  }

  function bindCardGestures(card, locked) {
    if (locked) return;
    let pointerId = null; let startX = 0; let startY = 0; let horizontal = false;
    const reset = () => { pointerId = null; horizontal = false; card.classList.remove('dragging'); card.style.transform = ''; card.querySelectorAll('.swipe-stamp, .swipe-wash').forEach((element) => { element.style.opacity = ''; }); };
    card.addEventListener('pointerdown', (event) => { if (state.transitioning || event.button !== 0 || event.target.closest('a, button, input, select')) return; pointerId = event.pointerId; startX = event.clientX; startY = event.clientY; card.setPointerCapture(pointerId); card.classList.add('dragging'); });
    card.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return; const dx = event.clientX - startX; const dy = event.clientY - startY;
      if (!horizontal && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { reset(); return; }
      if (Math.abs(dx) > 7) horizontal = true; if (!horizontal) return; event.preventDefault();
      card.style.transform = `translate3d(${dx}px, ${Math.abs(dx) * -.025}px, 0) rotate(${Math.max(-12, Math.min(12, dx / 18))}deg)`;
      const strength = Math.min(1, Math.max(0, (Math.abs(dx) - 20) / 90)); const vote = dx > 0 ? 'like' : 'dislike';
      card.querySelectorAll('.swipe-stamp, .swipe-wash').forEach((element) => { element.style.opacity = element.classList.contains(vote) ? String(strength) : '0'; });
    });
    const release = (event) => { if (event.pointerId !== pointerId) return; const dx = event.clientX - startX; const threshold = Math.min(120, card.clientWidth * .22); if (horizontal && Math.abs(dx) >= threshold) { pointerId = null; animateVote(dx > 0 ? 'like' : 'dislike'); } else reset(); };
    card.addEventListener('pointerup', release); card.addEventListener('pointercancel', reset);
  }

  function bindEvents() {
    document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => { if (state.transitioning) return; state.mode = button.dataset.mode; state.filter = 'pending'; state.currentId = null; storage.setItem('print-lab-mode', state.mode); if (state.mode === 'personal') void loadParticipantVotes(); else { applyQueuedVotes(); render(); } }));
    document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; state.currentId = null; render(); }));
    $('#saveParticipant').addEventListener('click', () => { const value = $('#participant').value.trim(); if (!value) { toast('Bir ad veya rumuz yaz.'); return; } state.participant = value; storage.setItem('print-lab-participant', value); state.currentId = null; void loadParticipantVotes(); toast(`${value} için kişisel puanlama açıldı.`); });
    $('#participant').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#saveParticipant').click(); });
    $('#search').addEventListener('input', (event) => { state.search = event.target.value; state.currentId = null; render(); }); $('#sort').addEventListener('change', (event) => { state.sort = event.target.value; state.currentId = null; render(); });
    $('#dislikeButton').addEventListener('click', () => animateVote('dislike')); $('#likeButton').addEventListener('click', () => animateVote('like')); $('#undoVote').addEventListener('click', undoLastVote); $('#retryQueue').addEventListener('click', () => state.queue.retryNow());
    $('#resetSession').addEventListener('click', () => { state.recent = []; state.history = []; render(); toast('Oturum özeti temizlendi. Kaydedilmiş kararlar korunur.'); });
    document.addEventListener('keydown', (event) => { if (event.target.matches('input, select, textarea')) return; if (event.key === 'ArrowLeft') { event.preventDefault(); animateVote('dislike'); } if (event.key === 'ArrowRight') { event.preventDefault(); animateVote('like'); } if (event.key.toLocaleLowerCase('tr-TR') === 'z') { event.preventDefault(); undoLastVote(); } });
    window.addEventListener('online', () => { state.queue.setOnline(true); setConnection('warning', 'eşitleniyor'); }); window.addEventListener('offline', () => { state.queue.setOnline(false); setConnection('offline', 'çevrimdışı'); });
    window.addEventListener('pagehide', () => state.queue.persist());
  }

  state.queue = new PersistentVoteQueue({ storage, send: sendWrite, onChange: (status) => { state.queueStatus = status; if (document.readyState !== 'loading') renderQueue(); } });
  state.queue.online = navigator.onLine; state.queue.persist(); state.myVotes = state.participant ? safeJson(voteStorageKey(), safeJson('print-lab-votes', {})) : {};
  bindEvents(); render(); void loadSheet(); if (state.mode === 'personal' && state.participant) void loadParticipantVotes();
}
