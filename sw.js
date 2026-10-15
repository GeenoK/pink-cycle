// Service worker：让 app 可以离线打开，并在联网时自动拿到最新版本
var CACHE = 'pt-shell-v1';
var SHELL = ['./', './index.html', './style.css', './app.js', './config.js',
             './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function store(req, res) {
  if (res && res.ok) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.origin === location.origin) {
    // 自己的文件：优先联网取最新，断网时用缓存
    e.respondWith(
      fetch(req).then(function (res) { return store(req, res); })
        .catch(function () { return caches.match(req).then(function (r) { return r || caches.match('./index.html'); }); })
    );
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    // 登录组件（supabase-js）：缓存优先
    e.respondWith(
      caches.match(req).then(function (r) { return r || fetch(req).then(function (res) { return store(req, res); }); })
    );
  }
  // 其他请求（包括 Supabase 的数据接口）不拦截，直接走网络
});
