const SPREADSHEET_ID = '1tJtASEdnz5HCUtkVqlTua-t2XoYGmHxL3FgJO7Y4UVI';
const DATA_SHEET_NAME = ''; // boşsa aktif sekme kullanılır
const VOTES_SHEET_NAME = 'Oylamalar';

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function secret_() {
  return PropertiesService.getScriptProperties().getProperty('WRITE_SECRET') || '';
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
  if (!secret_() || params.secret !== secret_()) return json_({ ok: false, error: 'unauthorized' });
  if (params.action !== 'list') return json_({ ok: false, error: 'unknown action' });
  const participant = String(params.participant || '').trim();
  if (!participant) return json_({ ok: false, error: 'participant gerekli' });

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
  try { payload = JSON.parse(e.postData.contents || '{}'); } catch (error) { return json_({ ok: false, error: 'invalid json' }); }
  if (!secret_() || payload.secret !== secret_()) return json_({ ok: false, error: 'unauthorized' });

  const mode = String(payload.mode || '').trim();
  const id = String(payload.id || '').trim();
  const vote = String(payload.vote || '').trim();
  const participant = String(payload.participant || '').trim();
  if (!id || !['like', 'dislike'].includes(vote)) return json_({ ok: false, error: 'geçersiz oy' });
  if (mode === 'personal' && !participant) return json_({ ok: false, error: 'personal modda participant gerekli' });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (mode === 'shared') {
      const sheet = sheet_();
      const values = sheet.getDataRange().getValues();
      const headers = headerMap_(values);
      if (headers['Kimlik'] === undefined || headers['Beğeni'] === undefined) return json_({ ok: false, error: 'Kimlik veya Beğeni kolonu yok' });
      const rowIndex = findRow_(values, id, headers['Kimlik']);
      if (rowIndex < 0) return json_({ ok: false, error: 'model bulunamadı' });
      const cell = sheet.getRange(rowIndex + 1, headers['Beğeni'] + 1);
      if (String(cell.getValue()).trim()) return json_({ ok: false, error: 'bu model daha önce ortak olarak puanlandı' });
      cell.setValue(vote === 'like' ? '👍 beğendim' : '👎 beğenmedim');
      SpreadsheetApp.flush();
      return json_({ ok: true, mode, id, vote });
    }

    if (mode === 'personal') {
      const votesSheet = ensureVotesSheet_();
      const values = votesSheet.getDataRange().getValues();
      const headers = headerMap_(values);
      for (let i = 1; i < values.length; i += 1) {
        const samePerson = String(values[i][headers['Kullanıcı']]).trim() === participant;
        const sameModel = String(values[i][headers['Model ID']]).trim() === id;
        if (samePerson && sameModel) return json_({ ok: false, error: 'bu kullanıcı bu modeli daha önce puanladı' });
      }
      const dataSheet = sheet_();
      const dataValues = dataSheet.getDataRange().getValues();
      const dataHeaders = headerMap_(dataValues);
      const rowIndex = findRow_(dataValues, id, dataHeaders['Kimlik']);
      const modelName = rowIndex >= 0 && dataHeaders['Model'] !== undefined ? dataValues[rowIndex][dataHeaders['Model']] : '';
      votesSheet.appendRow([new Date(), participant, id, vote, modelName]);
      SpreadsheetApp.flush();
      return json_({ ok: true, mode, id, vote });
    }

    return json_({ ok: false, error: 'mode personal veya shared olmalı' });
  } finally {
    lock.releaseLock();
  }
}
