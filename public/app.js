// ============================
// SnapSave - Video Downloader App
// ============================
(function () {
  'use strict';

  // DOM Elements
  const urlInput = document.getElementById('url-input');
  const pasteBtn = document.getElementById('paste-btn');
  const downloadBtn = document.getElementById('download-btn');
  const btnText = downloadBtn.querySelector('.btn-text');
  const btnLoader = downloadBtn.querySelector('.btn-loader');
  const btnIcon = downloadBtn.querySelector('.btn-icon');
  const errorContainer = document.getElementById('error-container');
  const errorText = document.getElementById('error-text');
  const loadingContainer = document.getElementById('loading-container');
  const loadingTitle = document.getElementById('loading-title');
  const loadingTextEl = document.getElementById('loading-text');
  const loadingBarFill = document.getElementById('loading-bar-fill');
  const resultContainer = document.getElementById('result-container');
  const resultClose = document.getElementById('result-close');
  const downloadActionBtn = document.getElementById('download-action-btn');
  const framesActionBtn = document.getElementById('frames-action-btn');
  const audioActionBtn = document.getElementById('audio-action-btn');
  const transcribeActionBtn = document.getElementById('transcribe-action-btn');
  const downloadProgress = document.getElementById('download-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const framesContainer = document.getElementById('frames-container');
  const framesGrid = document.getElementById('frames-grid');
  const framesClose = document.getElementById('frames-close');
  const framesDownloadAll = document.getElementById('frames-download-all');

  let currentVideoInfo = null;
  let selectedFormatId = null;
  let currentFrames = [];
  let currentFrameId = null;

  // ============================
  // Utilities
  // ============================
  function formatDuration(seconds) {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function formatTimestamp(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}.${ms.toString().padStart(2,'0')}`;
  }

  function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  function detectPlatform(url) {
    if (/tiktok\.com/i.test(url)) return 'tiktok';
    if (/instagram\.com/i.test(url)) return 'instagram';
    if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) return 'facebook';
    return null;
  }

  function getPlatformConfig(platform) {
    return {
      tiktok: { name: 'TikTok', color: '#00f2ea', bg: 'rgba(0,242,234,0.15)' },
      instagram: { name: 'Instagram', color: '#e4405f', bg: 'rgba(228,64,95,0.15)' },
      facebook: { name: 'Facebook', color: '#1877f2', bg: 'rgba(24,119,242,0.15)' },
    }[platform] || { name: 'Unknown', color: '#888', bg: 'rgba(136,136,136,0.15)' };
  }

  // ============================
  // UI State Management
  // ============================
  function showError(message) {
    errorText.textContent = message;
    errorContainer.style.display = 'block';
    loadingContainer.style.display = 'none';
    setTimeout(() => { errorContainer.style.display = 'none'; }, 6000);
  }

  function hideError() { errorContainer.style.display = 'none'; }

  function showLoading(title, text) {
    loadingTitle.textContent = title || 'Đang phân tích video...';
    loadingTextEl.textContent = text || 'Vui lòng chờ trong giây lát';
    loadingBarFill.style.animation = 'none';
    void loadingBarFill.offsetHeight; // Force reflow
    loadingBarFill.style.animation = 'loadingProgress 15s ease-out forwards';
    loadingContainer.style.display = 'block';
    errorContainer.style.display = 'none';
  }

  function hideLoading() { loadingContainer.style.display = 'none'; }

  function setButtonLoading(loading) {
    btnText.style.display = loading ? 'none' : '';
    btnIcon.style.display = loading ? 'none' : '';
    btnLoader.style.display = loading ? 'flex' : 'none';
    downloadBtn.disabled = loading;
  }

  function showResult(info) {
    currentVideoInfo = info;
    selectedFormatId = null;

    const thumb = document.getElementById('result-thumbnail');
    if (info.thumbnail) {
      thumb.src = info.thumbnail;
      thumb.style.display = '';
      thumb.onerror = () => { thumb.style.display = 'none'; };
    } else {
      thumb.style.display = 'none';
    }

    const dur = document.getElementById('result-duration');
    dur.textContent = info.duration ? formatDuration(info.duration) : '';
    dur.style.display = info.duration ? '' : 'none';

    const platformBadge = document.getElementById('result-platform');
    const pConfig = getPlatformConfig(info.platform);
    platformBadge.textContent = pConfig.name;
    platformBadge.style.background = pConfig.bg;
    platformBadge.style.color = pConfig.color;
    platformBadge.style.border = `1px solid ${pConfig.color}40`;

    document.getElementById('result-title').textContent = info.title || 'Untitled Video';
    document.getElementById('result-uploader').textContent = info.uploader || 'Unknown';
    document.getElementById('result-view-count').textContent = formatNumber(info.view_count);

    // Format options
    const formatsContainer = document.getElementById('result-formats');
    formatsContainer.innerHTML = '';
    if (info.formats && info.formats.length > 0) {
      const seen = new Set();
      info.formats.filter(f => {
        const key = f.resolution || f.format_id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 6).forEach((f, i) => {
        const opt = document.createElement('button');
        opt.className = 'format-option' + (i === 0 ? ' active' : '');
        let label = f.resolution || f.format_note || f.ext || 'Auto';
        if (f.filesize) label += ` (${formatFileSize(f.filesize)})`;
        opt.textContent = label;
        opt.addEventListener('click', () => {
          formatsContainer.querySelectorAll('.format-option').forEach(el => el.classList.remove('active'));
          opt.classList.add('active');
          selectedFormatId = f.format_id;
        });
        formatsContainer.appendChild(opt);
        if (i === 0) selectedFormatId = f.format_id;
      });
    }

    // Reset states
    downloadActionBtn.disabled = false;
    framesActionBtn.disabled = info.is_photo || false;
    framesActionBtn.style.opacity = info.is_photo ? '0.4' : '';
    downloadProgress.style.display = 'none';
    progressFill.style.width = '0%';

    hideLoading();
    resultContainer.style.display = 'block';
    framesContainer.style.display = 'none';
    resultContainer.querySelector('.result-card').classList.remove('success-bounce');
    void resultContainer.querySelector('.result-card').offsetHeight;
    resultContainer.querySelector('.result-card').classList.add('success-bounce');

    setTimeout(() => {
      resultContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }

  // ============================
  // API: Fetch Video Info
  // ============================
  async function fetchVideoInfo(url) {
    hideError();
    showLoading('Đang phân tích video...', 'Vui lòng chờ trong giây lát');
    setButtonLoading(true);

    try {
      const resp = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Không thể lấy thông tin video.');
      showResult(data);
    } catch (err) {
      hideLoading();
      showError(err.message || 'Đã xảy ra lỗi.');
    } finally {
      setButtonLoading(false);
    }
  }

  // ============================
  // API: Download Video
  // ============================
  async function downloadVideo() {
    if (!currentVideoInfo) return;

    downloadActionBtn.disabled = true;
    framesActionBtn.disabled = true;
    audioActionBtn.disabled = true;
    downloadProgress.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = 'Đang tải video...';

    let progress = 0;
    const interval = setInterval(() => {
      progress += Math.random() * 8;
      if (progress > 90) progress = 90;
      progressFill.style.width = progress + '%';
    }, 500);

    try {
      const resp = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: currentVideoInfo.webpage_url,
          format_id: selectedFormatId,
          title: currentVideoInfo.title,
        }),
      });
      const data = await resp.json();
      clearInterval(interval);
      if (!resp.ok) throw new Error(data.error || 'Tải video thất bại.');

      progressFill.style.width = '100%';
      progressText.textContent = 'Hoàn tất! Đang tải xuống...';

      setTimeout(() => {
        const a = document.createElement('a');
        a.href = data.download_url;
        a.download = data.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => {
          progressText.textContent = '✅ Tải xuống thành công!';
          downloadActionBtn.disabled = false;
          framesActionBtn.disabled = currentVideoInfo?.is_photo || false;
          audioActionBtn.disabled = false;
        }, 1000);
      }, 500);
    } catch (err) {
      clearInterval(interval);
      downloadProgress.style.display = 'none';
      downloadActionBtn.disabled = false;
      framesActionBtn.disabled = currentVideoInfo?.is_photo || false;
      audioActionBtn.disabled = false;
      showError(err.message);
    }
  }

  // ============================
  // API: Extract Audio (MP3)
  // ============================
  async function extractAudio() {
    if (!currentVideoInfo) return;

    downloadActionBtn.disabled = true;
    framesActionBtn.disabled = true;
    audioActionBtn.disabled = true;
    downloadProgress.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = '🎵 Đang tách audio...';

    let progress = 0;
    const interval = setInterval(() => {
      progress += Math.random() * 8;
      if (progress > 90) progress = 90;
      progressFill.style.width = progress + '%';
    }, 500);

    try {
      const resp = await fetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: currentVideoInfo.webpage_url,
          title: currentVideoInfo.title,
        }),
      });
      const data = await resp.json();
      clearInterval(interval);
      if (!resp.ok) throw new Error(data.error || 'Tách audio thất bại.');

      progressFill.style.width = '100%';
      progressText.textContent = 'Hoàn tất! Đang tải MP3...';

      setTimeout(() => {
        const a = document.createElement('a');
        a.href = data.download_url;
        a.download = data.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => {
          progressText.textContent = '✅ Tải MP3 thành công!';
          downloadActionBtn.disabled = false;
          framesActionBtn.disabled = currentVideoInfo?.is_photo || false;
          audioActionBtn.disabled = false;
        }, 1000);
      }, 500);
    } catch (err) {
      clearInterval(interval);
      downloadProgress.style.display = 'none';
      downloadActionBtn.disabled = false;
      framesActionBtn.disabled = currentVideoInfo?.is_photo || false;
      audioActionBtn.disabled = false;
      showError(err.message);
    }
  }

  // ============================
  // API: Extract Frames
  // ============================
  async function extractFrames() {
    if (!currentVideoInfo || currentVideoInfo.is_photo) return;

    showLoading('📸 Đang trích xuất khung hình...', 'Tải video và tách ảnh, có thể mất 1-2 phút');
    resultContainer.style.display = 'none';

    try {
      const resp = await fetch('/api/frames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: currentVideoInfo.webpage_url,
          format_id: selectedFormatId,
          title: currentVideoInfo.title,
          fps: 1,
          max_frames: 30,
        }),
      });
      const data = await resp.json();
      hideLoading();
      if (!resp.ok) throw new Error(data.error || 'Trích xuất khung hình thất bại.');

      currentFrames = data.frames;
      currentFrameId = data.frame_id;
      framesGrid.innerHTML = '';

      data.frames.forEach((frame, i) => {
        const item = document.createElement('div');
        item.className = 'frame-item';
        item.innerHTML = `
          <img src="${frame.url}" alt="Frame ${i+1}" loading="lazy">
          <span class="frame-label">#${i+1}</span>
        `;
        item.addEventListener('click', () => {
          const a = document.createElement('a');
          a.href = frame.url;
          a.download = `frame_${i+1}.jpg`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        });
        framesGrid.appendChild(item);
      });

      resultContainer.style.display = 'block';
      framesContainer.style.display = 'block';
      framesContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      hideLoading();
      resultContainer.style.display = 'block';
      showError(err.message);
    }
  }

  // ============================
  // Event Listeners
  // ============================

  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { urlInput.value = text.trim(); urlInput.focus(); }
    } catch (e) { urlInput.focus(); }
  });

  downloadBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) { showError('Vui lòng nhập link video.'); urlInput.focus(); return; }
    if (!detectPlatform(url)) { showError('Link không hợp lệ.'); return; }
    fetchVideoInfo(url);
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') downloadBtn.click();
  });

  resultClose.addEventListener('click', () => {
    resultContainer.style.display = 'none';
    framesContainer.style.display = 'none';
    currentVideoInfo = null;
  });

  downloadActionBtn.addEventListener('click', downloadVideo);
  framesActionBtn.addEventListener('click', extractFrames);
  audioActionBtn.addEventListener('click', extractAudio);

  framesClose.addEventListener('click', () => { framesContainer.style.display = 'none'; });

  // Download all frames as ZIP
  framesDownloadAll.addEventListener('click', () => {
    if (!currentFrameId) return;
    const a = document.createElement('a');
    a.href = `/api/frames-zip/${currentFrameId}`;
    a.download = `frames_${currentFrameId}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  // Auto detect paste platform
  urlInput.addEventListener('paste', () => {
    setTimeout(() => {
      const url = urlInput.value.trim();
      const platform = detectPlatform(url);
      if (platform) {
        document.querySelectorAll('.platform-badge').forEach(b => { b.style.transform = ''; b.style.borderColor = ''; });
        const badge = document.querySelector(`.platform-${platform}`);
        if (badge) {
          const c = getPlatformConfig(platform);
          badge.style.transform = 'translateY(-2px) scale(1.05)';
          badge.style.borderColor = c.color;
          badge.style.color = c.color;
          badge.style.background = c.bg;
          setTimeout(() => { badge.style.transform = ''; }, 2000);
        }
      }
    }, 100);
  });

  urlInput.addEventListener('focus', hideError);

  // Feature cards animation
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.feature-card').forEach((card, i) => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(30px)';
    card.style.transition = `all 0.5s ease ${i * 0.1}s`;
    observer.observe(card);
  });

})();
