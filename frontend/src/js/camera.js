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
 * Burn label + Asia/Bangkok timestamp + optional brand line into the bottom of the photo.
 * Makes the capture tamper-resistant — you can't strip the metadata by re-saving.
 */
export function captureFromVideoWithStamp(videoEl, label, brand, maxWidth = 960, quality = 0.75) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) throw new Error('กล้องยังไม่พร้อม');
  const ratio = Math.min(maxWidth / w, 1);
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  const now = new Date();
  const opts = { timeZone: 'Asia/Bangkok', hour12: false };
  const dateStr = now.toLocaleDateString('en-CA', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeStr = now.toLocaleTimeString('en-GB',  { ...opts, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const stamp = (label ? label + '  •  ' : '') + dateStr + ' ' + timeStr;
  const brandText = brand || '';

  const fontSize = Math.max(16, Math.round(canvas.width / 32));
  const padX = Math.round(canvas.width * 0.025);
  const padY = Math.round(fontSize * 0.55);
  const lineH = fontSize + padY;
  const lines = brandText ? 2 : 1;
  const bandH = lineH * lines + padY;

  ctx.fillStyle = 'rgba(17, 24, 39, 0.72)';
  ctx.fillRect(0, canvas.height - bandH, canvas.width, bandH);

  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.font = 'bold ' + fontSize + 'px -apple-system, "Helvetica Neue", "Sukhumvit Set", "Prompt", sans-serif';
  ctx.fillText(stamp, padX, canvas.height - bandH + padY * 0.8);

  if (brandText) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = Math.round(fontSize * 0.7) + 'px -apple-system, "Helvetica Neue", "Sukhumvit Set", "Prompt", sans-serif';
    ctx.fillText(brandText, padX, canvas.height - lineH + padY * 0.4);
  }

  return canvas.toDataURL('image/jpeg', quality);
}

export function stopCamera(stream) {
  if (!stream) return;
  stream.getTracks().forEach(function (t) { t.stop(); });
}
