const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
require('dotenv').config();

const MAX_PHOTOS_PER_PERSON = 10;
const MAX_TOTAL_PHOTOS = 600;

const app = express();
const port = Number(process.env.PORT || 3000);
const configuredBaseUrl = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
const execFileAsync = promisify(execFile);

const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(__dirname, 'uploads');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(path.join(dataDir, 'wedding-photos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS uploaders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uploader_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploader_id) REFERENCES uploaders(id)
  );
`);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'replace-with-a-strong-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }
  })
);
app.use('/public', express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${extension}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  },
  limits: {
    files: MAX_PHOTOS_PER_PERSON,
    fileSize: 20 * 1024 * 1024
  }
});

function normalizeName(name) {
  return name.trim().toLowerCase();
}

function getOrCreateUploader(name) {
  const normalized = normalizeName(name);
  let uploader = db
    .prepare('SELECT id, name, normalized_name FROM uploaders WHERE normalized_name = ?')
    .get(normalized);

  if (!uploader) {
    const result = db
      .prepare('INSERT INTO uploaders (name, normalized_name) VALUES (?, ?)')
      .run(name.trim(), normalized);
    uploader = {
      id: result.lastInsertRowid,
      name: name.trim(),
      normalized_name: normalized
    };
  }

  return uploader;
}

function getUploaderPhotoCount(uploaderId) {
  const row = db.prepare('SELECT COUNT(*) as count FROM photos WHERE uploader_id = ?').get(uploaderId);
  return row.count;
}

function getTotalPhotoCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM photos').get();
  return row.count;
}

function isAdmin(req) {
  return req.session && req.session.isAdmin === true;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.redirect('/admin/login');
  }
  next();
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_e) {
    // Ignore cleanup failures.
  }
}

function safeRemoveDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_e) {
    // Ignore cleanup failures.
  }
}

function sanitizeArchiveFilename(name) {
  return String(name)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveBaseUrl(req) {
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  const forwardedHost = req.get('x-forwarded-host');
  const host = (forwardedHost || req.get('host') || `localhost:${port}`).split(',')[0].trim();
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = (forwardedProto || req.protocol || 'http').split(',')[0].trim();
  return `${protocol}://${host}`;
}

app.get('/', async (req, res) => {
  const baseUrl = resolveBaseUrl(req);
  const qrCodeDataUrl = await QRCode.toDataURL(baseUrl);
  const totalCount = getTotalPhotoCount();

  res.render('index', {
    qrCodeDataUrl,
    baseUrl,
    maxPerPerson: MAX_PHOTOS_PER_PERSON,
    maxTotal: MAX_TOTAL_PHOTOS,
    totalCount,
    message: req.query.message || '',
    error: req.query.error || ''
  });
});

app.post('/upload', upload.array('photos', MAX_PHOTOS_PER_PERSON), (req, res) => {
  const uploadedFiles = req.files || [];

  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      uploadedFiles.forEach((f) => safeUnlink(f.path));
      return res.redirect('/?error=' + encodeURIComponent('Please provide your name.'));
    }

    if (uploadedFiles.length === 0) {
      return res.redirect('/?error=' + encodeURIComponent('Please select at least one photo.'));
    }

    const uploader = getOrCreateUploader(name);
    const uploaderCount = getUploaderPhotoCount(uploader.id);
    const totalCount = getTotalPhotoCount();

    const remainingForUploader = Math.max(0, MAX_PHOTOS_PER_PERSON - uploaderCount);
    const remainingGlobal = Math.max(0, MAX_TOTAL_PHOTOS - totalCount);
    const allowedNow = Math.min(remainingForUploader, remainingGlobal);

    if (allowedNow <= 0) {
      uploadedFiles.forEach((f) => safeUnlink(f.path));
      const reason =
        remainingGlobal <= 0
          ? 'Upload limit reached: this gallery is full.'
          : 'You have already uploaded your maximum of 10 photos.';
      return res.redirect('/?error=' + encodeURIComponent(reason));
    }

    const acceptedFiles = uploadedFiles.slice(0, allowedNow);
    const rejectedFiles = uploadedFiles.slice(allowedNow);
    rejectedFiles.forEach((f) => safeUnlink(f.path));

    const insertPhoto = db.prepare(
      'INSERT INTO photos (uploader_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)'
    );

    const transaction = db.transaction((files) => {
      for (const file of files) {
        insertPhoto.run(uploader.id, file.filename, file.originalname, file.mimetype, file.size);
      }
    });

    transaction(acceptedFiles);

    const uploadedCount = acceptedFiles.length;
    const limitedCount = rejectedFiles.length;

    let message = `Thanks ${uploader.name}! Uploaded ${uploadedCount} photo${uploadedCount === 1 ? '' : 's'}.`;
    if (limitedCount > 0) {
      message += ` ${limitedCount} photo${limitedCount === 1 ? ' was' : 's were'} skipped due to upload limits.`;
    }

    return res.redirect('/?message=' + encodeURIComponent(message));
  } catch (error) {
    uploadedFiles.forEach((f) => safeUnlink(f.path));
    return res.redirect('/?error=' + encodeURIComponent(error.message || 'Upload failed.'));
  }
});

app.get('/admin/login', (req, res) => {
  if (isAdmin(req)) {
    return res.redirect('/admin/photos');
  }

  res.render('admin-login', {
    error: req.query.error || ''
  });
});

app.post('/admin/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const expectedPassword = process.env.ADMIN_PASSWORD || 'change-this-password';

  if (username === expectedUsername && password === expectedPassword) {
    req.session.isAdmin = true;
    return res.redirect('/admin/photos');
  }

  return res.redirect('/admin/login?error=' + encodeURIComponent('Invalid username or password.'));
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

app.get('/admin/photos', requireAdmin, (req, res) => {
  const photos = db
    .prepare(
      `
      SELECT
        photos.id,
        photos.original_name,
        photos.mime_type,
        photos.size,
        photos.uploaded_at,
        uploaders.name as uploader_name
      FROM photos
      JOIN uploaders ON uploaders.id = photos.uploader_id
      ORDER BY photos.uploaded_at DESC, photos.id DESC
    `
    )
    .all();

  res.render('admin-photos', {
    photos,
    totalCount: photos.length,
    maxTotal: MAX_TOTAL_PHOTOS,
    maxPerPerson: MAX_PHOTOS_PER_PERSON,
    message: req.query.message || '',
    error: req.query.error || ''
  });
});

app.get('/admin/photo/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    return res.status(400).send('Invalid photo ID');
  }

  const photo = db
    .prepare('SELECT filename, original_name, mime_type FROM photos WHERE id = ?')
    .get(id);

  if (!photo) {
    return res.status(404).send('Photo not found');
  }

  const filePath = path.join(uploadDir, photo.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File missing on server');
  }

  res.setHeader('Content-Type', photo.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${photo.original_name.replace(/"/g, '')}"`);
  return res.sendFile(filePath);
});

app.post('/admin/photo/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    return res.redirect('/admin/photos?error=' + encodeURIComponent('Invalid photo ID.'));
  }

  const photo = db.prepare('SELECT id, filename FROM photos WHERE id = ?').get(id);
  if (!photo) {
    return res.redirect('/admin/photos?error=' + encodeURIComponent('Photo not found.'));
  }

  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
  safeUnlink(path.join(uploadDir, photo.filename));
  db.prepare('DELETE FROM uploaders WHERE id NOT IN (SELECT DISTINCT uploader_id FROM photos)').run();

  return res.redirect('/admin/photos?message=' + encodeURIComponent('Photo deleted.'));
});

app.post('/admin/photos/delete-all', requireAdmin, (_req, res) => {
  const photos = db.prepare('SELECT filename FROM photos').all();
  for (const photo of photos) {
    safeUnlink(path.join(uploadDir, photo.filename));
  }

  db.prepare('DELETE FROM photos').run();
  db.prepare('DELETE FROM uploaders').run();

  return res.redirect('/admin/photos?message=' + encodeURIComponent('All photos deleted.'));
});

app.get('/admin/photos/download', requireAdmin, async (_req, res) => {
  const photos = db
    .prepare(
      `
      SELECT id, filename, original_name
      FROM photos
      ORDER BY uploaded_at DESC, id DESC
    `
    )
    .all();

  if (photos.length === 0) {
    return res.redirect('/admin/photos?error=' + encodeURIComponent('No photos to download.'));
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-photos-'));
  const archivePath = path.join(os.tmpdir(), `wedding-photos-${Date.now()}.zip`);

  try {
    let copiedCount = 0;
    for (const photo of photos) {
      const sourcePath = path.join(uploadDir, photo.filename);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }

      const fallbackName = `photo-${photo.id}${path.extname(photo.filename) || ''}`;
      const stagedName = `${String(photo.id).padStart(4, '0')}-${sanitizeArchiveFilename(photo.original_name || fallbackName)}`;
      fs.copyFileSync(sourcePath, path.join(tempDir, stagedName));
      copiedCount += 1;
    }

    if (copiedCount === 0) {
      safeRemoveDir(tempDir);
      safeUnlink(archivePath);
      return res.redirect('/admin/photos?error=' + encodeURIComponent('Photo files are missing on disk.'));
    }

    await execFileAsync('zip', ['-q', '-r', archivePath, '.'], { cwd: tempDir });

    const stamp = new Date().toISOString().slice(0, 10);
    return res.download(archivePath, `dan-abi-wedding-photos-${stamp}.zip`, () => {
      safeUnlink(archivePath);
      safeRemoveDir(tempDir);
    });
  } catch (_error) {
    safeUnlink(archivePath);
    safeRemoveDir(tempDir);
    return res.redirect(
      '/admin/photos?error=' + encodeURIComponent('Could not create ZIP archive on this server.')
    );
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    let message = 'Upload error.';
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = 'A file is too large. Max size is 20MB per photo.';
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      message = `You can upload up to ${MAX_PHOTOS_PER_PERSON} photos at a time.`;
    }
    return res.redirect('/?error=' + encodeURIComponent(message));
  }

  if (err) {
    return res.redirect('/?error=' + encodeURIComponent(err.message || 'Unexpected error occurred.'));
  }

  return res.status(500).send('Unexpected server error');
});

app.listen(port, () => {
  const displayUrl = configuredBaseUrl || `http://localhost:${port}`;
  console.log(`Wedding photo app running on ${displayUrl}`);
});
