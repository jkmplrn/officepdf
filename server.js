const express = require('express');
const fetch   = require('node-fetch');
const FormData = require('form-data');
const multer  = require('multer');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB limit

// ── Stirling-PDF URL ──────────────────────────────────────────────
// In Railway: set STIRLING_URL as an environment variable
// Value should be the internal Railway URL of your Stirling-PDF service
// Example: http://stirling-pdf.railway.internal:8080
const STIRLING = (process.env.STIRLING_URL || 'http://stirling-pdf:8080').replace(/\/$/, '');

app.use(express.static('public'));

// ── Helper: proxy a Stirling response back to the browser ─────────
function pipeStirrling(stirlingRes, res, filename) {
  const ct = stirlingRes.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  stirlingRes.body.pipe(res);
}

// ── 1. COMPRESS PDF ───────────────────────────────────────────────
// level: 'low' | 'medium' | 'high'
app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const levelMap = { low: '2', medium: '3', high: '4' };
    const optimizeLevel = levelMap[req.body.level] || '3';

    const form = new FormData();
    form.append('fileInput', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });
    form.append('optimizeLevel', optimizeLevel);

    const r = await fetch(`${STIRLING}/api/v1/general/compress-pdf`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: 'Stirling error: ' + txt });
    }

    pipeStirrling(r, res, 'compressed.pdf');
  } catch (err) {
    console.error('compress error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. PDF TO IMAGE ───────────────────────────────────────────────
// Returns a ZIP of PNG images, one per page
app.post('/api/pdf-to-img', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('fileInput', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });
    form.append('imageFormat', 'png');
    form.append('singleOrMultiple', 'multiple');
    form.append('colorType', 'color');
    form.append('dpi', '150');

    const r = await fetch(`${STIRLING}/api/v1/convert/pdf/img`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: 'Stirling error: ' + txt });
    }

    pipeStirrling(r, res, 'pdf-images.zip');
  } catch (err) {
    console.error('pdf-to-img error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 3. PDF TO WORD ────────────────────────────────────────────────
app.post('/api/pdf-to-word', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('fileInput', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });
    form.append('outputFormat', 'docx');

    const r = await fetch(`${STIRLING}/api/v1/convert/pdf/word`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: 'Stirling error: ' + txt });
    }

    pipeStirrling(r, res, 'converted.docx');
  } catch (err) {
    console.error('pdf-to-word error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── OTHER TOOLS (stubs — easy to enable later) ────────────────────
app.post('/api/merge',        upload.array('files'), async (req, res) => {
  try {
    const form = new FormData();
    req.files.forEach(f => form.append('fileInput', f.buffer, { filename: f.originalname, contentType: 'application/pdf' }));
    const r = await fetch(`${STIRLING}/api/v1/general/merge-pdfs`, { method:'POST', body:form, headers:form.getHeaders() });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    pipeStirrling(r, res, 'merged.pdf');
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/split', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('fileInput', req.file.buffer, { filename: req.file.originalname, contentType: 'application/pdf' });
    form.append('pages', req.body.pages || '1');
    form.append('splitType', '0');
    const r = await fetch(`${STIRLING}/api/v1/general/split-pdf`, { method:'POST', body:form, headers:form.getHeaders() });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    pipeStirrling(r, res, 'split.zip');
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rotate', upload.single('file'), async (req, res) => {
  try {
    const degMap = { '90 Clockwise': '90', '180': '180', '90 Counter-clockwise': '270' };
    const form = new FormData();
    form.append('fileInput', req.file.buffer, { filename: req.file.originalname, contentType: 'application/pdf' });
    form.append('angle', degMap[req.body.rotation] || '90');
    const r = await fetch(`${STIRLING}/api/v1/general/rotate-pdf`, { method:'POST', body:form, headers:form.getHeaders() });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    pipeStirrling(r, res, 'rotated.pdf');
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/protect', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('fileInput', req.file.buffer, { filename: req.file.originalname, contentType: 'application/pdf' });
    form.append('password', req.body.password || '');
    const r = await fetch(`${STIRLING}/api/v1/security/add-password`, { method:'POST', body:form, headers:form.getHeaders() });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    pipeStirrling(r, res, 'protected.pdf');
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/unlock', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('fileInput', req.file.buffer, { filename: req.file.originalname, contentType: 'application/pdf' });
    form.append('password', req.body.password || '');
    const r = await fetch(`${STIRLING}/api/v1/security/remove-password`, { method:'POST', body:form, headers:form.getHeaders() });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    pipeStirrling(r, res, 'unlocked.pdf');
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/img-to-pdf', upload.array('files'), async (req, res) => {
  try {
    const form = new FormData();
    req.files.forEach(f => form.append('fileInput', f.buffer, { filename: f.originalname, contentType: f.mimetype }));
    const r = await fetch(`${STIRLING}/api/v1/convert/img/pdf`, { method:'POST', body:form, headers:form.getHeaders() });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    pipeStirrling(r, res, 'converted.pdf');
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/word-to-pdf', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('fileInput', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    const r = await fetch(`${STIRLING}/api/v1/convert/word/pdf`, { method:'POST', body:form, headers:form.getHeaders() });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t }); }
    pipeStirrling(r, res, 'converted.pdf');
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', stirling: STIRLING }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OfficePDF running on port ' + PORT + ' → Stirling at ' + STIRLING));
