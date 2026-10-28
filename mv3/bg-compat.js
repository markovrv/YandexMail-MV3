'use strict';

// Runs first in offscreen.html, before the original background scripts.
//
// An offscreen document only has chrome.runtime. The original background code expects the whole
// MV2 chrome.* surface, so this file replaces window.chrome with a shim: calls on the other
// namespaces are executed by the service worker (mv3/sw.js) over a long-lived port, and browser
// events are forwarded back the same way.

(function () {
  var realChrome = window.chrome;
  var realRuntime = realChrome.runtime;
  var PORT_NAME = 'ya-bg';
  var HEARTBEAT_MS = 20000;

  // Same list as STATIC_EVENTS in sw.js: the worker always forwards these, no subscription needed.
  var STATIC_EVENTS = {
    'action.onClicked': 1,
    'notifications.onClicked': 1,
    'notifications.onClosed': 1,
    'notifications.onButtonClicked': 1,
    'contextMenus.onClicked': 1
  };
  var NAMESPACES = [
    'tabs', 'windows', 'cookies', 'management', 'notifications', 'contextMenus', 'history',
    'bookmarks', 'webNavigation', 'webRequest', 'permissions', 'browsingData', 'topSites', 'idle'
  ];

  var port = null;
  var seq = 0;
  var reconnectDelay = 200;
  var pending = Object.create(null);   // call id -> callback
  var lastError;

  // ---------- port ----------

  function connect() {
    port = realRuntime.connect({ name: PORT_NAME });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(function () {
      void realRuntime.lastError;
      port = null;
      Object.keys(pending).forEach(function (id) {
        var cb = pending[id];
        delete pending[id];
        invoke(cb, undefined, 'Extension service worker disconnected');
      });
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    });
    reconnectDelay = 200;
    Object.keys(eventSubs).forEach(function (key) {
      var s = eventSubs[key];
      if (s.listeners.length) port.postMessage({ t: 'sub', key: key, path: s.path, extra: s.extra });
    });
    port.postMessage({ t: 'ready' });
  }

  function send(msg) {
    if (!port) connect();
    try {
      port.postMessage(msg);
    } catch (e) {
      port = null;
      connect();
      port.postMessage(msg);
    }
  }

  function invoke(cb, result, error) {
    if (typeof cb !== 'function') return;
    lastError = error ? { message: error } : undefined;
    try { cb(result); } finally { lastError = undefined; }
  }

  function onPortMessage(msg) {
    switch (msg.t) {
      case 'ret':
        var cb = pending[msg.id];
        delete pending[msg.id];
        invoke(cb, msg.result, msg.error);
        break;
      case 'ev':
        dispatch(msg.key, msg.args || []);
        break;
      case 'ext':
        dispatchExternal(msg);
        break;
    }
  }

  function call(path, args, cb) {
    var id = ++seq;
    if (cb) pending[id] = cb;
    // JSON transport turns trailing undefined into null, which the chrome.* signatures reject.
    while (args.length && args[args.length - 1] === undefined) args.pop();
    send({ t: 'call', id: id, path: path, args: args });
  }

  // Keeps the worker alive and notices if it was restarted (onDisconnect then reconnects).
  setInterval(function () { send({ t: 'ping' }); }, HEARTBEAT_MS);

  // ---------- events ----------

  var eventSubs = Object.create(null); // key -> { path, extra, listeners: [] }
  var eventRegs = Object.create(null); // path -> [{ fn, key }]

  function dispatch(key, args) {
    var staticPath = STATIC_EVENTS[key] ? key : null;
    if (staticPath) {
      (eventRegs[key] || []).slice().forEach(function (r) { fire(r.fn, args); });
      return;
    }
    var s = eventSubs[key];
    if (s) s.listeners.slice().forEach(function (fn) { fire(fn, args); });
  }

  function fire(fn, args) {
    try { fn.apply(null, args); } catch (e) { console.error(e); }
  }

  function makeEvent(path) {
    return {
      addListener: function (fn) {
        var extra = Array.prototype.slice.call(arguments, 1);
        if (path.indexOf('webRequest.') === 0 && extra[1]) {
          // Blocking webRequest is not available in MV3.
          extra[1] = extra[1].filter(function (s) { return s !== 'blocking' && s !== 'asyncBlocking'; });
        }
        var key = STATIC_EVENTS[path] ? path : path + (extra.length ? '|' + JSON.stringify(extra) : '');
        var regs = eventRegs[path] || (eventRegs[path] = []);
        regs.push({ fn: fn, key: key });
        if (STATIC_EVENTS[path]) return;
        var s = eventSubs[key] || (eventSubs[key] = { path: path, extra: extra, listeners: [] });
        s.listeners.push(fn);
        if (s.listeners.length === 1) send({ t: 'sub', key: key, path: path, extra: extra });
      },
      removeListener: function (fn) {
        var regs = eventRegs[path] || [];
        for (var i = regs.length - 1; i >= 0; i--) {
          if (regs[i].fn !== fn) continue;
          var key = regs[i].key;
          regs.splice(i, 1);
          var s = eventSubs[key];
          if (!s) continue;
          var j = s.listeners.indexOf(fn);
          if (j >= 0) s.listeners.splice(j, 1);
          if (!s.listeners.length) {
            delete eventSubs[key];
            send({ t: 'unsub', key: key });
          }
        }
      },
      hasListener: function (fn) {
        return (eventRegs[path] || []).some(function (r) { return r.fn === fn; });
      },
      hasListeners: function () {
        return (eventRegs[path] || []).length > 0;
      }
    };
  }

  // runtime.onMessageExternal is delivered to the worker; the reply goes back through the port.
  var externalListeners = [];
  var externalEvent = {
    addListener: function (fn) {
      externalListeners.push(fn);
      if (externalListeners.length === 1) {
        eventSubs['runtime.onMessageExternal'] = { path: 'runtime.onMessageExternal', extra: [], listeners: [fn] };
        send({ t: 'sub', key: 'runtime.onMessageExternal', path: 'runtime.onMessageExternal', extra: [] });
      }
    },
    removeListener: function (fn) {
      var i = externalListeners.indexOf(fn);
      if (i >= 0) externalListeners.splice(i, 1);
      if (!externalListeners.length && eventSubs['runtime.onMessageExternal']) {
        delete eventSubs['runtime.onMessageExternal'];
        send({ t: 'unsub', key: 'runtime.onMessageExternal' });
      }
    },
    hasListener: function (fn) { return externalListeners.indexOf(fn) >= 0; },
    hasListeners: function () { return externalListeners.length > 0; }
  };

  function dispatchExternal(msg) {
    var answered = false;
    var async = false;
    function sendResponse(response) {
      if (answered) return;
      answered = true;
      send({ t: 'extresp', id: msg.id, response: response });
    }
    externalListeners.slice().forEach(function (fn) {
      try { if (fn(msg.message, msg.sender, sendResponse) === true) async = true; } catch (e) { console.error(e); }
    });
    if (!async && !answered) {
      answered = true;
      send({ t: 'extresp', id: msg.id, none: true });
    }
  }

  // ---------- namespaces ----------

  var CONSTANTS = {
    windows: { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2 },
    tabs: { TAB_ID_NONE: -1 }
  };

  function makeNamespace(name, apiName, overrides) {
    return new Proxy({}, {
      get: function (_, prop) {
        if (typeof prop !== 'string') return undefined;
        if (overrides && overrides[prop]) return overrides[prop];
        if (CONSTANTS[name] && prop in CONSTANTS[name]) return CONSTANTS[name][prop];
        if (/^on[A-Z]/.test(prop)) return namespaceEvent(apiName, prop);
        return function () {
          var args = Array.prototype.slice.call(arguments);
          var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
          call(apiName + '.' + prop, args, cb);
        };
      }
    });
  }

  var eventObjects = Object.create(null);
  function namespaceEvent(apiName, prop) {
    var path = apiName + '.' + prop;
    return eventObjects[path] || (eventObjects[path] = makeEvent(path));
  }

  // contextMenus.create({ onclick }) is gone in MV3: route clicks through onClicked by item id.
  var menuHandlers = {};
  var menuWired = false;
  var contextMenus = makeNamespace('contextMenus', 'contextMenus', {
    create: function (props, cb) {
      props = Object.assign({}, props);
      if (typeof props.onclick === 'function') {
        menuHandlers[props.id] = props.onclick;
        if (!menuWired) {
          menuWired = true;
          namespaceEvent('contextMenus', 'onClicked').addListener(function (info, tab) {
            var h = menuHandlers[info.menuItemId];
            if (h) h(info, tab);
          });
        }
      }
      delete props.onclick;
      call('contextMenus.create', [props], cb);
      return props.id; // the original code stores the returned id
    },
    remove: function (id, cb) {
      delete menuHandlers[id];
      call('contextMenus.remove', [id], cb);
    },
    removeAll: function (cb) {
      menuHandlers = {};
      call('contextMenus.removeAll', [], cb);
    }
  });

  // ---------- manifest and i18n (both synchronous in the original code) ----------

  function readLocalJson(path) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', realRuntime.getURL(path), false);
      x.send();
      return JSON.parse(x.responseText);
    } catch (e) {
      return null;
    }
  }

  var AVAILABLE_LOCALES = ['en', 'ru', 'tr', 'uk']; // folders under _locales/
  var messages = null;
  function loadMessages() {
    if (messages) return messages;
    var raw = readLocalJson('manifest.json') || {};
    var lang = (navigator.language || '').toLowerCase().split('-')[0];
    var chosen = AVAILABLE_LOCALES.indexOf(lang) >= 0 ? lang : raw.default_locale || 'ru';
    return (messages = readLocalJson('_locales/' + chosen + '/messages.json') || {});
  }

  function getMessage(name, subs) {
    var m = loadMessages()[name];
    if (!m) return '';
    subs = subs == null ? [] : [].concat(subs);
    return String(m.message).replace(/\$(\d)/g, function (_, n) { return subs[n - 1] || ''; });
  }

  var manifest = null;
  function getManifest() {
    if (!manifest) {
      manifest = readLocalJson('manifest.json') || {};
      JSON.stringify(manifest, function (k, v) { // localise __MSG_x__ the way the browser does
        if (typeof v === 'string' && /^__MSG_\w+__$/.test(v)) this[k] = getMessage(v.slice(6, -2));
        return v;
      });
    }
    return manifest;
  }

  // ---------- assemble ----------

  var runtime = new Proxy(realRuntime, {
    get: function (target, prop) {
      switch (prop) {
        case 'lastError': return lastError;
        case 'getManifest': return getManifest;
        case 'onMessageExternal': return externalEvent;
        case 'setUninstallUrl':
          return function (url, cb) { call('runtime.setUninstallUrl', [url], cb); };
        case 'getBackgroundPage':
          return function (cb) { cb(window); };
      }
      var v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });

  var shim = Object.create(realChrome);
  shim.runtime = runtime;
  shim.i18n = { getMessage: getMessage, getUILanguage: function () { return navigator.language; } };
  shim.extension = {
    getURL: function (p) { return realRuntime.getURL(String(p || '').replace(/^\//, '')); },
    inIncognitoContext: false,
    getBackgroundPage: function () { return window; },
    getViews: function () { return [window]; },
    onMessage: realRuntime.onMessage,
    onMessageExternal: externalEvent
  };
  NAMESPACES.forEach(function (n) {
    shim[n] = n === 'contextMenus' ? contextMenus : makeNamespace(n, n);
  });
  shim.browserAction = makeNamespace('browserAction', 'action');

  Object.defineProperty(window, 'chrome', { value: shim, configurable: true, writable: true });

  connect();
})();
