const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const multer   = require('multer');
const { execFile } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── Gotenberg URL ─────────────────────────────────────────────────
// In Railway: set GOTENBERG_URL env variable
// Value: http://gotenberg.railway.internal:3000
const GOTENBERG = (process.env.GOTENBERG_URL || 'http://gotenberg:3000').replace(/\/$/, '');

app.use(express.static('public'));

// ── Helper: pipe Gotenberg response to browser ────────────────────
function pipeResponse(gRes, res, filename) {
  const ct = gRes.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  gRes.body.pipe(res);
}

// ── Helper: handle Gotenberg error ───────────────────────────────
async function gotenbergError(gRes) {
  const txt = await gRes.text();
  return 'Gotenberg error ' + gRes.status + ': ' + txt;
}

// ── 1. COMPRESS PDF ───────────────────────────────────────────────
// Use qpdf directly via Gotenberg's merge endpoint which reprocesses/compresses
app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });

    // Gotenberg's merge with a single file runs it through qpdf which compresses it
    const r = await fetch(`${GOTENBERG}/forms/pdfengines/merge`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'compressed.pdf');
  } catch (err) {
    console.error('compress error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. PDF TO IMAGE ───────────────────────────────────────────────
// Gotenberg doesn't have a native PDF→image route
// We use Chromium's screenshot by first converting PDF pages via pdfengines flatten
// then screenshotting — best workaround: convert PDF→HTML via LibreOffice then screenshot
app.post('/api/pdf-to-img', upload.single('file'), async (req, res) => {
  try {
    // Use LibreOffice to convert PDF to PNG images
    // LibreOffice can export PDF as image format directly
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: 'input.pdf',
      contentType: 'application/pdf'
    });
    form.append('nativePageRanges', '1-20');

    const r = await fetch(`${GOTENBERG}/forms/libreoffice/convert`, {
      method: 'POST', body: form, headers: form.getHeaders(),
      timeout: 60000
    });

    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      const cd = r.headers.get('content-disposition') || '';
      const fname = cd.match(/filename="?([^"]+)"?/) ? cd.match(/filename="?([^"]+)"?/)[1] : 'output.zip';
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', 'attachment; filename="pdf-images.zip"');
      return r.body.pipe(res);
    }

    const errText = await r.text();
    res.status(500).json({ error: 'PDF to image failed: ' + errText });
  } catch (err) {
    console.error('pdf-to-img error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 3. PDF TO WORD ────────────────────────────────────────────────
app.post('/api/pdf-to-word', upload.single('file'), async (req, res) => {
  // Retry up to 3 times — LibreOffice in Gotenberg can be slow to start
  async function attempt(tries) {
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });

    const r = await fetch(`${GOTENBERG}/forms/libreoffice/convert`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (r.status === 503 && tries > 1) {
      console.log('LibreOffice 503, retrying in 3s...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      return attempt(tries - 1);
    }

    return r;
  }

  try {
    const r = await attempt(3);
    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'converted.docx');
  } catch (err) {
    console.error('pdf-to-word error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 4. MERGE PDF ──────────────────────────────────────────────────
app.post('/api/merge', upload.array('files'), async (req, res) => {
  try {
    const form = new FormData();
    req.files.forEach(f => form.append('files', f.buffer, {
      filename: f.originalname, contentType: 'application/pdf'
    }));
    form.append('merge', 'true');

    const r = await fetch(`${GOTENBERG}/forms/pdfengines/merge`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'merged.pdf');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 5. SPLIT PDF ──────────────────────────────────────────────────
app.post('/api/split', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname, contentType: 'application/pdf'
    });
    form.append('splitMode', 'pages');
    form.append('splitSpan', '1');
    form.append('splitUnify', 'false');

    const r = await fetch(`${GOTENBERG}/forms/pdfengines/split`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'split.zip');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 6. ROTATE PDF ─────────────────────────────────────────────────
app.post('/api/rotate', upload.single('file'), async (req, res) => {
  try {
    const degMap = { '90 Clockwise': '90', '180': '180', '90 Counter-clockwise': '270' };
    const angle = degMap[req.body.rotation] || '90';

    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname, contentType: 'application/pdf'
    });
    form.append('rotate', angle);

    const r = await fetch(`${GOTENBERG}/forms/pdfengines/convert`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'rotated.pdf');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 7. PROTECT PDF ────────────────────────────────────────────────
app.post('/api/protect', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname, contentType: 'application/pdf'
    });
    form.append('userPassword', req.body.password || '');
    form.append('ownerPassword', req.body.password || '');
    form.append('encrypt', 'true');

    const r = await fetch(`${GOTENBERG}/forms/pdfengines/convert`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'protected.pdf');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 8. UNLOCK PDF ─────────────────────────────────────────────────
app.post('/api/unlock', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname, contentType: 'application/pdf'
    });
    form.append('password', req.body.password || '');

    const r = await fetch(`${GOTENBERG}/forms/pdfengines/convert`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'unlocked.pdf');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 9. IMAGE TO PDF ───────────────────────────────────────────────
app.post('/api/img-to-pdf', upload.array('files'), async (req, res) => {
  try {
    const form = new FormData();
    req.files.forEach(f => form.append('files', f.buffer, {
      filename: f.originalname, contentType: f.mimetype
    }));
    form.append('merge', 'true');

    const r = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) {
      // fallback: use libreoffice
      const form2 = new FormData();
      req.files.forEach(f => form2.append('files', f.buffer, {
        filename: f.originalname, contentType: f.mimetype
      }));
      const r2 = await fetch(`${GOTENBERG}/forms/libreoffice/convert`, {
        method: 'POST', body: form2, headers: form2.getHeaders()
      });
      if (!r2.ok) return res.status(r2.status).json({ error: await gotenbergError(r2) });
      return pipeResponse(r2, res, 'converted.pdf');
    }
    pipeResponse(r, res, 'converted.pdf');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 10. WORD TO PDF ───────────────────────────────────────────────
app.post('/api/word-to-pdf', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname, contentType: req.file.mimetype
    });

    const r = await fetch(`${GOTENBERG}/forms/libreoffice/convert`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'converted.pdf');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', gotenberg: GOTENBERG }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OfficePDF running on port ' + PORT + ' → Gotenberg at ' + GOTENBERG));
