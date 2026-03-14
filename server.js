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

// ── 1. COMPRESS PDF ── via Ghostscript (installed in OfficePDF container via nixpacks) ──
app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const level = req.body.level || 'medium';
    // Ghostscript PDF settings:
    // screen   = 72dpi  — smallest file, lowest quality (high compression)
    // ebook    = 150dpi — medium quality (medium compression)
    // printer  = 300dpi — high quality  (low compression)
    // Build Ghostscript args based on compression level
    const tmpIn  = path.join(os.tmpdir(), 'gs_in_'  + Date.now() + '.pdf');
    const tmpOut = path.join(os.tmpdir(), 'gs_out_' + Date.now() + '.pdf');
    fs.writeFileSync(tmpIn, req.file.buffer);

    // Base args
    const gsArgs = [
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      '-dNOPAUSE',
      '-dQUIET',
      '-dBATCH',
      '-dEmbedAllFonts=true',
      '-dSubsetFonts=true',
    ];

    if (level === 'low') {
      // Low: printer quality — 300dpi, good quality, modest size reduction
      gsArgs.push('-dPDFSETTINGS=/printer');
      gsArgs.push('-dColorImageResolution=300');
      gsArgs.push('-dGrayImageResolution=300');
      gsArgs.push('-dMonoImageResolution=300');

    } else if (level === 'medium') {
      // Medium: ebook quality — 150dpi, balanced size and quality
      gsArgs.push('-dPDFSETTINGS=/ebook');
      gsArgs.push('-dColorImageResolution=150');
      gsArgs.push('-dGrayImageResolution=150');
      gsArgs.push('-dMonoImageResolution=150');
      gsArgs.push('-dDownsampleColorImages=true');
      gsArgs.push('-dDownsampleGrayImages=true');
      gsArgs.push('-dColorImageDownsampleType=/Bicubic');
      gsArgs.push('-dGrayImageDownsampleType=/Bicubic');

    } else {
      // High: screen quality — 72dpi, maximum compression, lowest quality
      gsArgs.push('-dPDFSETTINGS=/screen');
      gsArgs.push('-dColorImageResolution=72');
      gsArgs.push('-dGrayImageResolution=72');
      gsArgs.push('-dMonoImageResolution=72');
      gsArgs.push('-dDownsampleColorImages=true');
      gsArgs.push('-dDownsampleGrayImages=true');
      gsArgs.push('-dDownsampleMonoImages=true');
      gsArgs.push('-dColorImageDownsampleType=/Bicubic');
      gsArgs.push('-dGrayImageDownsampleType=/Bicubic');
      gsArgs.push('-dCompressPages=true');
      gsArgs.push('-dDetectDuplicateImages=true');
      gsArgs.push('-dAutoFilterColorImages=false');
      gsArgs.push('-dColorImageFilter=/DCTEncode');
      gsArgs.push('-dAutoFilterGrayImages=false');
      gsArgs.push('-dGrayImageFilter=/DCTEncode');
      gsArgs.push('/ColorACSImageDict', '<</QFactor 0.9 /Blend 1 /ColorTransform 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2]>>');
    }

    gsArgs.push('-sOutputFile=' + tmpOut, tmpIn);

    execFile('gs', gsArgs, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch(e) {}
      if (err) {
        try { fs.unlinkSync(tmpOut); } catch(e) {}
        console.error('gs compress error:', stderr);
        return res.status(500).json({ error: 'Ghostscript error: ' + stderr });
      }
      const result = fs.readFileSync(tmpOut);
      try { fs.unlinkSync(tmpOut); } catch(e) {}
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="compressed.pdf"');
      res.send(result);
    });
  } catch (err) {
    console.error('compress error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. PDF TO IMAGE ── via pdftoppm (poppler-utils) ──────────────
app.post('/api/pdf-to-img', upload.single('file'), async (req, res) => {
  try {
    const tmpIn  = path.join(os.tmpdir(), 'pdf_in_' + Date.now() + '.pdf');
    const tmpPfx = path.join(os.tmpdir(), 'pdf_pg_' + Date.now());
    fs.writeFileSync(tmpIn, req.file.buffer);

    // pdftoppm converts each PDF page to a PNG file
    execFile('pdftoppm', ['-r', '150', '-png', tmpIn, tmpPfx], (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch(e) {}
      if (err) {
        console.error('pdftoppm error:', stderr);
        return res.status(500).json({ error: 'PDF to image error: ' + stderr });
      }

      // Find all generated PNG files
      const dir   = path.dirname(tmpPfx);
      const base  = path.basename(tmpPfx);
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith(base) && f.endsWith('.png'))
        .sort()
        .map(f => path.join(dir, f));

      if (!files.length) {
        return res.status(500).json({ error: 'No images were generated.' });
      }

      // Zip all PNG files
      const zipPath = tmpPfx + '.zip';
      execFile('zip', ['-j', zipPath, ...files], (zerr) => {
        files.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
        if (zerr) {
          // fallback: send first page only
          const first = files[0];
          if (fs.existsSync(first)) {
            const data = fs.readFileSync(first);
            try { fs.unlinkSync(first); } catch(e) {}
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Disposition', 'attachment; filename="page-1.png"');
            return res.send(data);
          }
          return res.status(500).json({ error: 'Could not create zip.' });
        }
        const zipData = fs.readFileSync(zipPath);
        try { fs.unlinkSync(zipPath); } catch(e) {}
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="pdf-images.zip"');
        res.send(zipData);
      });
    });
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
