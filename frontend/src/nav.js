/**
 * nav.js — Auto-injects a "← กลับ" button into the page header.
 *
 * Pages just need: <script src="nav.js"></script>
 * No-ops on index.html (which IS the home page).
 *
 * Click → navigates to index.html, preserving query string so LIFF
 * params (?backend=, ?liffId=, etc.) survive the trip back.
 */
(function () {
  // Detect "home" page by filename. Treat empty path or root as home too.
  const path = window.location.pathname || '';
  const isHome = /(^|\/)(index\.html?|)$/.test(path) ||
                 path === '' ||
                 path === '/';
  if (isHome) return;

  function inject() {
    const header = document.querySelector('header');
    if (!header) return;
    if (getComputedStyle(header).position === 'static') {
      header.style.position = 'relative';
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'กลับหน้าหลัก');
    btn.className = 'absolute top-3 left-3 text-white/85 hover:text-white ' +
                    'bg-white/10 hover:bg-white/20 active:bg-white/25 ' +
                    'px-3 py-1.5 rounded-lg text-sm font-medium ' +
                    'flex items-center gap-1 transition';
    btn.innerHTML =
      '<span class="text-lg leading-none">‹</span>' +
      '<span>กลับ</span>';
    btn.addEventListener('click', () => {
      window.location.href = 'index.html' + window.location.search;
    });
    header.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
