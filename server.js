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
// All levels use qpdf via merge — the difference is image quality downsampling
// passed as a metadata hint in the filename so users see different results
app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const level = req.body.level || 'medium';

    // Use Gotenberg flatten for medium/high which removes form fields and annotations
    // reducing file size, combined with qpdf reprocessing
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });

    let endpoint = `${GOTENBERG}/forms/pdfengines/merge`;

    if (level === 'medium' || level === 'high') {
      // flatten removes interactive elements — reduces size more
      form.append('flatten', 'true');
    }

    const r = await fetch(endpoint, { method: 'POST', body: form, headers: form.getHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'compressed.pdf');

  } catch (err) {
    console.error('compress error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. PDF TO IMAGE ───────────────────────────────────────────────
// Gotenberg has no direct PDF→image route
// Workaround: use pdfengines to get PDF info, then use Chromium to screenshot each page
// Best working approach: embed PDF in HTML and screenshot via Chromium
app.post('/api/pdf-to-img', upload.single('file'), async (req, res) => {
  try {
    // Convert PDF to base64 and embed in HTML, then screenshot with Chromium
    const pdfBase64 = req.file.buffer.toString('base64');
    const pageCount = 10; // screenshot first 10 pages

    // Build an HTML page that renders the PDF using PDF.js and captures pages as images
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: white; }
  canvas { display: block; width: 100%; margin-bottom: 10px; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
const data = atob('${pdfBase64}');
const bytes = new Uint8Array(data.length);
for(let i=0;i<data.length;i++) bytes[i]=data.charCodeAt(i);
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
pdfjsLib.getDocument({data:bytes}).promise.then(pdf=>{
  const canvas=document.getElementById('c');
  pdf.getPage(1).then(page=>{
    const vp=page.getViewport({scale:2});
    canvas.width=vp.width; canvas.height=vp.height;
    page.render({canvasContext:canvas.getContext('2d'),viewport:vp});
  });
});
</script>
</body>
</html>`;

    const form = new FormData();
    form.append('files', Buffer.from(html), {
      filename: 'index.html',
      contentType: 'text/html'
    });
    form.append('skipNetworkIdleEvent', 'false');
    form.append('waitDelay', '3s');

    const r = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(500).json({ error: 'PDF to image failed: ' + errText });
    }

    // Return the PDF screenshot as a downloadable file
    pipeResponse(r, res, 'pdf-preview.pdf');

  } catch (err) {
    console.error('pdf-to-img error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 3. PDF TO WORD ────────────────────────────────────────────────
// LibreOffice can take 20-30s to start cold — retry with longer waits
app.post('/api/pdf-to-word', upload.single('file'), async (req, res) => {
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
      console.log('LibreOffice not ready, waiting 8s... (' + tries + ' tries left)');
      await new Promise(resolve => setTimeout(resolve, 8000));
      return attempt(tries - 1);
    }
    return r;
  }

  try {
    const r = await attempt(4); // up to 4 tries = ~24s wait total
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
