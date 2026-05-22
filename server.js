// ============================================================
// Zdown — Video Downloader (TikTok / Instagram / Facebook)
// Flows: Download · Audio · Frames
// ============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const multer = require('multer');
const axios = require('axios');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8097;
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS, 10) || 10 * 60 * 1000;
const MAX_FILE_AGE_MS = parseInt(process.env.MAX_FILE_AGE_MS, 10) || 60 * 60 * 1000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Directories (env-overridable, resolved relative to project root)
const DOWNLOADS_DIR = path.resolve(__dirname, process.env.DOWNLOAD_DIR || './downloads');
const FRAMES_DIR = path.resolve(__dirname, process.env.FRAMES_DIR || './frames');
const UPLOADS_DIR = path.resolve(__dirname, process.env.UPLOADS_DIR || './uploads');
[DOWNLOADS_DIR, FRAMES_DIR, UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Multer storage for client-uploaded files (videos for audio/frames extraction)
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomBytes(4).toString('hex');
    const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
    cb(null, `upload_${id}${ext}`);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

// Tool paths (env-overridable; fall back to bundled ./bin/ for legacy deploy)
const YT_DLP = process.env.YT_DLP_PATH || path.join(__dirname, 'bin', 'yt-dlp');
const FFMPEG = process.env.FFMPEG_PATH || path.join(__dirname, 'bin', 'ffmpeg');
const FFPROBE = process.env.FFPROBE_PATH || path.join(__dirname, 'bin', 'ffprobe');
const FFMPEG_DIR = process.env.FFMPEG_DIR || path.dirname(FFMPEG);

// Cobalt.tools API (used by F1 Download). URL + optional API key are env-overridable.
const COBALT_API_URL = process.env.COBALT_API_URL || 'https://cobalt-api.fly.dev/';
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';

async function cobaltFetch(videoUrl) {
  const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
  if (COBALT_API_KEY) headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;
  const resp = await axios.post(COBALT_API_URL, { url: videoUrl }, {
    headers,
    timeout: 30000,
    validateStatus: () => true,
  });
  return { status: resp.status, data: resp.data };
}

function cobaltErrorMessage(data) {
  const code = data?.error?.code || 'unknown';
  if (code.includes('auth')) return `Cobalt yêu cầu xác thực (${code}). Set COBALT_API_KEY hoặc đổi COBALT_API_URL.`;
  if (code.includes('fetch')) return `Cobalt không tải được video (${code}). Có thể link không hợp lệ hoặc bị chặn.`;
  if (code.includes('content')) return `Cobalt không tìm thấy nội dung (${code}).`;
  return `Cobalt lỗi: ${code}`;
}

// ============================================================
// Utility Functions
// ============================================================

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) return 'facebook';
  return 'unknown';
}

function normalizeUrl(url) {
  if (/tiktok\.com/i.test(url)) {
    url = url.replace(/\/photo\//, '/video/');
  }
  if (/instagram\.com/i.test(url)) {
    url = url.split('?')[0];
    if (!url.endsWith('/')) url += '/';
  }
  return url;
}

function sanitizeFilename(name) {
  if (!name) return 'video';
  let safe = name.replace(/[^\x20-\x7E]/g, '');
  safe = safe.replace(/[<>:"\/\\|?*%#&{}$!`@=+^~]/g, '');
  safe = safe.replace(/\s+/g, '_').trim();
  safe = safe.substring(0, 60);
  safe = safe.replace(/[_.]+$/, '');
  return safe || 'video';
}

// ============================================================
// API: Get Video Info  (cobalt.tools)
// ============================================================
app.post('/api/info', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    return res.status(400).json({ error: 'Nền tảng không được hỗ trợ.' });
  }

  url = normalizeUrl(url);
  console.log(`[INFO] (cobalt) ${url}`);

  try {
    const { status, data } = await cobaltFetch(url);

    if (data?.status === 'error') {
      console.error('[INFO] cobalt error:', JSON.stringify(data.error));
      return res.status(status >= 400 ? status : 502).json({ error: cobaltErrorMessage(data) });
    }

    let tunnelUrl = null;
    let title = 'Untitled';
    let isPhoto = false;

    if (data?.status === 'tunnel' || data?.status === 'redirect') {
      tunnelUrl = data.url;
      title = data.filename || title;
    } else if (data?.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
      tunnelUrl = data.picker[0].url;
      title = data.picker[0].filename || title;
      isPhoto = data.picker.every(p => p.type === 'photo');
    } else {
      return res.status(502).json({ error: `Cobalt response không nhận diện được (status=${data?.status}).` });
    }

    res.json({
      platform,
      title,
      description: '',
      thumbnail: data?.thumb || '',
      duration: 0,
      uploader: 'Unknown',
      view_count: 0,
      like_count: 0,
      formats: [{
        format_id: 'cobalt',
        ext: 'mp4',
        resolution: 'auto',
        filesize: null,
        quality: 0,
        has_video: !isPhoto,
        has_audio: true,
        format_note: 'Cobalt',
        width: 0,
        height: 0,
      }],
      webpage_url: url,
      is_photo: isPhoto,
      _cobalt_url: tunnelUrl,
    });
  } catch (e) {
    console.error('[INFO] cobalt request failed:', e.message);
    return res.status(502).json({ error: `Không gọi được Cobalt API: ${e.message}` });
  }
});

// ============================================================
// API: Download Video  (cobalt.tools — trả redirect_url, FE tự fetch)
// ============================================================
app.post('/api/download', async (req, res) => {
  let { url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Nền tảng không được hỗ trợ.' });

  url = normalizeUrl(url);
  console.log(`[DOWNLOAD] (cobalt) ${url}`);

  try {
    const { status, data } = await cobaltFetch(url);
    if (data?.status === 'error') {
      console.error('[DOWNLOAD] cobalt error:', JSON.stringify(data.error));
      return res.status(status >= 400 ? status : 502).json({ error: cobaltErrorMessage(data) });
    }

    let redirectUrl = null;
    let cobaltFilename = null;
    let picker = null;

    if (data?.status === 'tunnel' || data?.status === 'redirect') {
      redirectUrl = data.url;
      cobaltFilename = data.filename || null;
    } else if (data?.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
      redirectUrl = data.picker[0].url;
      cobaltFilename = data.picker[0].filename || null;
      picker = data.picker.map(p => ({ url: p.url, type: p.type, thumb: p.thumb || null }));
    } else {
      return res.status(502).json({ error: `Cobalt response không nhận diện được (status=${data?.status}).` });
    }

    const baseName = sanitizeFilename(title || (cobaltFilename ? path.parse(cobaltFilename).name : 'video'));
    const ext = cobaltFilename ? (path.extname(cobaltFilename).replace('.', '') || 'mp4') : 'mp4';
    const filename = cobaltFilename || `${baseName}.${ext}`;

    console.log(`[DOWNLOAD] OK (redirect): ${filename}`);
    return res.json({
      success: true,
      redirect_url: redirectUrl,
      filename,
      picker,
    });
  } catch (e) {
    console.error('[DOWNLOAD] cobalt request failed:', e.message);
    return res.status(502).json({ error: `Không gọi được Cobalt API: ${e.message}` });
  }
});

// ============================================================
// API: Extract Audio (MP3) from Video
// ============================================================
app.post('/api/audio', async (req, res) => {
  let { url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Nền tảng không được hỗ trợ.' });

  url = normalizeUrl(url);
  const fileId = crypto.randomBytes(4).toString('hex');
  const safeName = sanitizeFilename(title);
  const outputTemplate = path.join(DOWNLOADS_DIR, `${safeName}_${fileId}.%(ext)s`);
  console.log(`[AUDIO] ${url}`);

  const args = [
    '-o', outputTemplate, '--no-warnings', '--no-check-certificates',
    '--ffmpeg-location', FFMPEG_DIR,
    '-f', 'bestaudio/best',
    '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    url,
  ];

  execFile(YT_DLP, args, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      console.error('Audio extract error:', stderr || error.message);
      return res.status(500).json({ error: 'Tách audio thất bại.' });
    }

    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.includes(fileId) && /\.mp3$/i.test(f));
    if (files.length === 0) return res.status(500).json({ error: 'Không tìm thấy file audio.' });

    const filename = files[0];
    const stat = fs.statSync(path.join(DOWNLOADS_DIR, filename));
    console.log(`[AUDIO] OK: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    res.json({
      success: true, filename, filesize: stat.size,
      download_url: `/downloads/${encodeURIComponent(filename)}`,
    });
  });
});

// ============================================================
// API: Extract Frames from Video
// ============================================================
app.post('/api/frames', async (req, res) => {
  let { url, format_id, title, fps, max_frames } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Nền tảng không được hỗ trợ.' });

  url = normalizeUrl(url);
  fps = fps || 1; // frames per second
  max_frames = max_frames || 20;

  console.log(`[FRAMES] Extracting from ${url} (${fps} fps, max ${max_frames})`);

  // Step 1: Download video first
  const fileId = crypto.randomBytes(4).toString('hex');
  const safeName = sanitizeFilename(title);
  const videoOutput = path.join(DOWNLOADS_DIR, `${safeName}_${fileId}.%(ext)s`);

  const dlArgs = [
    '-o', videoOutput, '--no-warnings', '--no-check-certificates',
    '--ffmpeg-location', FFMPEG_DIR,
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  ];
  if (format_id && format_id !== 'audio') {
    dlArgs.push('-f', format_id, '--merge-output-format', 'mp4');
  } else {
    dlArgs.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4');
  }
  dlArgs.push(url);

  execFile(YT_DLP, dlArgs, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 }, (dlErr, dlOut, dlStderr) => {
    if (dlErr) {
      console.error('Frame download error:', dlStderr || dlErr.message);
      return res.status(500).json({ error: 'Không thể tải video để trích xuất khung hình.' });
    }

    const videoFiles = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.includes(fileId) && /\.(mp4|mkv|webm|avi)$/i.test(f));
    if (videoFiles.length === 0) return res.status(500).json({ error: 'Không tìm thấy file video.' });

    const videoPath = path.join(DOWNLOADS_DIR, videoFiles[0]);
    const frameDir = path.join(FRAMES_DIR, fileId);
    fs.mkdirSync(frameDir, { recursive: true });

    // Step 2: Extract frames with ffmpeg
    const frameOutput = path.join(frameDir, 'frame_%04d.jpg');
    const ffmpegArgs = [
      '-i', videoPath,
      '-vf', `fps=${fps}`,
      '-frames:v', String(max_frames),
      '-q:v', '2',  // high quality JPEG
      frameOutput,
    ];

    execFile(FFMPEG, ffmpegArgs, { timeout: 60000 }, (ffErr, ffOut, ffStderr) => {
      if (ffErr) {
        console.error('FFmpeg error:', ffStderr || ffErr.message);
        return res.status(500).json({ error: 'Lỗi trích xuất khung hình.' });
      }

      // Collect frame paths
      const frameFiles = fs.readdirSync(frameDir)
        .filter(f => /\.jpg$/i.test(f))
        .sort()
        .map(f => ({
          filename: f,
          url: `/frames/${fileId}/${f}`,
          size: fs.statSync(path.join(frameDir, f)).size,
        }));

      console.log(`[FRAMES] OK: ${frameFiles.length} frames extracted`);

      res.json({
        success: true,
        frame_id: fileId,
        frame_count: frameFiles.length,
        frames: frameFiles,
        video_file: videoFiles[0],
      });
    });
  });
});

// ============================================================
// API: Extract Audio from Uploaded File
// ============================================================
app.post('/api/audio-from-file', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Thiếu file upload.' });

  const inputPath = req.file.path;
  const rawFormat = (req.body.format || 'mp3').toLowerCase();
  if (rawFormat !== 'mp3' && rawFormat !== 'wav') {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Format không hợp lệ. Chỉ hỗ trợ: mp3, wav.' });
  }
  const format = rawFormat;
  const fileId = crypto.randomBytes(4).toString('hex');
  const baseName = sanitizeFilename(path.basename(req.file.originalname || 'audio', path.extname(req.file.originalname || '')));
  const outFilename = `${baseName}_${fileId}.${format}`;
  const outputPath = path.join(DOWNLOADS_DIR, outFilename);

  console.log(`[AUDIO-FILE] ${req.file.originalname} → ${format}`);

  const ffArgs = ['-y', '-i', inputPath, '-vn'];
  if (format === 'mp3') {
    ffArgs.push('-c:a', 'libmp3lame', '-q:a', '2');
  } else {
    ffArgs.push('-c:a', 'pcm_s16le');
  }
  ffArgs.push(outputPath);

  execFile(FFMPEG, ffArgs, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 }, (err, _out, stderr) => {
    fs.unlink(inputPath, () => {});
    if (err) {
      console.error('Audio-file ffmpeg error:', stderr || err.message);
      return res.status(500).json({ error: 'Tách audio từ file thất bại.' });
    }
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Không tạo được file audio.' });
    }
    const stat = fs.statSync(outputPath);
    console.log(`[AUDIO-FILE] OK: ${outFilename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
    res.json({
      success: true,
      filename: outFilename,
      size: stat.size,
      download_url: `/downloads/${encodeURIComponent(outFilename)}`,
    });
  });
});

// ============================================================
// API: Extract Frames from Uploaded File
// ============================================================
app.post('/api/frames-from-file', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Thiếu file upload.' });

  const inputPath = req.file.path;
  const rawN = req.body.n_frames;
  const nFrames = parseInt(rawN, 10);
  if (rawN === undefined || rawN === '' || !Number.isFinite(nFrames) || nFrames < 1) {
    fs.unlink(inputPath, () => {});
    return res.status(400).json({ error: 'n_frames phải là số nguyên >= 1.' });
  }
  if (nFrames > 200) {
    fs.unlink(inputPath, () => {});
    return res.status(400).json({ error: 'n_frames tối đa là 200.' });
  }

  const sessionId = crypto.randomBytes(4).toString('hex');
  const frameDir = path.join(FRAMES_DIR, sessionId);
  fs.mkdirSync(frameDir, { recursive: true });

  console.log(`[FRAMES-FILE] ${req.file.originalname} → ${nFrames} frames`);

  // Step 1: probe duration
  const probeArgs = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath];
  execFile(FFPROBE, probeArgs, { timeout: 30000 }, (probeErr, probeOut) => {
    if (probeErr) {
      fs.unlink(inputPath, () => {});
      console.error('ffprobe error:', probeErr.message);
      return res.status(500).json({ error: 'Không đọc được thời lượng video.' });
    }
    const duration = parseFloat(String(probeOut).trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      fs.unlink(inputPath, () => {});
      return res.status(500).json({ error: 'Video không hợp lệ.' });
    }

    // Step 2: compute fps so we get ~nFrames evenly-spaced frames
    const fps = nFrames / duration;
    const frameOutput = path.join(frameDir, 'frame_%04d.jpg');
    const ffmpegArgs = [
      '-y', '-i', inputPath,
      '-vf', `fps=${fps.toFixed(6)}`,
      '-frames:v', String(nFrames),
      '-q:v', '2',
      frameOutput,
    ];

    execFile(FFMPEG, ffmpegArgs, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 }, (ffErr, _ffOut, ffStderr) => {
      fs.unlink(inputPath, () => {});
      if (ffErr) {
        console.error('FFmpeg frames-file error:', ffStderr || ffErr.message);
        return res.status(500).json({ error: 'Trích xuất khung hình thất bại.' });
      }

      const frameFiles = fs.readdirSync(frameDir)
        .filter(f => /\.jpg$/i.test(f))
        .sort()
        .map(f => ({
          filename: f,
          url: `/frames/${sessionId}/${f}`,
        }));

      if (frameFiles.length === 0) {
        return res.status(500).json({ error: 'Không có khung hình nào được tạo.' });
      }

      console.log(`[FRAMES-FILE] OK: ${frameFiles.length} frames (session ${sessionId})`);
      res.json({
        success: true,
        session_id: sessionId,
        total: frameFiles.length,
        frames: frameFiles,
        zip_url: `/api/frames-zip/${sessionId}`,
      });
    });
  });
});

// ============================================================
// Static File Serving
// ============================================================
app.use('/downloads', express.static(DOWNLOADS_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    const basename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${basename}"`);
  }
}));

// Serve frames as images (not as downloads)
app.use('/frames', express.static(FRAMES_DIR));

// ============================================================
// API: Download Frames as ZIP
// ============================================================
app.get('/api/frames-zip/:frameId', (req, res) => {
  const frameId = req.params.frameId.replace(/[^a-f0-9]/gi, '');
  const frameDir = path.join(FRAMES_DIR, frameId);

  if (!fs.existsSync(frameDir)) {
    return res.status(404).json({ error: 'Frames not found' });
  }

  const frameFiles = fs.readdirSync(frameDir).filter(f => /\.jpg$/i.test(f)).sort();
  if (frameFiles.length === 0) {
    return res.status(404).json({ error: 'No frames found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="frames_${frameId}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('ZIP error:', err);
    res.status(500).end();
  });
  archive.pipe(res);

  frameFiles.forEach((file, i) => {
    const filePath = path.join(frameDir, file);
    archive.file(filePath, { name: `frame_${String(i + 1).padStart(3, '0')}.jpg` });
  });

  archive.finalize();
  console.log(`[ZIP] Zipped ${frameFiles.length} frames for ${frameId}`);
});

// ============================================================
// Cleanup (files older than 1 hour)
// ============================================================
setInterval(() => {
  const now = Date.now();
  const cleanDir = (dir) => {
    try {
      fs.readdirSync(dir).forEach(item => {
        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          if (now - stat.mtimeMs > MAX_FILE_AGE_MS) {
            fs.rmSync(itemPath, { recursive: true });
            console.log('[CLEANUP]', item);
          }
        } else if (now - stat.mtimeMs > MAX_FILE_AGE_MS) {
          fs.unlinkSync(itemPath);
          console.log('[CLEANUP]', item);
        }
      });
    } catch (e) {}
  };
  cleanDir(DOWNLOADS_DIR);
  cleanDir(FRAMES_DIR);
}, CLEANUP_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`🚀 Zdown running at http://localhost:${PORT}`);
});
