/**
 * camera.js — live camera capture for selfie check-in.
 * Uses getUserMedia (live stream only) — never accepts a pre-existing image.
 * Returns base64 data-URL the backend stores as evidence on Drive.
 *
 * usage:
 *   const stream = await startCamera(videoEl, 'user');
 *   const dataUrl = captureFromVideoWithStamp(videoEl, 'check-in');
 *   stopCamera(stream);
 */

export async function startCamera(videoEl, facing = 'user') {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('เบราว์เซอร์ไม่รองรับกล้อง');
  }
  // One single permission prompt — loose constraints so LINE/iOS webviews accept it.
  // Don't request facingMode:'exact' (commonly returns "internal error").
  // Cap resolution so the captured JPEG stays under ~200KB even on 4K-capable phones.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 960 }, height: { ideal: 720 } },
    audio: false,
  });
  videoEl.srcObject = stream;
  videoEl.setAttribute('playsinline', '');
  videoEl.muted = true;
  await videoEl.play();
  return stream;
}

export function captureFromVideo(videoEl, maxWidth = 960, quality = 0.75) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) throw new Error('กล้องยังไม่พร้อม');
  const ratio = Math.min(maxWidth / w, 1);
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * Burn a 2-line caption + GMT+7 timestamp into the bottom of the photo.
 * Accepts either old positional args (label, brand) for backward compat,
 * or an options object: { slot, empCode, empName, brand }.
 */
export function captureFromVideoWithStamp(videoEl, labelOrOpts, brandOrMaxW, maxWidth, quality) {
  return _stampToCanvasFromVideo(videoEl, _normalizeStampOpts(labelOrOpts, brandOrMaxW), maxWidth, quality);
}

/** Same stamp format, but source is a File (system camera roll). */
export function captureFromFileWithStamp(file, labelOrOpts, brandOrMaxW, maxWidth, quality) {
  const opts = _normalizeStampOpts(labelOrOpts, brandOrMaxW);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่ได้'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('โหลดรูปไม่ได้'));
      img.onload = () => {
        try { resolve(_stampToCanvasFromImage(img, opts, maxWidth, quality)); }
        catch (e) { reject(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function _normalizeStampOpts(a, b) {
  if (a && typeof a === 'object') return a;
  // Legacy positional form: (label, brand)
  return { slot: a || '', brand: typeof b === 'string' ? b : '' };
}

function _stampToCanvasFromVideo(videoEl, opts, maxWidth = 960, quality = 0.75) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) throw new Error('กล้องยังไม่พร้อม');
  const { canvas, ctx } = _drawScaled(videoEl, w, h, maxWidth);
  _drawStamp(ctx, canvas, opts);
  return canvas.toDataURL('image/jpeg', quality);
}

function _stampToCanvasFromImage(img, opts, maxWidth = 960, quality = 0.75) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('รูปไม่ถูกต้อง');
  const { canvas, ctx } = _drawScaled(img, w, h, maxWidth);
  _drawStamp(ctx, canvas, opts);
  return canvas.toDataURL('image/jpeg', quality);
}

function _drawScaled(source, w, h, maxWidth) {
  const ratio = Math.min(maxWidth / w, 1);
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

function _drawStamp(ctx, canvas, opts) {
  // Format: GMT+7  DD-MM-YYYY HH:mm
  const now = new Date();
  const fmt = { timeZone: 'Asia/Bangkok', hour12: false };
  const dd = now.toLocaleDateString('en-GB', { ...fmt, day: '2-digit' });
  const mm = now.toLocaleDateString('en-GB', { ...fmt, month: '2-digit' });
  const yy = now.toLocaleDateString('en-GB', { ...fmt, year: 'numeric' });
  const hh = now.toLocaleTimeString('en-GB',  { ...fmt, hour: '2-digit', minute: '2-digit' });
  const dateTime = `${dd}-${mm}-${yy} ${hh}`;

  const primary   = [opts.slot, dateTime].filter(Boolean).join('  •  ');
  const secondary = [opts.empCode, opts.empName].filter(Boolean).join(' · ')
                 || opts.brand || '';

  const fontSize = Math.max(16, Math.round(canvas.width / 32));
  const padX = Math.round(canvas.width * 0.025);
  const padY = Math.round(fontSize * 0.55);
  const lineH = fontSize + padY;
  const lines = secondary ? 2 : 1;
  const bandH = lineH * lines + padY;

  ctx.fillStyle = 'rgba(17, 24, 39, 0.72)';
  ctx.fillRect(0, canvas.height - bandH, canvas.width, bandH);

  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.font = 'bold ' + fontSize + 'px -apple-system, "Helvetica Neue", "Sukhumvit Set", "Prompt", sans-serif';
  ctx.fillText(primary, padX, canvas.height - bandH + padY * 0.8);

  if (secondary) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = Math.round(fontSize * 0.78) + 'px -apple-system, "Helvetica Neue", "Sukhumvit Set", "Prompt", sans-serif';
    ctx.fillText(secondary, padX, canvas.height - lineH + padY * 0.4);
  }
}

export function stopCamera(stream) {
  if (!stream) return;
  stream.getTracks().forEach(function (t) { t.stop(); });
}

/**
 * Load a File (camera or gallery pick), downscale to maxWidth and re-encode
 * as JPEG. No stamp overlay — used for documents like ID cards where we
 * just want a smaller version of whatever the user supplied.
 */
export function compressFile(file, maxWidth = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่ได้'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('โหลดรูปไม่ได้'));
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) return reject(new Error('รูปไม่ถูกต้อง'));
        const ratio = Math.min(maxWidth / w, 1);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(w * ratio);
        canvas.height = Math.round(h * ratio);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

