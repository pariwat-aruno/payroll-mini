/**
 * photo-upload.js — Camera/library capture + client-side compress + upload to Drive.
 *
 * Public API:
 *   PhotoUpload.attachUploader({
 *     buttonEl,        // HTMLElement: clicking it opens the picker
 *     fileInputEl,     // <input type=file accept="image/*" capture="environment">
 *     previewEl,       // <img>: shown after pick
 *     statusEl,        // <p>: status text
 *     getIdToken,      // () => string
 *     onUploaded,      // ({ url, id, filename }) => void
 *   })
 *
 * The function wires events; user only needs to provide the elements and
 * hook the resulting URL into their own form state via onUploaded.
 */
(function () {
  const MAX_DIMENSION = 1600;
  const JPEG_QUALITY  = 0.85;

  function _readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve(r.result);
      r.onerror = () => reject(new Error('read_failed'));
      r.readAsDataURL(file);
    });
  }

  function _loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('decode_failed'));
      img.src = dataUrl;
    });
  }

  // Resize + JPEG-encode to keep upload payload small and fast.
  async function _compress(file) {
    const dataUrl = await _readAsDataURL(file);
    const img = await _loadImage(dataUrl);
    const ratio = Math.min(MAX_DIMENSION / img.width, MAX_DIMENSION / img.height, 1);
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(img.width  * ratio);
    canvas.height = Math.round(img.height * ratio);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const compressedDataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    return {
      previewDataUrl: compressedDataUrl,
      mime: 'image/jpeg',
      base64: compressedDataUrl.split(',')[1],
      filename: file.name.replace(/\.[^.]+$/, '') + '.jpg',
    };
  }

  function attachUploader(opts) {
    const { buttonEl, fileInputEl, previewEl, statusEl, getIdToken, onUploaded } = opts;

    buttonEl.addEventListener('click', () => fileInputEl.click());

    fileInputEl.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      _setStatus(statusEl, 'กำลังย่อรูป...', 'info');
      buttonEl.disabled = true;
      try {
        const { previewDataUrl, mime, base64, filename } = await _compress(file);
        if (previewEl) {
          previewEl.src = previewDataUrl;
          previewEl.classList.remove('hidden');
        }

        _setStatus(statusEl, 'กำลังอัปโหลด...', 'info');
        const result = await window.PayrollApi.apiUploadEvidence(getIdToken(), {
          filename,
          mime_type: mime,
          data_base64: base64,
        });
        _setStatus(statusEl, 'อัปโหลดสำเร็จ ✓', 'success');
        if (onUploaded) onUploaded(result);
      } catch (err) {
        const msg = (err && err.message) || String(err);
        _setStatus(statusEl, 'อัปโหลดไม่สำเร็จ: ' + msg, 'error');
      } finally {
        buttonEl.disabled = false;
        // Reset input so picking the same file again still triggers change
        fileInputEl.value = '';
      }
    });
  }

  function _setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = 'text-xs mt-1 ' +
      (kind === 'error'   ? 'text-red-600'
       : kind === 'success' ? 'text-emerald-600'
       : 'text-slate-500');
  }

  if (typeof window !== 'undefined') {
    window.PhotoUpload = { attachUploader };
  }
})();
