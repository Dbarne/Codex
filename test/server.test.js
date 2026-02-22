const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const multer = require('multer');

const serverModulePath = path.resolve(__dirname, '..', 'server.js');

function setEnv(overrides) {
  const keys = Object.keys(overrides);
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  };
}

function routeHandlers(app, method, routePath) {
  const layer = app._router.stack.find(
    (entry) => entry.route && entry.route.path === routePath && entry.route.methods[method]
  );
  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.map((item) => item.handle);
}

function errorMiddleware(app) {
  const layer = app._router.stack.find((entry) => !entry.route && entry.handle && entry.handle.length === 4);
  assert.ok(layer, 'Error middleware not found');
  return layer.handle;
}

function makeReq(overrides = {}) {
  const req = {
    headers: {},
    body: {},
    query: {},
    params: {},
    session: {},
    files: [],
    path: '/',
    protocol: 'http',
    ...overrides
  };
  req.get =
    req.get ||
    ((name) => {
      const key = String(name).toLowerCase();
      return req.headers[key];
    });
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    redirectedTo: null,
    rendered: null,
    sentFilePath: null,
    downloaded: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
      return this;
    },
    render(view, data) {
      this.rendered = { view, data };
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    },
    sendFile(filePath) {
      this.sentFilePath = filePath;
      return this;
    },
    download(filePath, fileName, cb) {
      this.downloaded = { filePath, fileName };
      if (typeof cb === 'function') {
        cb();
      }
      return this;
    }
  };
}

function makeUploadedFile(uploadDir, options = {}) {
  const ext = options.ext || '.bin';
  const filename = options.filename || `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
  const fullPath = path.join(uploadDir, filename);
  const content = options.content || Buffer.from('test-file');
  fs.writeFileSync(fullPath, content);
  return {
    path: fullPath,
    filename,
    originalname: options.originalname || filename,
    mimetype: options.mimetype || 'application/octet-stream',
    size: options.size || content.length
  };
}

async function invoke(handler, req, res, next = () => {}) {
  const result = handler(req, res, next);
  if (result && typeof result.then === 'function') {
    await result;
  }
}

test('server route logic coverage', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-tests-'));
  const dataDir = path.join(tempRoot, 'data');
  const uploadDir = path.join(tempRoot, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  const restoreEnv = setEnv({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    UPLOAD_DIR: uploadDir,
    SESSION_SECRET: 'test-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'pw',
    BASE_URL: '',
    MAX_VIDEOS_PER_PERSON: '2',
    MAX_TOTAL_VIDEOS: '3',
    MAX_VIDEO_SIZE_MB: '1'
  });

  delete require.cache[serverModulePath];
  const mod = require(serverModulePath);
  const { app, db } = mod;

  try {
    const getRoot = routeHandlers(app, 'get', '/')[0];
    const getQuickPhoto = routeHandlers(app, 'get', '/quick-photo')[0];
    const postUpload = routeHandlers(app, 'post', '/upload').at(-1);
    const postUploadVideos = routeHandlers(app, 'post', '/upload/videos').at(-1);
    const getAdminLogin = routeHandlers(app, 'get', '/admin/login')[0];
    const postAdminLogin = routeHandlers(app, 'post', '/admin/login')[0];
    const postAdminLogout = routeHandlers(app, 'post', '/admin/logout')[0];
    const getAdminPhotos = routeHandlers(app, 'get', '/admin/photos').at(-1);
    const getAdminVideos = routeHandlers(app, 'get', '/admin/videos').at(-1);
    const getAdminExportHealth = routeHandlers(app, 'get', '/admin/export-health').at(-1);
    const getAdminPhoto = routeHandlers(app, 'get', '/admin/photo/:id').at(-1);
    const postAdminPhotoDelete = routeHandlers(app, 'post', '/admin/photo/:id/delete').at(-1);
    const postDeleteAllPhotos = routeHandlers(app, 'post', '/admin/photos/delete-all').at(-1);
    const getDownloadPhotos = routeHandlers(app, 'get', '/admin/photos/download').at(-1);
    const getAdminVideo = routeHandlers(app, 'get', '/admin/video/:id').at(-1);
    const postAdminVideoDelete = routeHandlers(app, 'post', '/admin/video/:id/delete').at(-1);
    const postDeleteAllVideos = routeHandlers(app, 'post', '/admin/videos/delete-all').at(-1);
    const getDownloadVideos = routeHandlers(app, 'get', '/admin/videos/download').at(-1);
    const requireAdmin = routeHandlers(app, 'get', '/admin/photos')[0];
    const onError = errorMiddleware(app);
    const { __internals } = mod;

    {
      let filterResult = null;
      __internals.photoFileFilter({}, { mimetype: 'image/png' }, (err, ok) => {
        assert.equal(err, null);
        filterResult = ok;
      });
      assert.equal(filterResult, true);

      __internals.photoFileFilter({}, { mimetype: 'text/plain' }, (err) => {
        assert.match(err.message, /Only image files/);
      });

      __internals.videoFileFilter({}, { mimetype: 'video/mp4' }, (err, ok) => {
        assert.equal(err, null);
        assert.equal(ok, true);
      });

      __internals.videoFileFilter({}, { mimetype: 'image/png' }, (err) => {
        assert.match(err.message, /Only video files/);
      });

      __internals.storageDestination({}, {}, (err, dir) => {
        assert.equal(err, null);
        assert.equal(dir, uploadDir);
      });

      __internals.storageFilename({}, { originalname: 'x.jpg' }, (err, value) => {
        assert.equal(err, null);
        assert.match(value, /\.jpg$/);
      });
    }

    let req = makeReq({ headers: { host: 'localhost:3000' } });
    let res = makeRes();
    await invoke(getRoot, req, res);
    assert.equal(res.rendered.view, 'index');
    assert.equal(res.rendered.data.activeTab, 'photos');
    assert.match(res.rendered.data.baseUrl, /http:\/\/localhost:3000/);

    req = makeReq({
      path: '/upload',
      body: { name: '' },
      files: [
        makeUploadedFile(uploadDir, {
          ext: '.jpg',
          originalname: 'photo.jpg',
          mimetype: 'image/jpeg'
        })
      ]
    });
    res = makeRes();
    await invoke(postUpload, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Please provide your name/);

    req = makeReq({ path: '/upload', body: { name: 'A' }, files: [] });
    res = makeRes();
    await invoke(postUpload, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Please select at least one photo/);

    req = makeReq({
      path: '/upload',
      body: { name: 'Alice' },
      files: [
        makeUploadedFile(uploadDir, {
          ext: '.jpg',
          originalname: 'a.jpg',
          mimetype: 'image/jpeg'
        })
      ]
    });
    res = makeRes();
    await invoke(postUpload, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Uploaded 1 photo/);

    req = makeReq({
      path: '/upload',
      body: { name: 'DupePhoto' },
      files: [
        makeUploadedFile(uploadDir, {
          ext: '.jpg',
          originalname: 'dupe-photo.jpg',
          mimetype: 'image/jpeg',
          content: Buffer.alloc(4096, 1)
        })
      ]
    });
    res = makeRes();
    await invoke(postUpload, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Uploaded 1 photo/);

    req = makeReq({
      path: '/upload',
      body: { name: 'DupePhoto' },
      files: [
        makeUploadedFile(uploadDir, {
          ext: '.jpg',
          originalname: 'dupe-photo.jpg',
          mimetype: 'image/jpeg',
          content: Buffer.alloc(4096, 1)
        })
      ]
    });
    res = makeRes();
    await invoke(postUpload, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /duplicate photo/);

    {
      const uploader = db.prepare('SELECT id FROM uploaders WHERE normalized_name = ?').get('alice');
      for (let i = 0; i < 8; i += 1) {
        const extraPhoto = makeUploadedFile(uploadDir, {
          ext: '.jpg',
          originalname: `existing-${i}.jpg`,
          mimetype: 'image/jpeg'
        });
        db.prepare(
          'INSERT INTO photos (uploader_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)'
        ).run(uploader.id, extraPhoto.filename, extraPhoto.originalname, extraPhoto.mimetype, extraPhoto.size);
      }

      req = makeReq({
        path: '/upload',
        body: { name: 'Alice' },
        files: [
          makeUploadedFile(uploadDir, {
            ext: '.jpg',
            originalname: 'accepted.jpg',
            mimetype: 'image/jpeg'
          }),
          makeUploadedFile(uploadDir, {
            ext: '.jpg',
            originalname: 'rejected.jpg',
            mimetype: 'image/jpeg'
          })
        ]
      });
      res = makeRes();
      await invoke(postUpload, req, res);
      assert.match(decodeURIComponent(res.redirectedTo), /skipped due to upload limits/);
    }

    req = makeReq({
      path: '/upload',
      body: { name: 'Alice' },
      files: [
        makeUploadedFile(uploadDir, {
          ext: '.jpg',
          originalname: 'blocked.jpg',
          mimetype: 'image/jpeg'
        })
      ]
    });
    res = makeRes();
    await invoke(postUpload, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /maximum of 10 photos/);

    req = makeReq({
      path: '/upload',
      body: { name: 'ErrPhoto' },
      files: [
        {
          path: path.join(uploadDir, 'broken-photo.jpg'),
          originalname: 'broken-photo.jpg',
          mimetype: 'image/jpeg',
          size: 123
        }
      ]
    });
    res = makeRes();
    await invoke(postUpload, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /NOT NULL constraint failed|Upload failed/);

    req = makeReq({
      path: '/upload/videos',
      body: { name: '' },
      files: [
        makeUploadedFile(uploadDir, {
          ext: '.mp4',
          originalname: 'clip.mp4',
          mimetype: 'video/mp4',
          content: Buffer.alloc(1024, 1)
        })
      ]
    });
    res = makeRes();
    await invoke(postUploadVideos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Please provide your name/);

    req = makeReq({ path: '/upload/videos', body: { name: 'V' }, files: [] });
    res = makeRes();
    await invoke(postUploadVideos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Please select at least one video/);

    req = makeReq({
      path: '/upload/videos',
      body: { name: 'VidA' },
      files: [
        makeUploadedFile(uploadDir, {
          ext: '.mp4',
          originalname: 'v1.mp4',
          mimetype: 'video/mp4',
          content: Buffer.alloc(1024, 2)
        })
      ]
    });
    res = makeRes();
    await invoke(postUploadVideos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Uploaded 1 video/);

    req = makeReq({
      path: '/upload/videos',
      body: { name: 'VidA' },
      files: [
        makeUploadedFile(uploadDir, {
          ext: '.mp4',
          originalname: 'v2.mp4',
          mimetype: 'video/mp4',
          content: Buffer.alloc(1024, 3)
        }),
        makeUploadedFile(uploadDir, {
          ext: '.mp4',
          originalname: 'v3.mp4',
          mimetype: 'video/mp4',
          content: Buffer.alloc(1024, 4)
        })
      ]
    });
    res = makeRes();
    await invoke(postUploadVideos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /skipped due to upload limits/);

    req = makeReq({
      path: '/upload/videos',
      body: { name: 'VidA' },
      files: [
        makeUploadedFile(uploadDir, {
          ext: '.mp4',
          originalname: 'blocked-video.mp4',
          mimetype: 'video/mp4',
          content: Buffer.alloc(1024, 9)
        })
      ]
    });
    res = makeRes();
    await invoke(postUploadVideos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /maximum of 2 videos/);

    req = makeReq({
      path: '/upload/videos',
      body: { name: 'ErrVid' },
      files: [
        {
          path: path.join(uploadDir, 'broken-video.mp4'),
          originalname: 'broken-video.mp4',
          mimetype: 'video/mp4',
          size: 123
        }
      ]
    });
    res = makeRes();
    await invoke(postUploadVideos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /NOT NULL constraint failed|Upload failed/);

    req = makeReq({ query: { error: 'bad' } });
    res = makeRes();
    await invoke(getAdminLogin, req, res);
    assert.equal(res.rendered.view, 'admin-login');
    assert.equal(res.rendered.data.error, 'bad');

    req = makeReq({ query: { message: 'ok' } });
    res = makeRes();
    await invoke(getQuickPhoto, req, res);
    assert.equal(res.rendered.view, 'quick-photo');
    assert.equal(res.rendered.data.message, 'ok');

    req = makeReq({ session: { isAdmin: true } });
    res = makeRes();
    await invoke(getAdminLogin, req, res);
    assert.equal(res.redirectedTo, '/admin/photos');

    req = makeReq({ body: { username: 'bad', password: 'bad' }, session: {} });
    res = makeRes();
    await invoke(postAdminLogin, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Invalid username or password/);

    req = makeReq({ body: { username: 'admin', password: 'pw' }, session: {} });
    res = makeRes();
    await invoke(postAdminLogin, req, res);
    assert.equal(req.session.isAdmin, true);
    assert.equal(res.redirectedTo, '/admin/photos');

    let nextCalled = false;
    req = makeReq({ session: {} });
    res = makeRes();
    await invoke(requireAdmin, req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.redirectedTo, '/admin/login');

    nextCalled = false;
    req = makeReq({ session: { isAdmin: true } });
    res = makeRes();
    await invoke(requireAdmin, req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);

    req = makeReq({ session: { isAdmin: true }, query: { message: 'ok' } });
    res = makeRes();
    await invoke(getAdminPhotos, req, res);
    assert.equal(res.rendered.view, 'admin-photos');
    assert.equal(res.rendered.data.activeTab, 'photos');
    assert.ok(Array.isArray(res.rendered.data.mediaItems));

    req = makeReq({ session: { isAdmin: true } });
    res = makeRes();
    await invoke(getAdminVideos, req, res);
    assert.equal(res.rendered.data.activeTab, 'videos');

    req = makeReq({ session: { isAdmin: true } });
    res = makeRes();
    await invoke(getAdminExportHealth, req, res);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.health.missingPhotos, 'number');

    req = makeReq({ params: { id: 'abc' } });
    res = makeRes();
    await invoke(getAdminPhoto, req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Invalid photo ID/);

    req = makeReq({ params: { id: '999999' } });
    res = makeRes();
    await invoke(getAdminPhoto, req, res);
    assert.equal(res.statusCode, 404);

    const photoId = db.prepare('SELECT id FROM photos ORDER BY id DESC LIMIT 1').get().id;
    req = makeReq({ params: { id: String(photoId) } });
    res = makeRes();
    await invoke(getAdminPhoto, req, res);
    assert.ok(res.sentFilePath);

    db.prepare('INSERT INTO photos (uploader_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)').run(
      db.prepare('SELECT id FROM uploaders ORDER BY id DESC LIMIT 1').get().id,
      'missing-photo.jpg',
      'missing-photo.jpg',
      'image/jpeg',
      100
    );
    const missingPhotoId = db.prepare("SELECT id FROM photos WHERE filename = 'missing-photo.jpg'").get().id;
    req = makeReq({ params: { id: String(missingPhotoId) } });
    res = makeRes();
    await invoke(getAdminPhoto, req, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /File missing on server/);

    req = makeReq({ params: { id: 'bad' } });
    res = makeRes();
    await invoke(postAdminPhotoDelete, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Invalid photo ID/);

    req = makeReq({ params: { id: '999999' } });
    res = makeRes();
    await invoke(postAdminPhotoDelete, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Photo not found/);

    req = makeReq({ params: { id: String(photoId) } });
    res = makeRes();
    await invoke(postAdminPhotoDelete, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Photo deleted/);

    db.prepare('DELETE FROM photos').run();
    db.prepare("DELETE FROM uploaders WHERE id NOT IN (SELECT uploader_id FROM videos)").run();

    req = makeReq({});
    res = makeRes();
    await invoke(getDownloadPhotos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /No photos to download/);

    const zipPhoto = makeUploadedFile(uploadDir, {
      ext: '.jpg',
      originalname: 'zip-photo.jpg',
      mimetype: 'image/jpeg'
    });
    const uploaderId = db
      .prepare('INSERT INTO uploaders (name, normalized_name) VALUES (?, ?)')
      .run('Zip Photo', 'zip photo').lastInsertRowid;
    db.prepare('INSERT INTO photos (uploader_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)').run(
      uploaderId,
      zipPhoto.filename,
      zipPhoto.originalname,
      zipPhoto.mimetype,
      zipPhoto.size
    );
    req = makeReq({});
    res = makeRes();
    await invoke(getDownloadPhotos, req, res);
    assert.ok(res.downloaded || res.redirectedTo);

    db.prepare("UPDATE photos SET filename = 'missing-archive-photo.jpg'").run();
    req = makeReq({});
    res = makeRes();
    await invoke(getDownloadPhotos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Photo files are missing on disk/);

    const fsCopy = fs.copyFileSync;
    try {
      fs.copyFileSync = () => {
        throw new Error('copy fail');
      };
      const failPhoto = makeUploadedFile(uploadDir, {
        ext: '.jpg',
        originalname: 'fail-copy.jpg',
        mimetype: 'image/jpeg'
      });
      db.prepare("DELETE FROM photos").run();
      db.prepare("INSERT INTO photos (uploader_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)").run(
        uploaderId,
        failPhoto.filename,
        failPhoto.originalname,
        failPhoto.mimetype,
        failPhoto.size
      );
      req = makeReq({});
      res = makeRes();
      await invoke(getDownloadPhotos, req, res);
      assert.match(decodeURIComponent(res.redirectedTo), /Could not create ZIP archive/);
    } finally {
      fs.copyFileSync = fsCopy;
    }

    req = makeReq({ params: { id: 'abc' } });
    res = makeRes();
    await invoke(getAdminVideo, req, res);
    assert.equal(res.statusCode, 400);

    req = makeReq({ params: { id: '999999' } });
    res = makeRes();
    await invoke(getAdminVideo, req, res);
    assert.equal(res.statusCode, 404);

    const videoId = db.prepare('SELECT id FROM videos ORDER BY id DESC LIMIT 1').get().id;
    req = makeReq({ params: { id: String(videoId) } });
    res = makeRes();
    await invoke(getAdminVideo, req, res);
    assert.ok(res.sentFilePath);

    db.prepare('INSERT INTO videos (uploader_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)').run(
      db.prepare('SELECT id FROM uploaders ORDER BY id DESC LIMIT 1').get().id,
      'missing-video.mp4',
      'missing-video.mp4',
      'video/mp4',
      100
    );
    const missingVideoId = db.prepare("SELECT id FROM videos WHERE filename = 'missing-video.mp4'").get().id;
    req = makeReq({ params: { id: String(missingVideoId) } });
    res = makeRes();
    await invoke(getAdminVideo, req, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /File missing on server/);

    req = makeReq({ params: { id: 'bad' } });
    res = makeRes();
    await invoke(postAdminVideoDelete, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Invalid video ID/);

    req = makeReq({ params: { id: '999999' } });
    res = makeRes();
    await invoke(postAdminVideoDelete, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Video not found/);

    req = makeReq({ params: { id: String(videoId) } });
    res = makeRes();
    await invoke(postAdminVideoDelete, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Video deleted/);

    req = makeReq({});
    res = makeRes();
    await invoke(postDeleteAllVideos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /All videos deleted/);

    req = makeReq({});
    res = makeRes();
    await invoke(getDownloadVideos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /No videos to download/);

    const zipVideo = makeUploadedFile(uploadDir, {
      ext: '.mp4',
      originalname: 'zip-video.mp4',
      mimetype: 'video/mp4',
      content: Buffer.alloc(2048, 5)
    });
    const uploaderId2 = db
      .prepare('INSERT INTO uploaders (name, normalized_name) VALUES (?, ?)')
      .run('Zip Video', 'zip video').lastInsertRowid;
    db.prepare('INSERT INTO videos (uploader_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)').run(
      uploaderId2,
      zipVideo.filename,
      zipVideo.originalname,
      zipVideo.mimetype,
      zipVideo.size
    );
    req = makeReq({});
    res = makeRes();
    await invoke(getDownloadVideos, req, res);
    assert.ok(res.downloaded || res.redirectedTo);

    db.prepare("UPDATE videos SET filename = 'missing-archive-video.mp4'").run();
    req = makeReq({});
    res = makeRes();
    await invoke(getDownloadVideos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /Video files are missing on disk/);

    const fsCopyVideo = fs.copyFileSync;
    try {
      fs.copyFileSync = () => {
        throw new Error('copy fail');
      };
      const failVideo = makeUploadedFile(uploadDir, {
        ext: '.mp4',
        originalname: 'fail-copy.mp4',
        mimetype: 'video/mp4',
        content: Buffer.alloc(1024, 8)
      });
      db.prepare("DELETE FROM videos").run();
      db.prepare("INSERT INTO videos (uploader_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)").run(
        uploaderId2,
        failVideo.filename,
        failVideo.originalname,
        failVideo.mimetype,
        failVideo.size
      );
      req = makeReq({});
      res = makeRes();
      await invoke(getDownloadVideos, req, res);
      assert.match(decodeURIComponent(res.redirectedTo), /Could not create ZIP archive/);
    } finally {
      fs.copyFileSync = fsCopyVideo;
    }

    req = makeReq({});
    res = makeRes();
    await invoke(postDeleteAllPhotos, req, res);
    assert.match(decodeURIComponent(res.redirectedTo), /All photos deleted/);

    let destroyed = false;
    req = makeReq({
      session: {
        destroy(cb) {
          destroyed = true;
          cb();
        }
      }
    });
    res = makeRes();
    await invoke(postAdminLogout, req, res);
    assert.equal(destroyed, true);
    assert.equal(res.redirectedTo, '/admin/login');

    req = makeReq({ path: '/upload' });
    res = makeRes();
    await invoke(onError, new multer.MulterError('LIMIT_FILE_SIZE'), req, res, () => {});
    assert.match(decodeURIComponent(res.redirectedTo), /20MB per photo/);

    req = makeReq({ path: '/upload/videos' });
    res = makeRes();
    await invoke(onError, new multer.MulterError('LIMIT_FILE_SIZE'), req, res, () => {});
    assert.match(decodeURIComponent(res.redirectedTo), /Max size is 1MB per video/);

    req = makeReq({ path: '/upload/videos' });
    res = makeRes();
    await invoke(onError, new multer.MulterError('LIMIT_FILE_COUNT'), req, res, () => {});
    assert.match(decodeURIComponent(res.redirectedTo), /up to 2 videos at a time/);

    req = makeReq({ path: '/upload' });
    res = makeRes();
    await invoke(onError, new Error('boom'), req, res, () => {});
    assert.match(decodeURIComponent(res.redirectedTo), /boom/);

    req = makeReq({ path: '/upload' });
    res = makeRes();
    await invoke(onError, null, req, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /Unexpected server error/);

    const realListen = app.listen;
    try {
      let callbackRan = false;
      app.listen = (_port, cb) => {
        cb();
        callbackRan = true;
        return { close() {} };
      };
      const started = mod.startServer();
      assert.ok(started);
      assert.equal(callbackRan, true);
    } finally {
      app.listen = realListen;
    }
  } finally {
    db.close();
    restoreEnv();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete require.cache[serverModulePath];
  }
});

test('configured BASE_URL branch is used', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-tests-baseurl-'));
  const dataDir = path.join(tempRoot, 'data');
  const uploadDir = path.join(tempRoot, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  const restoreEnv = setEnv({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    UPLOAD_DIR: uploadDir,
    SESSION_SECRET: 'test-secret',
    BASE_URL: 'https://wedding.example.uk'
  });

  delete require.cache[serverModulePath];
  const mod = require(serverModulePath);
  const getRoot = routeHandlers(mod.app, 'get', '/')[0];

  try {
    const req = makeReq({ headers: { host: 'localhost:3000' } });
    const res = makeRes();
    await invoke(getRoot, req, res);
    assert.equal(res.rendered.view, 'index');
    assert.equal(res.rendered.data.baseUrl, 'https://wedding.example.uk');
  } finally {
    mod.db.close();
    restoreEnv();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete require.cache[serverModulePath];
  }
});
