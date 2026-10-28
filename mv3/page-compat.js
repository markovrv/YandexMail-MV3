'use strict';

// Loaded first in the popup (slice/index.html) and the options page.
// Restores the few MV2 APIs they rely on: chrome.extension.getURL, chrome.browserAction and
// chrome.runtime.getBackgroundPage. The "background page" is the offscreen document.

(function () {
  var c = window.chrome;
  if (!c) return;

  function define(obj, name, value) {
    try {
      Object.defineProperty(obj, name, { value: value, configurable: true, writable: true });
    } catch (e) {
      obj[name] = value;
    }
  }

  if (!c.extension) define(c, 'extension', {});
  if (!c.extension.getURL) define(c.extension, 'getURL', c.runtime.getURL.bind(c.runtime));
  if (!c.browserAction && c.action) define(c, 'browserAction', c.action);

  function findBackground() {
    var views = c.extension.getViews();
    for (var i = 0; i < views.length; i++) {
      if (views[i].__yaMailBg) return views[i];
    }
    return null;
  }

  define(c.runtime, 'getBackgroundPage', function (cb) {
    var started = Date.now();
    var asked = false;
    (function poll() {
      var bg = findBackground();
      if (bg) return cb(bg);
      if (!asked) {
        // The document may not exist yet (worker just started, or the browser closed it).
        asked = true;
        c.runtime.sendMessage({ __yaMV3: 'ensure' }, function () { void c.runtime.lastError; });
      }
      if (Date.now() - started > 20000) return cb(undefined);
      setTimeout(poll, 100);
    })();
  });
})();
