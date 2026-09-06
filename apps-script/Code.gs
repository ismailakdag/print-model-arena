const SPREADSHEET_ID = '1tJtASEdnz5HCUtkVqlTua-t2XoYGmHxL3FgJO7Y4UVI';
const DATA_SHEET_NAME = ''; // boşsa ilk sekme kullanılır
const VOTES_SHEET_NAME = 'Oylamalar';
const PARTICIPANT_COLUMN_PREFIX = 'Oy · ';

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function secret_() {
  return PropertiesService.getScriptProperties().getProperty('WRITE_SECRET') || '';
}

function authorized_(candidate) {
  const expected = secret_();
  return Boolean(expected && String(candidate || '') === expected);
}

function sheet_() {
  const book = SpreadsheetApp.openById(SPREADSHEET_ID);
  return DATA_SHEET_NAME ? book.getSheetByName(DATA_SHEET_NAME) : book.getSheets()[0];
}

function headerMap_(values) {
  return (values[0] || []).reduce((map, value, index) => {
    if (String(value).trim()) map[String(value).trim()] = index;
    return map;
  }, {});
}

function findRow_(values, id, idColumn) {
  if (idColumn === undefined) return -1;
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][idColumn]).trim() === id) return i;
  }
  return -1;
}

function participantHeader_(participant) {
  const safeName = String(participant || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return PARTICIPANT_COLUMN_PREFIX + safeName;
}

function normalizedVote_(value) {
  const normalized = String(value || '').toLocaleLowerCase('tr-TR');
  if (normalized.indexOf('beğenmedim') >= 0 || normalized === 'dislike') return 'dislike';
  if (normalized.indexOf('beğendim') >= 0 || normalized === 'like') return 'like';
  return '';
}

function ensureParticipantColumn_(sheet, values, participant) {
  const header = participantHeader_(participant);
  const headers = headerMap_(values);
  if (headers[header] !== undefined) return headers[header];
  const columnIndex = Math.max(1, sheet.getLastColumn()) + 1;
  if (columnIndex > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
  sheet.getRange(1, columnIndex).setValue(header);
  return columnIndex - 1;
}

function ensureVotesSheet_() {
  const book = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = book.getSheetByName(VOTES_SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(VOTES_SHEET_NAME);
    sheet.getRange(1, 1, 1, 6).setValues([['Zaman', 'Kullanıcı', 'Model ID', 'Oy', 'Model', 'İşlem ID']]);
    sheet.setFrozenRows(1);
  } else {
    const values = sheet.getDataRange().getValues();
    const headers = headerMap_(values);
    if (headers['İşlem ID'] === undefined) {
      const columnIndex = sheet.getLastColumn() + 1;
      if (columnIndex > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
      sheet.getRange(1, columnIndex).setValue('İşlem ID');
    }
  }
  return sheet;
}

function findLegacyVoteRow_(values, headers, participant, id) {
  if (headers['Kullanıcı'] === undefined || headers['Model ID'] === undefined) return -1;
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][headers['Kullanıcı']]).trim() === participant && String(values[i][headers['Model ID']]).trim() === id) return i;
  }
  return -1;
}

function mirrorLegacyVote_(participant, id, vote, modelName, operationId) {
  const votesSheet = ensureVotesSheet_();
  const values = votesSheet.getDataRange().getValues();
  const headers = headerMap_(values);
  const required = ['Zaman', 'Kullanıcı', 'Model ID', 'Oy', 'Model', 'İşlem ID'];
  if (required.some((header) => headers[header] === undefined)) throw new Error('Oylamalar kolonları eksik');
  const existingRow = findLegacyVoteRow_(values, headers, participant, id);
  if (existingRow >= 0) {
    votesSheet.getRange(existingRow + 1, headers['Zaman'] + 1).setValue(new Date());
    votesSheet.getRange(existingRow + 1, headers['Oy'] + 1).setValue(vote);
    votesSheet.getRange(existingRow + 1, headers['Model'] + 1).setValue(modelName || '');
    votesSheet.getRange(existingRow + 1, headers['İşlem ID'] + 1).setValue(operationId || '');
    return true;
  }
  const row = new Array(votesSheet.getLastColumn()).fill('');
  row[headers['Zaman']] = new Date(); row[headers['Kullanıcı']] = participant; row[headers['Model ID']] = id;
  row[headers['Oy']] = vote; row[headers['Model']] = modelName || ''; row[headers['İşlem ID']] = operationId || '';
  votesSheet.appendRow(row);
  return false;
}

function deleteLegacyVote_(participant, id) {
  const book = SpreadsheetApp.openById(SPREADSHEET_ID);
  const votesSheet = book.getSheetByName(VOTES_SHEET_NAME);
  if (!votesSheet || votesSheet.getLastRow() < 2) return false;
  const values = votesSheet.getDataRange().getValues();
  const headers = headerMap_(values);
  const rowIndex = findLegacyVoteRow_(values, headers, participant, id);
  if (rowIndex < 0) return false;
  votesSheet.deleteRow(rowIndex + 1);
  return true;
}

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  if (!authorized_(params.secret)) return json_({ ok: false, code: 'unauthorized', error: 'unauthorized' });
  if (params.action === 'status') return json_({ ok: true, service: 'sheet-write', status: 'ready', contractVersion: 2 });
  if (params.action !== 'list') return json_({ ok: false, code: 'unknown_action', error: 'unknown action' });
  const participant = String(params.participant || '').trim();
  if (!participant) return json_({ ok: false, code: 'participant_required', error: 'participant gerekli' });

  const votes = {};
  const dataValues = sheet_().getDataRange().getValues();
  const dataHeaders = headerMap_(dataValues);
  const participantColumn = dataHeaders[participantHeader_(participant)];
  if (participantColumn !== undefined && dataHeaders['Kimlik'] !== undefined) {
    for (let i = 1; i < dataValues.length; i += 1) {
      const vote = normalizedVote_(dataValues[i][participantColumn]);
      const id = String(dataValues[i][dataHeaders['Kimlik']]).trim();
      if (id && vote) votes[id] = vote;
    }
  }

  const legacySheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(VOTES_SHEET_NAME);
  if (legacySheet && legacySheet.getLastRow() >= 2) {
    const legacyValues = legacySheet.getDataRange().getValues();
    const legacyHeaders = headerMap_(legacyValues);
    if (legacyHeaders['Kullanıcı'] !== undefined && legacyHeaders['Model ID'] !== undefined && legacyHeaders['Oy'] !== undefined) {
      for (let i = 1; i < legacyValues.length; i += 1) {
        if (String(legacyValues[i][legacyHeaders['Kullanıcı']]).trim() !== participant) continue;
        const id = String(legacyValues[i][legacyHeaders['Model ID']]).trim();
        const vote = normalizedVote_(legacyValues[i][legacyHeaders['Oy']]);
        if (id && vote && !votes[id]) votes[id] = vote;
      }
    }
  }
  return json_({ ok: true, votes, storage: participantColumn === undefined ? 'legacy' : 'named-column', contractVersion: 2 });
}

function doPost(e) {
  let payload = {};
  try { payload = JSON.parse(e.postData.contents || '{}'); } catch (error) { return json_({ ok: false, code: 'invalid_json', error: 'invalid json' }); }
  if (!authorized_(payload.secret)) return json_({ ok: false, code: 'unauthorized', error: 'unauthorized' });

  const action = String(payload.action || 'vote').trim();
  const mode = String(payload.mode || '').trim();
  const id = String(payload.id || '').trim();
  const vote = String(payload.vote || '').trim();
  const participant = String(payload.participant || '').trim();
  const operationId = String(payload.operationId || '').trim();
  if (action === 'undo') {
    if (mode !== 'personal' || !id || !participant) return json_({ ok: false, code: 'invalid_undo', error: 'geri alma için personal mod, participant ve id gerekli' });
  } else if (!id || ['like', 'dislike'].indexOf(vote) < 0) return json_({ ok: false, code: 'invalid_vote', error: 'geçersiz oy' });
  if (mode === 'personal' && !participant) return json_({ ok: false, code: 'participant_required', error: 'personal modda participant gerekli' });
  if (mode !== 'personal') return json_({ ok: false, code: 'shared_mode_disabled', error: 'ortak yazma bu sürümde kapalı' });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const dataSheet = sheet_();
    const dataValues = dataSheet.getDataRange().getValues();
    const dataHeaders = headerMap_(dataValues);
    if (dataHeaders['Kimlik'] === undefined) return json_({ ok: false, code: 'missing_columns', error: 'Kimlik kolonu yok' });
    const rowIndex = findRow_(dataValues, id, dataHeaders['Kimlik']);
    if (rowIndex < 0) return json_({ ok: false, code: 'model_not_found', error: 'model bulunamadı' });

    if (mode === 'shared') {
      if (dataHeaders['Beğeni'] === undefined) return json_({ ok: false, code: 'missing_columns', error: 'Beğeni kolonu yok' });
      const cell = dataSheet.getRange(rowIndex + 1, dataHeaders['Beğeni'] + 1);
      const existing = normalizedVote_(cell.getValue());
      if (existing) {
        if (existing === vote) return json_({ ok: true, mode, id, vote, duplicate: true, operationId });
        return json_({ ok: false, code: 'shared_vote_locked', error: 'bu model daha önce ortak olarak puanlandı' });
      }
      cell.setValue(vote === 'like' ? '👍 beğendim' : '👎 beğenmedim');
      SpreadsheetApp.flush();
      return json_({ ok: true, mode, id, vote, replaced: false, operationId, contractVersion: 2 });
    }

    if (mode === 'personal') {
      const participantColumn = ensureParticipantColumn_(dataSheet, dataValues, participant);
      const participantCell = dataSheet.getRange(rowIndex + 1, participantColumn + 1);
      if (action === 'undo') {
        participantCell.clearContent();
        const undone = deleteLegacyVote_(participant, id);
        SpreadsheetApp.flush();
        return json_({ ok: true, mode, id, undone, operationId, storage: 'named-column', contractVersion: 2 });
      }
      const replaced = Boolean(normalizedVote_(participantCell.getValue()));
      participantCell.setValue(vote);
      const modelName = dataHeaders['Model'] === undefined ? '' : dataValues[rowIndex][dataHeaders['Model']];
      mirrorLegacyVote_(participant, id, vote, modelName, operationId);
      SpreadsheetApp.flush();
      return json_({ ok: true, mode, id, vote, replaced, operationId, storage: 'named-column+legacy', contractVersion: 2 });
    }

    return json_({ ok: false, code: 'invalid_mode', error: 'mode personal veya shared olmalı' });
  } finally { lock.releaseLock(); }
}
