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
[DOWNLOADS_DIR, FRAMES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Tool paths (env-overridable; fall back to bundled ./bin/ for legacy deploy)
const YT_DLP = process.env.YT_DLP_PATH || path.join(__dirname, 'bin', 'yt-dlp');
const FFMPEG = process.env.FFMPEG_PATH || path.join(__dirname, 'bin', 'ffmpeg');
const FFPROBE = process.env.FFPROBE_PATH || path.join(__dirname, 'bin', 'ffprobe');
const FFMPEG_DIR = process.env.FFMPEG_DIR || path.dirname(FFMPEG);

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
// API: Get Video Info
// ============================================================
app.post('/api/info', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    return res.status(400).json({ error: 'Nền tảng không được hỗ trợ.' });
  }

  url = normalizeUrl(url);
  console.log(`[INFO] Fetching: ${url}`);

  const args = [
    '--no-download', '--dump-json', '--no-warnings', '--no-check-certificates',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];
  if (platform === 'instagram') args.push('--extractor-args', 'instagram:api_only=false');
  args.push(url);

  execFile(YT_DLP, args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      console.error('yt-dlp error:', stderr || error.message);
      let errMsg = 'Không thể lấy thông tin video.';
      if (stderr) {
        if (stderr.includes('Private') || stderr.includes('login')) errMsg = 'Video riêng tư hoặc yêu cầu đăng nhập.';
        else if (stderr.includes('not available')) errMsg = 'Video không tồn tại hoặc đã bị xóa.';
        else if (stderr.includes('Unsupported URL')) errMsg = 'URL không được hỗ trợ.';
      }
      return res.status(500).json({ error: errMsg });
    }

    try {
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      const formats = (info.formats || [])
        .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
        .map(f => ({
          format_id: f.format_id, ext: f.ext,
          resolution: f.resolution || (f.width && f.height ? `${f.width}x${f.height}` : f.format_note || 'unknown'),
          filesize: f.filesize || f.filesize_approx || null,
          quality: f.quality || f.height || 0,
          has_video: f.vcodec !== 'none', has_audio: f.acodec !== 'none',
          format_note: f.format_note || '', width: f.width || 0, height: f.height || 0,
        }));

      const bestFormats = formats.filter(f => f.has_video && f.has_audio);
      const isPhotoSlideshow = formats.length > 0 && formats.every(f => !f.has_video);

      let thumbnail = info.thumbnail || '';
      if (!thumbnail && info.thumbnails && info.thumbnails.length > 0) {
        thumbnail = info.thumbnails[info.thumbnails.length - 1].url || '';
      }

      res.json({
        platform,
        title: info.title || info.fulltitle || 'Untitled',
        description: (info.description || '').substring(0, 200),
        thumbnail, duration: info.duration || 0,
        uploader: info.channel || info.uploader || 'Unknown',
        view_count: info.view_count || 0, like_count: info.like_count || 0,
        formats: bestFormats.length > 0 ? bestFormats : formats.slice(0, 10),
        webpage_url: info.webpage_url || url,
        is_photo: isPhotoSlideshow,
      });
    } catch (e) {
      res.status(500).json({ error: 'Không thể phân tích thông tin video.' });
    }
  });
});

// ============================================================
// API: Download Video
// ============================================================
app.post('/api/download', async (req, res) => {
  let { url, format_id, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') return res.status(400).json({ error: 'Nền tảng không được hỗ trợ.' });

  url = normalizeUrl(url);
  const fileId = crypto.randomBytes(4).toString('hex');
  const safeName = sanitizeFilename(title);
  const outputTemplate = path.join(DOWNLOADS_DIR, `${safeName}_${fileId}.%(ext)s`);
  console.log(`[DOWNLOAD] ${url} (format: ${format_id || 'best'})`);

  const args = [
    '-o', outputTemplate, '--no-warnings', '--no-check-certificates',
    '--ffmpeg-location', FFMPEG_DIR,
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];

  if (format_id) {
    args.push('-f', format_id);
    if (format_id !== 'audio') args.push('--merge-output-format', 'mp4');
  } else {
    args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best');
    args.push('--merge-output-format', 'mp4');
  }
  args.push(url);

  execFile(YT_DLP, args, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      console.error('Download error:', stderr || error.message);
      return res.status(500).json({ error: 'Tải video thất bại.' });
    }

    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.includes(fileId));
    if (files.length === 0) return res.status(500).json({ error: 'Không tìm thấy file.' });

    const filename = files[0];
    const stat = fs.statSync(path.join(DOWNLOADS_DIR, filename));
    console.log(`[DOWNLOAD] OK: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    res.json({
      success: true, filename, filesize: stat.size,
      download_url: `/downloads/${encodeURIComponent(filename)}`,
    });
  });
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
