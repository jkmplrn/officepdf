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
// Gotenberg uses qpdf under the hood — fully free, no license needed
app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });
    // compress=true tells Gotenberg to run qpdf compression
    form.append('compress', 'true');

    const r = await fetch(`${GOTENBERG}/forms/pdfengines/convert`, {
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
// Gotenberg doesn't natively export PDF→image, so we use ImageMagick
// which is available in the Gotenberg container via shell
// Instead we proxy through a lightweight approach: use pdftoppm via shell on OfficePDF side
// Actually: we call Gotenberg's /forms/pdfengines/convert with pdfa then use sharp
// Simplest working approach: use Stirling-compatible ImageMagick call directly
app.post('/api/pdf-to-img', upload.single('file'), async (req, res) => {
  try {
    // Write PDF to temp file
    const tmpIn  = path.join(os.tmpdir(), 'pdfin_'  + Date.now() + '.pdf');
    const tmpOut = path.join(os.tmpdir(), 'pdfout_' + Date.now());
    fs.writeFileSync(tmpIn, req.file.buffer);

    // Use pdftoppm (poppler) to convert PDF pages to PNG images
    execFile('pdftoppm', [
      '-r', '150',      // 150 DPI
      '-png',           // output PNG
      tmpIn,
      tmpOut            // output prefix — creates tmpOut-1.png, tmpOut-2.png etc
    ], async (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch(e) {}

      if (err) {
        console.error('pdftoppm error:', stderr);
        // Fallback: try ImageMagick convert
        execFile('convert', [
          '-density', '150',
          tmpIn,
          tmpOut + '-%03d.png'
        ], (err2, stdout2, stderr2) => {
          if (err2) {
            return res.status(500).json({ error: 'PDF to image failed: ' + (stderr2 || stderr) });
          }
          zipAndSend(tmpOut, res);
        });
        return;
      }

      zipAndSend(tmpOut, res);
    });
  } catch (err) {
    console.error('pdf-to-img error:', err);
    res.status(500).json({ error: err.message });
  }
});

function zipAndSend(prefix, res) {
  // Find all generated image files
  const dir = path.dirname(prefix);
  const base = path.basename(prefix);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.startsWith(base) && (f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.ppm')));
  } catch(e) {
    return res.status(500).json({ error: 'Could not read output files: ' + e.message });
  }

  if (!files.length) {
    return res.status(500).json({ error: 'No images were generated from the PDF.' });
  }

  const zipPath = prefix + '.zip';

  // Use zip command to create archive
  const fullPaths = files.map(f => path.join(dir, f));
  execFile('zip', ['-j', zipPath, ...fullPaths], (err) => {
    // Clean up individual image files
    fullPaths.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });

    if (err) {
      // If zip not available, just send the first image
      const firstFile = fullPaths[0];
      if (fs.existsSync(firstFile)) {
        const data = fs.readFileSync(firstFile);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', 'attachment; filename="page-1.png"');
        return res.send(data);
      }
      return res.status(500).json({ error: 'Could not create zip: ' + err.message });
    }

    const zipData = fs.readFileSync(zipPath);
    try { fs.unlinkSync(zipPath); } catch(e) {}
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="pdf-images.zip"');
    res.send(zipData);
  });
}

// ── 3. PDF TO WORD ────────────────────────────────────────────────
// Gotenberg doesn't convert PDF→DOCX (no tool does this perfectly)
// Best approach: use LibreOffice via Gotenberg to at least get editable output
// We send PDF to Gotenberg's libreoffice convert endpoint
app.post('/api/pdf-to-word', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('files', req.file.buffer, {
      filename: req.file.originalname,
      contentType: 'application/pdf'
    });

    // Use LibreOffice to convert PDF to DOCX
    const r = await fetch(`${GOTENBERG}/forms/libreoffice/convert`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });

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
