export default async function handler(req, res) {
  const endpoint = process.env.SHEET_WRITE_URL;
  const secret = process.env.SHEET_WRITE_SECRET;

  if (!endpoint || !secret) {
    return res.status(503).json({ ok: false, error: 'SHEET_WRITE_URL veya SHEET_WRITE_SECRET tanımlı değil.' });
  }

  try {
    if (req.method === 'GET') {
      const participant = String(req.query?.participant || '').trim();
      if (!participant) return res.status(400).json({ ok: false, error: 'participant gerekli.' });
      const url = new URL(endpoint);
      url.searchParams.set('action', 'list');
      url.searchParams.set('participant', participant);
      url.searchParams.set('secret', secret);
      const upstream = await fetch(url);
      const data = await upstream.json();
      return res.status(upstream.ok && data.ok ? 200 : 502).json(data);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const payload = { ...body, secret };
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await upstream.json();
      return res.status(upstream.ok && data.ok ? 200 : 409).json(data);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    return res.status(502).json({ ok: false, error: 'Sheet write endpoint erişilemedi.' });
  }
}
