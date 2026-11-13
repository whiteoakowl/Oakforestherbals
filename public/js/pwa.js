/* Installable app: registers the service worker and wires up any [data-install-app] button.
   Android/Chrome: the button triggers the browser's install prompt.
   iPhone/iPad Safari: Apple has no install prompt, so the button shows "Share → Add to Home Screen" steps.
   The button stays hidden when the app is already installed or the browser can't install it. */
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
    });
  }

  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var ua = window.navigator.userAgent;
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var deferredPrompt = null;

  function buttons() { return document.querySelectorAll('[data-install-app]'); }
  function show(on) { buttons().forEach(function (b) { b.hidden = !on; }); }

  function iosDialog() {
    var dialog = document.getElementById('install-ios-dialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'install-ios-dialog';
    dialog.setAttribute('aria-labelledby', 'install-ios-title');
    dialog.style.cssText = 'border:0;border-radius:16px;padding:20px 22px;max-width:340px;width:calc(100vw - 32px);font:inherit;line-height:1.5;color:#1f2a22;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.3)';
    var shareIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
    dialog.innerHTML =
      '<h2 id="install-ios-title" style="margin:0 0 10px;font-size:1.15rem">Add this app to your Home Screen</h2>' +
      '<ol style="margin:0 0 16px;padding-left:1.2em">' +
      '<li>Tap the <strong>Share</strong> button ' + shareIcon + ' in Safari’s toolbar.</li>' +
      '<li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>' +
      '<li>Tap <strong>Add</strong>.</li>' +
      '</ol>' +
      '<p style="margin:0 0 16px;font-size:.9em;opacity:.75">On iPhone this works in Safari. In another browser, open this page in Safari first.</p>' +
      '<form method="dialog" style="text-align:right;margin:0"><button style="font:inherit;font-weight:600;border:0;border-radius:999px;padding:8px 18px;background:#1f2a22;color:#fff;cursor:pointer">Got it</button></form>';
    document.body.appendChild(dialog);
    return dialog;
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    show(true);
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    show(false);
  });

  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('[data-install-app]');
    if (!button) return;
    event.preventDefault();
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () { deferredPrompt = null; show(false); });
    } else if (isIOS) {
      var dialog = iosDialog();
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    }
  });

  function init() { if (!standalone && isIOS) show(true); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
