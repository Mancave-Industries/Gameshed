/* Game Shed back button. Shown only when a game is opened from the installed Game Shed app,
   where there is no browser back button. Normal web visitors never see it. */
(function () {
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true || /[?&]gsnav=1/.test(location.search);
  if (!standalone || /^\/Gameshed\//i.test(location.pathname)) return;
  var me = document.currentScript, pos = (me && me.getAttribute('data-pos')) || 'bottom-left';
  var top = pos.indexOf('top') === 0, right = /right$/.test(pos);
  function add() {
    if (document.getElementById('gs-back')) return;
    var a = document.createElement('a');
    a.id = 'gs-back';
    a.href = '/Gameshed/';
    a.setAttribute('aria-label', 'Back to Game Shed');
    a.innerHTML = '<span aria-hidden="true">&#8249;</span> Game Shed';
    a.style.cssText = [
      'position:fixed', 'z-index:2147483647',
      right ? 'right:calc(8px + env(safe-area-inset-right, 0px))' : 'left:calc(8px + env(safe-area-inset-left, 0px))',
      top ? 'top:calc(8px + env(safe-area-inset-top, 0px))' : 'bottom:calc(10px + env(safe-area-inset-bottom, 0px))',
      'display:inline-flex', 'align-items:center', 'gap:4px',
      'padding:6px 12px 6px 9px', 'border-radius:999px',
      'background:rgba(18,17,18,.82)', 'color:#d6d1cb',
      'border:1.5px solid #d23a2f', 'box-shadow:0 4px 14px rgba(0,0,0,.45)',
      'font:600 13px/1 system-ui,-apple-system,sans-serif', 'text-decoration:none',
      '-webkit-backdrop-filter:blur(6px)', 'backdrop-filter:blur(6px)', '-webkit-tap-highlight-color:transparent'
    ].join(';');
    a.firstChild.style.cssText = 'font-size:20px;line-height:0;margin-top:-2px;color:#d23a2f';
    document.body.appendChild(a);
  }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
