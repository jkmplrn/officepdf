const express       = require('express');
const fetch         = require('node-fetch');
const FormData      = require('form-data');
const multer        = require('multer');
const session       = require('express-session');
const bcrypt        = require('bcryptjs');
const Database      = require('better-sqlite3');
const { execFile }  = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const GOTENBERG = (process.env.GOTENBERG_URL || 'http://gotenberg:3000').replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'officepdf-secret-change-in-production';
const DB_PATH = process.env.DB_PATH || './data/users.db';

// ── Database setup ────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT    UNIQUE NOT NULL,
    password  TEXT    NOT NULL,
    role      TEXT    NOT NULL DEFAULT 'user',
    created_at TEXT   NOT NULL DEFAULT (datetime('now'))
  )
`);

// Create default admin on first run
const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hash, 'admin');
  console.log('✅ Default admin created — username: admin  password: admin123');
  console.log('⚠️  Please change the admin password after first login!');
}

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// ── Auth middleware ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

// Serve static files — but gate /index.html behind auth check
app.use(express.static('public', { index: false }));

// ── Root: redirect to login or app ───────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

app.get('/app', (req, res) => {
  if (req.session && req.session.userId) {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
  } else {
    res.redirect('/');
  }
});

app.get('/admin', (req, res) => {
  if (req.session && req.session.role === 'admin') {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.redirect('/');
  }
});

// ── Auth API ──────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.role     = user.role;
  res.json({ ok: true, role: user.role });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ username: req.session.username, role: req.session.role });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

app.post('/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.session.userId);
  res.json({ ok: true });
});

// ── Admin API ─────────────────────────────────────────────────────
app.get('/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.post('/admin/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const clean = username.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(clean);
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(clean, hash, role === 'admin' ? 'admin' : 'user');
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.delete('/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, parseInt(req.params.id));
  res.json({ ok: true });
});

// ── Helper: pipe Gotenberg response ──────────────────────────────
function pipeResponse(gRes, res, filename) {
  const ct = gRes.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  gRes.body.pipe(res);
}

async function gotenbergError(gRes) {
  const txt = await gRes.text();
  return 'Gotenberg error ' + gRes.status + ': ' + txt;
}

// ── PDF API routes (all require auth) ────────────────────────────

// 1. COMPRESS PDF
app.post('/api/compress', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const level  = req.body.level || 'medium';
    const tmpIn  = path.join(os.tmpdir(), 'gs_in_'  + Date.now() + '.pdf');
    const tmpOut = path.join(os.tmpdir(), 'gs_out_' + Date.now() + '.pdf');
    fs.writeFileSync(tmpIn, req.file.buffer);

    const gsArgs = ['-sDEVICE=pdfwrite','-dCompatibilityLevel=1.4','-dNOPAUSE','-dQUIET','-dBATCH','-dEmbedAllFonts=true','-dSubsetFonts=true'];

    if (level === 'low') {
      gsArgs.push('-dPDFSETTINGS=/prepress','-dCompressPages=true','-dDetectDuplicateImages=true','-dCreateJobTicket=false','-dPreserveEPSInfo=false','-dPreserveOPIComments=false');
    } else if (level === 'medium') {
      gsArgs.push('-dPDFSETTINGS=/printer','-dCompressPages=true','-dDetectDuplicateImages=true','-dFlattenTransparency=true','-dHaveTransparency=false','-dColorConversionStrategy=/LeaveColorUnchanged','-dPreserveEPSInfo=false','-dCreateJobTicket=false');
    } else {
      gsArgs.push('-dPDFSETTINGS=/screen','-dCompressPages=true','-dDetectDuplicateImages=true','-dFlattenTransparency=true','-r150','-dColorImageResolution=150','-dGrayImageResolution=150','-dMonoImageResolution=150','-dDownsampleColorImages=true','-dDownsampleGrayImages=true','-dDownsampleMonoImages=true','-dColorImageDownsampleType=/Bicubic','-dGrayImageDownsampleType=/Bicubic','-dAutoFilterColorImages=false','-dColorImageFilter=/DCTEncode','-dAutoFilterGrayImages=false','-dGrayImageFilter=/DCTEncode');
    }
    gsArgs.push('-sOutputFile=' + tmpOut); gsArgs.push(tmpIn);

    execFile('gs', gsArgs, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch(e) {}
      if (err) { try { fs.unlinkSync(tmpOut); } catch(e) {} return res.status(500).json({ error: 'Ghostscript error: ' + stderr }); }
      const result = fs.readFileSync(tmpOut);
      try { fs.unlinkSync(tmpOut); } catch(e) {}
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="compressed.pdf"');
      res.send(result);
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. PDF TO IMAGE
app.post('/api/pdf-to-img', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const tmpIn  = path.join(os.tmpdir(), 'pdf_in_' + Date.now() + '.pdf');
    const tmpPfx = path.join(os.tmpdir(), 'pdf_pg_' + Date.now());
    fs.writeFileSync(tmpIn, req.file.buffer);
    execFile('pdftoppm', ['-r', '150', '-png', tmpIn, tmpPfx], (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpIn); } catch(e) {}
      if (err) return res.status(500).json({ error: 'PDF to image error: ' + stderr });
      const dir = path.dirname(tmpPfx), base = path.basename(tmpPfx);
      const files = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.png')).sort().map(f => path.join(dir, f));
      if (!files.length) return res.status(500).json({ error: 'No images generated.' });
      const zipPath = tmpPfx + '.zip';
      execFile('zip', ['-j', zipPath, ...files], (zerr) => {
        files.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
        if (zerr) return res.status(500).json({ error: 'Could not create zip.' });
        const zipData = fs.readFileSync(zipPath);
        try { fs.unlinkSync(zipPath); } catch(e) {}
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="pdf-images.zip"');
        res.send(zipData);
      });
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. PDF TO WORD
app.post('/api/pdf-to-word', requireAuth, upload.single('file'), async (req, res) => {
  async function attempt(tries) {
    const form = new FormData();
    form.append('files', req.file.buffer, { filename: req.file.originalname, contentType: 'application/pdf' });
    const r = await fetch(`${GOTENBERG}/forms/libreoffice/convert`, { method: 'POST', body: form, headers: form.getHeaders() });
    if (r.status === 503 && tries > 1) { await new Promise(resolve => setTimeout(resolve, 8000)); return attempt(tries - 1); }
    return r;
  }
  try {
    const r = await attempt(4);
    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'converted.docx');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. MERGE PDF
app.post('/api/merge', requireAuth, upload.array('files'), async (req, res) => {
  try {
    const form = new FormData();
    req.files.forEach(f => form.append('files', f.buffer, { filename: f.originalname, contentType: 'application/pdf' }));
    const r = await fetch(`${GOTENBERG}/forms/pdfengines/merge`, { method: 'POST', body: form, headers: form.getHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'merged.pdf');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. SPLIT PDF
app.post('/api/split', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('files', req.file.buffer, { filename: req.file.originalname, contentType: 'application/pdf' });
    form.append('splitMode', 'pages'); form.append('splitSpan', '1'); form.append('splitUnify', 'false');
    const r = await fetch(`${GOTENBERG}/forms/pdfengines/split`, { method: 'POST', body: form, headers: form.getHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'split.zip');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. ROTATE PDF
app.post('/api/rotate', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const degMap = { '90 Clockwise': '90', '180': '180', '90 Counter-clockwise': '270' };
    const form = new FormData();
    form.append('files', req.file.buffer, { filename: req.file.originalname, contentType: 'application/pdf' });
    form.append('rotate', degMap[req.body.rotation] || '90');
    const r = await fetch(`${GOTENBERG}/forms/pdfengines/convert`, { method: 'POST', body: form, headers: form.getHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'rotated.pdf');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. WORD TO PDF
app.post('/api/word-to-pdf', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    form.append('files', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    const r = await fetch(`${GOTENBERG}/forms/libreoffice/convert`, { method: 'POST', body: form, headers: form.getHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'converted.pdf');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. IMAGE TO PDF
app.post('/api/img-to-pdf', requireAuth, upload.array('files'), async (req, res) => {
  try {
    const form = new FormData();
    req.files.forEach(f => form.append('files', f.buffer, { filename: f.originalname, contentType: f.mimetype }));
    const r = await fetch(`${GOTENBERG}/forms/libreoffice/convert`, { method: 'POST', body: form, headers: form.getHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: await gotenbergError(r) });
    pipeResponse(r, res, 'converted.pdf');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 9. PDF TO DXF
app.post('/api/pdf-to-dxf', requireAuth, upload.single('file'), async (req, res) => {
  const tmpPdf = path.join(os.tmpdir(), 'dxf_in_'  + Date.now() + '.pdf');
  const tmpEps = path.join(os.tmpdir(), 'dxf_eps_' + Date.now() + '.eps');
  const tmpDxf = path.join(os.tmpdir(), 'dxf_out_' + Date.now() + '.dxf');
  const cleanup = () => { [tmpPdf, tmpEps, tmpDxf].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} }); };
  try {
    fs.writeFileSync(tmpPdf, req.file.buffer);
    execFile('inkscape', ['--export-type=eps', '--export-filename=' + tmpEps, tmpPdf], { env: { ...process.env, DISPLAY: '' } }, (err1, stdout1, stderr1) => {
      if (err1 || !fs.existsSync(tmpEps)) { cleanup(); return res.status(500).json({ error: 'PDF to EPS failed: ' + (stderr1 || err1.message) }); }
      execFile('pstoedit', ['-f', 'dxf', '-mm', '-noptext', tmpEps, tmpDxf], (err2, stdout2, stderr2) => {
        if (err2 || !fs.existsSync(tmpDxf)) { cleanup(); return res.status(500).json({ error: 'EPS to DXF failed: ' + (stderr2 || err2.message) }); }
        const result = fs.readFileSync(tmpDxf); cleanup();
        const originalName = req.file.originalname.replace(/\.pdf$/i, '');
        res.setHeader('Content-Type', 'application/dxf');
        res.setHeader('Content-Disposition', 'attachment; filename="' + originalName + '.dxf"');
        res.send(result);
      });
    });
  } catch (err) { cleanup(); res.status(500).json({ error: err.message }); }
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', gotenberg: GOTENBERG }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OfficePDF running on port ' + PORT));
