const SPREADSHEET_ID = '1tJtASEdnz5HCUtkVqlTua-t2XoYGmHxL3FgJO7Y4UVI';
const DATA_SHEET_NAME = ''; // boşsa ilk sekme kullanılır
const VOTES_SHEET_NAME = 'Oylamalar';

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
  return values[0].reduce((map, value, index) => {
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

function ensureVotesSheet_() {
  const book = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = book.getSheetByName(VOTES_SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(VOTES_SHEET_NAME);
    sheet.getRange(1, 1, 1, 5).setValues([['Zaman', 'Kullanıcı', 'Model ID', 'Oy', 'Model']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  if (!authorized_(params.secret)) return json_({ ok: false, code: 'unauthorized', error: 'unauthorized' });
  if (params.action === 'status') return json_({ ok: true, service: 'sheet-write', status: 'ready' });
  if (params.action !== 'list') return json_({ ok: false, code: 'unknown_action', error: 'unknown action' });
  const participant = String(params.participant || '').trim();
  if (!participant) return json_({ ok: false, code: 'participant_required', error: 'participant gerekli' });

  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(VOTES_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return json_({ ok: true, votes: {} });
  const values = sheet.getDataRange().getValues();
  const headers = headerMap_(values);
  const votes = {};
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][headers['Kullanıcı']]).trim() === participant) {
      votes[String(values[i][headers['Model ID']]).trim()] = String(values[i][headers['Oy']]).trim();
    }
  }
  return json_({ ok: true, votes });
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
  if (action === 'undo') {
    if (mode !== 'personal' || !id || !participant) return json_({ ok: false, code: 'invalid_undo', error: 'geri alma için personal mod, participant ve id gerekli' });
  } else if (!id || !['like', 'dislike'].includes(vote)) {
    return json_({ ok: false, code: 'invalid_vote', error: 'geçersiz oy' });
  }
  if (mode === 'personal' && !participant) return json_({ ok: false, code: 'participant_required', error: 'personal modda participant gerekli' });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (mode === 'shared') {
      const sheet = sheet_();
      const values = sheet.getDataRange().getValues();
      const headers = headerMap_(values);
      if (headers['Kimlik'] === undefined || headers['Beğeni'] === undefined) return json_({ ok: false, code: 'missing_columns', error: 'Kimlik veya Beğeni kolonu yok' });
      const rowIndex = findRow_(values, id, headers['Kimlik']);
      if (rowIndex < 0) return json_({ ok: false, code: 'model_not_found', error: 'model bulunamadı' });
      const cell = sheet.getRange(rowIndex + 1, headers['Beğeni'] + 1);
      if (String(cell.getValue()).trim()) return json_({ ok: false, code: 'shared_vote_locked', error: 'bu model daha önce ortak olarak puanlandı' });
      cell.setValue(vote === 'like' ? '👍 beğendim' : '👎 beğenmedim');
      SpreadsheetApp.flush();
      return json_({ ok: true, mode, id, vote, replaced: false });
    }

    if (mode === 'personal') {
      const votesSheet = ensureVotesSheet_();
      const values = votesSheet.getDataRange().getValues();
      const headers = headerMap_(values);
      const votes = ['Zaman', 'Kullanıcı', 'Model ID', 'Oy', 'Model'];
      if (votes.some((header) => headers[header] === undefined)) return json_({ ok: false, code: 'invalid_votes_sheet', error: 'Oylamalar kolonları eksik' });
      for (let i = 1; i < values.length; i += 1) {
        const samePerson = String(values[i][headers['Kullanıcı']]).trim() === participant;
        const sameModel = String(values[i][headers['Model ID']]).trim() === id;
        if (samePerson && sameModel && action === 'undo') {
          votesSheet.deleteRow(i + 1);
          SpreadsheetApp.flush();
          return json_({ ok: true, mode, id, undone: true });
        }
      }
      if (action === 'undo') return json_({ ok: true, mode, id, undone: false });
      const dataSheet = sheet_();
      const dataValues = dataSheet.getDataRange().getValues();
      const dataHeaders = headerMap_(dataValues);
      const rowIndex = findRow_(dataValues, id, dataHeaders['Kimlik']);
      const modelName = rowIndex >= 0 && dataHeaders['Model'] !== undefined ? dataValues[rowIndex][dataHeaders['Model']] : '';
      for (let i = 1; i < values.length; i += 1) {
        const samePerson = String(values[i][headers['Kullanıcı']]).trim() === participant;
        const sameModel = String(values[i][headers['Model ID']]).trim() === id;
        if (samePerson && sameModel) {
          votesSheet.getRange(i + 1, headers['Zaman'] + 1).setValue(new Date());
          votesSheet.getRange(i + 1, headers['Oy'] + 1).setValue(vote);
          if (headers['Model'] !== undefined && modelName) votesSheet.getRange(i + 1, headers['Model'] + 1).setValue(modelName);
          SpreadsheetApp.flush();
          return json_({ ok: true, mode, id, vote, replaced: true });
        }
      }
      votesSheet.appendRow([new Date(), participant, id, vote, modelName]);
      SpreadsheetApp.flush();
      return json_({ ok: true, mode, id, vote, replaced: false });
    }

    return json_({ ok: false, code: 'invalid_mode', error: 'mode personal veya shared olmalı' });
  } finally {
    lock.releaseLock();
  }
}
