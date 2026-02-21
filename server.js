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
const MAX_VIDEOS_PER_PERSON = Number(process.env.MAX_VIDEOS_PER_PERSON || 10);
const MAX_TOTAL_VIDEOS = Number(process.env.MAX_TOTAL_VIDEOS || 400);
const MAX_VIDEO_SIZE_MB = Number(process.env.MAX_VIDEO_SIZE_MB || 1200);
const MAX_VIDEO_SIZE_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024;

const app = express();
const port = Number(process.env.PORT || 3000);
const configuredBaseUrl = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
const execFileAsync = promisify(execFile);

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, 'uploads');

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

  CREATE TABLE IF NOT EXISTS videos (
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

function storageDestination(_req, _file, cb) {
  cb(null, uploadDir);
}

function storageFilename(_req, file, cb) {
  const extension = path.extname(file.originalname);
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  cb(null, `${unique}${extension}`);
}

function photoFileFilter(_req, file, cb) {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image files are allowed.'));
  }
  cb(null, true);
}

function videoFileFilter(_req, file, cb) {
  if (!file.mimetype.startsWith('video/')) {
    return cb(new Error('Only video files are allowed.'));
  }
  cb(null, true);
}

const storage = multer.diskStorage({
  destination: storageDestination,
  filename: storageFilename
});

const photoUpload = multer({
  storage,
  fileFilter: photoFileFilter,
  limits: {
    files: MAX_PHOTOS_PER_PERSON,
    fileSize: 20 * 1024 * 1024
  }
});

const videoUpload = multer({
  storage,
  fileFilter: videoFileFilter,
  limits: {
    files: MAX_VIDEOS_PER_PERSON,
    fileSize: MAX_VIDEO_SIZE_BYTES
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

function getUploaderVideoCount(uploaderId) {
  const row = db.prepare('SELECT COUNT(*) as count FROM videos WHERE uploader_id = ?').get(uploaderId);
  return row.count;
}

function getTotalVideoCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM videos').get();
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

function cleanupOrphanUploaders() {
  db.prepare(
    `
    DELETE FROM uploaders
    WHERE id NOT IN (
      SELECT uploader_id FROM photos
      UNION
      SELECT uploader_id FROM videos
    )
  `
  ).run();
}

function uploadTabFromRequest(req) {
  return req.path === '/upload/videos' ? 'videos' : 'photos';
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
  const totalPhotoCount = getTotalPhotoCount();
  const totalVideoCount = getTotalVideoCount();
  const requestedTab = String(req.query.tab || '').toLowerCase();
  const activeTab = requestedTab === 'videos' ? 'videos' : 'photos';

  res.render('index', {
    qrCodeDataUrl,
    baseUrl,
    maxPhotoPerPerson: MAX_PHOTOS_PER_PERSON,
    maxTotalPhotos: MAX_TOTAL_PHOTOS,
    totalPhotoCount,
    maxVideoPerPerson: MAX_VIDEOS_PER_PERSON,
    maxTotalVideos: MAX_TOTAL_VIDEOS,
    maxVideoSizeMb: MAX_VIDEO_SIZE_MB,
    totalVideoCount,
    activeTab,
    message: req.query.message || '',
    error: req.query.error || ''
  });
});

app.post('/upload', photoUpload.array('photos', MAX_PHOTOS_PER_PERSON), (req, res) => {
  const uploadedFiles = req.files || [];

  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      uploadedFiles.forEach((f) => safeUnlink(f.path));
      return res.redirect('/?tab=photos&error=' + encodeURIComponent('Please provide your name.'));
    }

    if (uploadedFiles.length === 0) {
      return res.redirect('/?tab=photos&error=' + encodeURIComponent('Please select at least one photo.'));
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
      return res.redirect('/?tab=photos&error=' + encodeURIComponent(reason));
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

    return res.redirect('/?tab=photos&message=' + encodeURIComponent(message));
  } catch (error) {
    uploadedFiles.forEach((f) => safeUnlink(f.path));
    return res.redirect('/?tab=photos&error=' + encodeURIComponent(error.message || 'Upload failed.'));
  }
});

app.post('/upload/videos', videoUpload.array('videos', MAX_VIDEOS_PER_PERSON), (req, res) => {
  const uploadedFiles = req.files || [];

  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      uploadedFiles.forEach((f) => safeUnlink(f.path));
      return res.redirect('/?tab=videos&error=' + encodeURIComponent('Please provide your name.'));
    }

    if (uploadedFiles.length === 0) {
      return res.redirect('/?tab=videos&error=' + encodeURIComponent('Please select at least one video.'));
    }

    const uploader = getOrCreateUploader(name);
    const uploaderCount = getUploaderVideoCount(uploader.id);
    const totalCount = getTotalVideoCount();

    const remainingForUploader = Math.max(0, MAX_VIDEOS_PER_PERSON - uploaderCount);
    const remainingGlobal = Math.max(0, MAX_TOTAL_VIDEOS - totalCount);
    const allowedNow = Math.min(remainingForUploader, remainingGlobal);

    if (allowedNow <= 0) {
      uploadedFiles.forEach((f) => safeUnlink(f.path));
      const reason =
        remainingGlobal <= 0
          ? 'Video upload limit reached: this gallery is full.'
          : `You have already uploaded your maximum of ${MAX_VIDEOS_PER_PERSON} videos.`;
      return res.redirect('/?tab=videos&error=' + encodeURIComponent(reason));
    }

    const acceptedFiles = uploadedFiles.slice(0, allowedNow);
    const rejectedFiles = uploadedFiles.slice(allowedNow);
    rejectedFiles.forEach((f) => safeUnlink(f.path));

    const insertVideo = db.prepare(
      'INSERT INTO videos (uploader_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)'
    );

    const transaction = db.transaction((files) => {
      for (const file of files) {
        insertVideo.run(uploader.id, file.filename, file.originalname, file.mimetype, file.size);
      }
    });

    transaction(acceptedFiles);

    const uploadedCount = acceptedFiles.length;
    const limitedCount = rejectedFiles.length;

    let message = `Thanks ${uploader.name}! Uploaded ${uploadedCount} video${uploadedCount === 1 ? '' : 's'}.`;
    if (limitedCount > 0) {
      message += ` ${limitedCount} video${limitedCount === 1 ? ' was' : 's were'} skipped due to upload limits.`;
    }

    return res.redirect('/?tab=videos&message=' + encodeURIComponent(message));
  } catch (error) {
    uploadedFiles.forEach((f) => safeUnlink(f.path));
    return res.redirect('/?tab=videos&error=' + encodeURIComponent(error.message || 'Upload failed.'));
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

function renderAdminMedia(req, res, activeTab) {
  const photos = db.prepare('SELECT COUNT(*) as count FROM photos').get().count;
  const videos = db.prepare('SELECT COUNT(*) as count FROM videos').get().count;
  const isVideosTab = activeTab === 'videos';
  const records = db
    .prepare(
      isVideosTab
        ? `
      SELECT
        videos.id,
        videos.original_name,
        videos.mime_type,
        videos.size,
        videos.uploaded_at,
        uploaders.name as uploader_name
      FROM videos
      JOIN uploaders ON uploaders.id = videos.uploader_id
      ORDER BY videos.uploaded_at DESC, videos.id DESC
    `
        : `
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
    activeTab,
    mediaItems: records,
    totalCount: records.length,
    maxTotal: isVideosTab ? MAX_TOTAL_VIDEOS : MAX_TOTAL_PHOTOS,
    maxPerPerson: isVideosTab ? MAX_VIDEOS_PER_PERSON : MAX_PHOTOS_PER_PERSON,
    maxVideoSizeMb: MAX_VIDEO_SIZE_MB,
    maxTotalPhotos: MAX_TOTAL_PHOTOS,
    maxTotalVideos: MAX_TOTAL_VIDEOS,
    photoCount: photos,
    videoCount: videos,
    message: req.query.message || '',
    error: req.query.error || ''
  });
}

app.get('/admin/photos', requireAdmin, (req, res) => {
  renderAdminMedia(req, res, 'photos');
});

app.get('/admin/videos', requireAdmin, (req, res) => {
  renderAdminMedia(req, res, 'videos');
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
  cleanupOrphanUploaders();

  return res.redirect('/admin/photos?message=' + encodeURIComponent('Photo deleted.'));
});

app.post('/admin/photos/delete-all', requireAdmin, (_req, res) => {
  const photos = db.prepare('SELECT filename FROM photos').all();
  for (const photo of photos) {
    safeUnlink(path.join(uploadDir, photo.filename));
  }

  db.prepare('DELETE FROM photos').run();
  cleanupOrphanUploaders();

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

app.get('/admin/video/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    return res.status(400).send('Invalid video ID');
  }

  const video = db
    .prepare('SELECT filename, original_name, mime_type FROM videos WHERE id = ?')
    .get(id);

  if (!video) {
    return res.status(404).send('Video not found');
  }

  const filePath = path.join(uploadDir, video.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File missing on server');
  }

  res.setHeader('Content-Type', video.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${video.original_name.replace(/"/g, '')}"`);
  return res.sendFile(filePath);
});

app.post('/admin/video/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    return res.redirect('/admin/videos?error=' + encodeURIComponent('Invalid video ID.'));
  }

  const video = db.prepare('SELECT id, filename FROM videos WHERE id = ?').get(id);
  if (!video) {
    return res.redirect('/admin/videos?error=' + encodeURIComponent('Video not found.'));
  }

  db.prepare('DELETE FROM videos WHERE id = ?').run(id);
  safeUnlink(path.join(uploadDir, video.filename));
  cleanupOrphanUploaders();

  return res.redirect('/admin/videos?message=' + encodeURIComponent('Video deleted.'));
});

app.post('/admin/videos/delete-all', requireAdmin, (_req, res) => {
  const videos = db.prepare('SELECT filename FROM videos').all();
  for (const video of videos) {
    safeUnlink(path.join(uploadDir, video.filename));
  }

  db.prepare('DELETE FROM videos').run();
  cleanupOrphanUploaders();

  return res.redirect('/admin/videos?message=' + encodeURIComponent('All videos deleted.'));
});

app.get('/admin/videos/download', requireAdmin, async (_req, res) => {
  const videos = db
    .prepare(
      `
      SELECT id, filename, original_name
      FROM videos
      ORDER BY uploaded_at DESC, id DESC
    `
    )
    .all();

  if (videos.length === 0) {
    return res.redirect('/admin/videos?error=' + encodeURIComponent('No videos to download.'));
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-videos-'));
  const archivePath = path.join(os.tmpdir(), `wedding-videos-${Date.now()}.zip`);

  try {
    let copiedCount = 0;
    for (const video of videos) {
      const sourcePath = path.join(uploadDir, video.filename);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }

      const fallbackName = `video-${video.id}${path.extname(video.filename) || ''}`;
      const stagedName = `${String(video.id).padStart(4, '0')}-${sanitizeArchiveFilename(video.original_name || fallbackName)}`;
      fs.copyFileSync(sourcePath, path.join(tempDir, stagedName));
      copiedCount += 1;
    }

    if (copiedCount === 0) {
      safeRemoveDir(tempDir);
      safeUnlink(archivePath);
      return res.redirect('/admin/videos?error=' + encodeURIComponent('Video files are missing on disk.'));
    }

    await execFileAsync('zip', ['-q', '-r', archivePath, '.'], { cwd: tempDir });

    const stamp = new Date().toISOString().slice(0, 10);
    return res.download(archivePath, `dan-abi-wedding-videos-${stamp}.zip`, () => {
      safeUnlink(archivePath);
      safeRemoveDir(tempDir);
    });
  } catch (_error) {
    safeUnlink(archivePath);
    safeRemoveDir(tempDir);
    return res.redirect(
      '/admin/videos?error=' + encodeURIComponent('Could not create ZIP archive on this server.')
    );
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const uploadTab = uploadTabFromRequest(_req);
    let message = 'Upload error.';
    if (err.code === 'LIMIT_FILE_SIZE') {
      message =
        uploadTab === 'videos'
          ? `A video file is too large. Max size is ${MAX_VIDEO_SIZE_MB}MB per video.`
          : 'A file is too large. Max size is 20MB per photo.';
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      message =
        uploadTab === 'videos'
          ? `You can upload up to ${MAX_VIDEOS_PER_PERSON} videos at a time.`
          : `You can upload up to ${MAX_PHOTOS_PER_PERSON} photos at a time.`;
    }
    return res.redirect(`/?tab=${uploadTab}&error=` + encodeURIComponent(message));
  }

  if (err) {
    const uploadTab = uploadTabFromRequest(_req);
    return res.redirect(`/?tab=${uploadTab}&error=` + encodeURIComponent(err.message || 'Unexpected error occurred.'));
  }

  return res.status(500).send('Unexpected server error');
});

function startServer() {
  return app.listen(port, () => {
    const displayUrl = configuredBaseUrl || `http://localhost:${port}`;
    console.log(`Wedding photo app running on ${displayUrl}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  db,
  startServer,
  __internals: {
    uploadDir,
    dataDir,
    storageDestination,
    storageFilename,
    photoFileFilter,
    videoFileFilter
  }
};
