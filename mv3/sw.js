'use strict';

// Manifest V3 host for the legacy background page.
//
// The original extension kept all its logic in a persistent background page that touched the DOM,
// XMLHttpRequest, localStorage and Audio. None of that exists in a service worker, so that code now
// runs unchanged inside an offscreen document (offscreen.html). Offscreen documents only get
// chrome.runtime, so this worker executes every other chrome.* call on the document's behalf over a
// long-lived port and forwards browser events back to it (see mv3/bg-compat.js for the other end).

var OFFSCREEN_PATH = 'offscreen.html';
var PORT_NAME = 'ya-bg';

// Namespaces the offscreen document may call through this worker.
var CALLABLE = {
  action: 1, tabs: 1, windows: 1, cookies: 1, management: 1, notifications: 1, contextMenus: 1,
  history: 1, bookmarks: 1, webNavigation: 1, webRequest: 1, permissions: 1, browsingData: 1,
  topSites: 1, idle: 1, runtime: 1
};
// runtime.* functions that may be proxied (everything else on runtime stays local to the document).
var CALLABLE_RUNTIME = { setUninstallUrl: 1 };

// Events registered synchronously at worker start, so the browser can wake the worker for them.
// They are forwarded to the offscreen document whether or not it has subscribed yet.
var STATIC_EVENTS = {
  'action.onClicked': chrome.action.onClicked,
  'notifications.onClicked': chrome.notifications.onClicked,
  'notifications.onClosed': chrome.notifications.onClosed,
  'notifications.onButtonClicked': chrome.notifications.onButtonClicked,
  'contextMenus.onClicked': chrome.contextMenus.onClicked
};
var QUEUE_TTL = 30000;
var QUEUE_MAX = 50;

var ports = new Set();
var queue = [];
var creating = null;

// ---------- offscreen document ----------

function ensureOffscreen() {
  if (creating) return creating;
  creating = (async function () {
    try {
      var contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts.length) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['LOCAL_STORAGE', 'DOM_PARSER', 'IFRAME_SCRIPTING'],
        justification: 'Runs the extension background logic: polling mail, notifications and sound.'
      });
    } catch (e) {
      if (!/single offscreen/i.test(String(e && e.message))) console.error('offscreen create failed', e);
    }
  })();
  creating.then(function () { creating = null; }, function () { creating = null; });
  return creating;
}

chrome.runtime.onInstalled.addListener(ensureOffscreen);
chrome.runtime.onStartup.addListener(ensureOffscreen);
ensureOffscreen();

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.__yaMV3 === 'ensure') {
    ensureOffscreen().then(function () { sendResponse(true); });
    return true;
  }
});

// ---------- static events ----------

function broadcast(key, args) {
  if (ports.size) {
    ports.forEach(function (p) { post(p, { t: 'ev', key: key, args: args }); });
    return;
  }
  queue.push({ key: key, args: args, ts: Date.now() });
  if (queue.length > QUEUE_MAX) queue.shift();
  ensureOffscreen();
}

Object.keys(STATIC_EVENTS).forEach(function (key) {
  STATIC_EVENTS[key].addListener(function () {
    broadcast(key, Array.prototype.slice.call(arguments));
  });
});

function flushQueue(port) {
  var now = Date.now();
  var items = queue;
  queue = [];
  items.forEach(function (it) {
    if (now - it.ts < QUEUE_TTL) post(port, { t: 'ev', key: it.key, args: it.args });
  });
}

// ---------- RPC port ----------

function post(port, msg) {
  try { port.postMessage(msg); } catch (e) { /* port is gone */ }
}

function resolveTarget(path) {
  var parts = path.split('.');
  if (!CALLABLE[parts[0]]) throw new Error('Namespace not allowed: ' + parts[0]);
  if (parts[0] === 'runtime' && !CALLABLE_RUNTIME[parts[1]]) throw new Error('Not allowed: ' + path);
  var obj = chrome;
  for (var i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]];
    if (!obj) throw new Error('No such API: ' + path);
  }
  var name = parts[parts.length - 1];
  if (obj[name] === undefined) throw new Error('No such API: ' + path);
  return { obj: obj, name: name };
}

function handleCall(port, msg) {
  var done = false;
  function reply(result) {
    if (done) return;
    done = true;
    var err = chrome.runtime.lastError;
    post(port, { t: 'ret', id: msg.id, result: result, error: err ? err.message : undefined });
  }
  try {
    var target = resolveTarget(msg.path);
    target.obj[target.name].apply(target.obj, (msg.args || []).concat([reply]));
  } catch (e) {
    done = true;
    post(port, { t: 'ret', id: msg.id, error: String(e && e.message || e) });
  }
}

function onConnect(port) {
  // Only the offscreen document may drive this worker (content scripts can also call runtime.connect).
  if (port.name !== PORT_NAME || port.sender.tab || port.sender.url !== chrome.runtime.getURL(OFFSCREEN_PATH)) {
    port.disconnect();
    return;
  }
  ports.add(port);

  var subs = Object.create(null);       // key -> { event, listener }
  var extPending = Object.create(null); // id -> sendResponse for onMessageExternal

  function subscribe(msg) {
    if (subs[msg.key] || STATIC_EVENTS[msg.path]) return;
    var listener;
    var event;
    if (msg.path === 'runtime.onMessageExternal') {
      event = chrome.runtime.onMessageExternal;
      listener = function (message, sender, sendResponse) {
        var id = 'e' + Math.random().toString(36).slice(2);
        extPending[id] = sendResponse;
        post(port, { t: 'ext', id: id, message: message, sender: sender });
        return true;
      };
    } else {
      var t;
      try { t = resolveTarget(msg.path); } catch (e) { console.warn('subscribe failed', msg.path, e); return; }
      event = t.obj[t.name];
      listener = function () {
        post(port, { t: 'ev', key: msg.key, args: Array.prototype.slice.call(arguments) });
      };
    }
    try {
      event.addListener.apply(event, [listener].concat(msg.extra || []));
      subs[msg.key] = { event: event, listener: listener };
    } catch (e) {
      console.warn('addListener failed', msg.path, e);
    }
  }

  function unsubscribe(key) {
    var s = subs[key];
    if (!s) return;
    delete subs[key];
    try { s.event.removeListener(s.listener); } catch (e) { /* ignore */ }
  }

  port.onMessage.addListener(function (msg) {
    switch (msg.t) {
      case 'call': handleCall(port, msg); break;
      case 'sub': subscribe(msg); break;
      case 'unsub': unsubscribe(msg.key); break;
      case 'ping': post(port, { t: 'pong' }); break;
      case 'ready': flushQueue(port); break;
      case 'extresp':
        var send = extPending[msg.id];
        delete extPending[msg.id];
        if (send) { try { msg.none ? send() : send(msg.response); } catch (e) { /* sender is gone */ } }
        break;
    }
  });

  port.onDisconnect.addListener(function () {
    void chrome.runtime.lastError;
    ports.delete(port);
    Object.keys(subs).forEach(unsubscribe);
    // The document went away (closed by the browser or reloading): bring it back.
    ensureOffscreen();
  });
}

chrome.runtime.onConnect.addListener(onConnect);
