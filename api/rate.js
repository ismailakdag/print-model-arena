const allowedModes = new Set(['personal']);
const allowedVotes = new Set(['like', 'dislike']);
const MAX_PARTICIPANT_LENGTH = 40;
const MAX_ID_LENGTH = 160;
const MAX_OPERATION_ID_LENGTH = 100;

function configState() {
  return {
    endpointConfigured: Boolean(process.env.SHEET_WRITE_URL),
    secretConfigured: Boolean(process.env.SHEET_WRITE_SECRET),
  };
}

function safeEndpointHost(endpoint) {
  try { return new URL(endpoint).hostname; } catch { return null; }
}

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function configuredError(res) {
  return send(res, 503, {
    ok: false,
    code: 'proxy_not_configured',
    message: 'Yazma servisi yapılandırılmamış: Vercel Production ortamında SHEET_WRITE_URL ve SHEET_WRITE_SECRET birlikte tanımlanmalı.',
    config: configState(),
  });
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body !== 'string') return body;
  return JSON.parse(body);
}

async function readJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return null; }
}

async function callUpstream(endpoint, options = {}) {
  const upstream = await fetch(endpoint, options);
  const data = await readJson(upstream);
  return { upstream, data };
}

async function statusHandler(res, endpoint, secret) {
  const config = configState();
  if (!config.endpointConfigured || !config.secretConfigured) return configuredError(res);
  const url = new URL(endpoint);
  url.searchParams.set('action', 'status');
  url.searchParams.set('secret', secret);
  try {
    const { upstream, data } = await callUpstream(url);
    if (!upstream.ok || !data || data.ok !== true) {
      return send(res, 502, {
        ok: false,
        code: data?.code || 'upstream_rejected',
        message: 'Apps Script yazma servisi yanıt verdi ancak hazır olduğunu doğrulayamadı.',
        config,
        upstream: { host: safeEndpointHost(endpoint), status: 'rejected', httpStatus: upstream.status },
      });
    }
    return send(res, 200, {
      ok: true,
      service: 'write-proxy',
      config,
      upstream: { host: safeEndpointHost(endpoint), status: 'ok' },
    });
  } catch {
    return send(res, 502, {
      ok: false,
      code: 'upstream_unreachable',
      message: 'Apps Script yazma servisine ulaşılamadı. Deployment URL’sinin /exec ile bittiğini ve erişimin Anyone olduğunu kontrol edin.',
      config,
      upstream: { host: safeEndpointHost(endpoint), status: 'unreachable' },
    });
  }
}

export default async function handler(req, res) {
  const endpoint = process.env.SHEET_WRITE_URL;
  const secret = process.env.SHEET_WRITE_SECRET;
  if (!endpoint || !secret) return configuredError(res);

  try {
    if (req.method === 'GET') {
      if (String(req.query?.status || '') === '1') return statusHandler(res, endpoint, secret);
      const participant = String(req.query?.participant || '').trim();
      if (!participant) return send(res, 400, { ok: false, code: 'participant_required', message: 'Kişisel oyları okumak için participant gerekli.' });
      if (participant.length > MAX_PARTICIPANT_LENGTH) return send(res, 400, { ok: false, code: 'participant_too_long', message: 'participant en fazla 40 karakter olabilir.' });
      const url = new URL(endpoint);
      url.searchParams.set('action', 'list');
      url.searchParams.set('participant', participant);
      url.searchParams.set('secret', secret);
      const { upstream, data } = await callUpstream(url);
      if (!data) return send(res, 502, { ok: false, code: 'upstream_invalid_json', message: 'Apps Script geçerli JSON döndürmedi.' });
      if (!upstream.ok || data.ok !== true) return send(res, 502, { ok: false, code: data.code || 'upstream_rejected', message: data.error || 'Apps Script isteği reddetti.' });
      return send(res, 200, data);
    }

    if (req.method === 'POST') {
      let body;
      try { body = parseBody(req.body); } catch { return send(res, 400, { ok: false, code: 'invalid_json', message: 'İstek gövdesi geçerli JSON değil.' }); }
      const action = String(body?.action || 'vote');
      if (!['vote', 'undo'].includes(action)) return send(res, 400, { ok: false, code: 'invalid_action', message: 'action vote veya undo olmalı.' });
      const participant = String(body?.participant || '').trim();
      const id = String(body?.id || '').trim();
      const operationId = String(body?.operationId || '').trim();
      const validBase = body && String(body.mode) === 'personal' && id && participant;
      const validVote = allowedModes.has(String(body?.mode || '')) && allowedVotes.has(String(body?.vote || '')) && id;
      if (action === 'undo' && !validBase) return send(res, 400, { ok: false, code: 'invalid_undo_payload', message: 'Geri alma için personal mode, participant ve id gerekli.' });
      if (action !== 'undo' && !validVote) return send(res, 400, { ok: false, code: 'invalid_vote_payload', message: 'Oy isteğinde mode, id ve vote alanları geçerli olmalı.' });
      if (action !== 'undo' && String(body.mode) === 'personal' && !participant) {
        return send(res, 400, { ok: false, code: 'participant_required', message: 'Kişisel oy için participant gerekli.' });
      }
      if (participant.length > MAX_PARTICIPANT_LENGTH || id.length > MAX_ID_LENGTH || operationId.length > MAX_OPERATION_ID_LENGTH) {
        return send(res, 400, { ok: false, code: 'payload_too_long', message: 'Oy isteğindeki alanlardan biri izin verilen uzunluğu aşıyor.' });
      }
      const payload = { action, mode: String(body.mode), participant, id, vote: body.vote ? String(body.vote) : undefined, operationId: operationId || undefined, contractVersion: 2, secret };
      let upstream;
      let data;
      try {
        ({ upstream, data } = await callUpstream(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }));
      } catch {
        return send(res, 502, { ok: false, code: 'upstream_unreachable', message: 'Apps Script yazma servisine ulaşılamadı. Deployment URL’sini ve Vercel Production env ayarlarını kontrol edin.' });
      }
      if (!data) return send(res, 502, { ok: false, code: 'upstream_invalid_json', message: 'Apps Script geçerli JSON döndürmedi.' });
      if (!upstream.ok || data.ok !== true) {
        const conflict = data.code === 'shared_vote_locked' || upstream.status === 409;
        const invalid = ['model_not_found', 'missing_columns', 'invalid_votes_sheet'].includes(data.code);
        return send(res, conflict ? 409 : invalid ? 422 : 502, { ok: false, code: data.code || 'upstream_rejected', message: data.error || 'Apps Script isteği reddetti.' });
      }
      return send(res, 200, data);
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, code: 'method_not_allowed', message: 'GET veya POST kullanın.' });
  } catch {
    return send(res, 502, { ok: false, code: 'proxy_error', message: 'Yazma proxy’si isteği tamamlayamadı.' });
  }
}
