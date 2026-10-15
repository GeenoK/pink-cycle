// 经期记录 —— 页面逻辑
// 数据放在 Supabase 的 periods 表里；每个人只能读写自己的行（由数据库的行级安全保证）。
(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var configured = /^https:\/\//.test(cfg.SUPABASE_URL || '') && (cfg.SUPABASE_KEY || '').length > 20;

  var sb = null;          // Supabase 客户端
  var user = null;        // 当前登录的用户
  var records = [];       // [{id, start, end}]，start/end 是 'YYYY-MM-DD'，end 为 null 表示进行中
  var editingId = null, busy = false, undoFn = null, toastTimer = null;

  function $(id) { return document.getElementById(id); }

  /* ---------- 日期工具 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function toUTC(s) { var p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function diff(a, b) { return Math.round((toUTC(b) - toUTC(a)) / 864e5); }
  function addDays(s, n) { var d = new Date(toUTC(s) + n * 864e5); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function fmt(s) {
    var p = s.split('-'), y = +p[0];
    return (y === new Date().getFullYear() ? '' : y + '年') + (+p[1]) + '月' + (+p[2]) + '日';
  }
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /* ---------- 数据整理 ---------- */
  function sorted() { return records.slice().sort(function (a, b) { return a.start < b.start ? 1 : a.start > b.start ? -1 : 0; }); }
  function ongoing() { for (var i = 0; i < records.length; i++) { if (!records[i].end) return records[i]; } return null; }
  function avg(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : null; }
  function fromRow(r) { return { id: r.id, start: r.start_date, end: r.end_date || null }; }

  /* ---------- 本机缓存：只用来更快显示、断网时还能看 ---------- */
  function cacheKey() { return 'pt-cache-v1:' + (user ? user.id : ''); }
  function loadCache() {
    try {
      var raw = localStorage.getItem(cacheKey());
      if (raw) { var d = JSON.parse(raw); if (Array.isArray(d)) records = d.filter(function (r) { return r && r.id && DATE_RE.test(r.start); }); }
    } catch (e) {}
  }
  function saveCache() { try { localStorage.setItem(cacheKey(), JSON.stringify(records)); } catch (e) {} }

  /* ---------- 界面状态 ---------- */
  function showView(name) {
    $('viewSetup').hidden = name !== 'setup';
    $('viewAuth').hidden = name !== 'auth';
    $('viewMain').hidden = name !== 'main';
  }
  function setStatus(kind) {
    var el = $('sync');
    if (kind === 'ok') { el.textContent = '已同步到你的账号'; el.className = 'sync ok'; }
    else if (kind === 'loading') { el.textContent = '正在同步…'; el.className = 'sync'; }
    else { el.textContent = '离线：显示的是上次保存的记录，修改需要联网'; el.className = 'sync warn'; }
  }
  function toast(msg, undo) {
    undoFn = undo || null;
    $('toastMsg').textContent = msg;
    $('undoBtn').hidden = !undo;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').classList.remove('show'); undoFn = null; }, 6000);
  }
  function errText(e) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return '现在没有网络，修改没有保存。';
    if (e && e.code === '23505') return '已经有相同开始日期的记录，或已经有一条进行中的记录。';
    if (e && e.code === '23514') return '结束日期不能早于开始日期。';
    return '保存失败：' + (e && e.message ? e.message : '未知错误');
  }
  async function must(promise) {
    var r = await promise;
    if (r.error) throw r.error;
    return r;
  }

  /* ---------- 从数据库读取 ---------- */
  async function refresh() {
    if (!user) return;
    setStatus('loading');
    try {
      var r = await must(sb.from('periods').select('id,start_date,end_date').order('start_date', { ascending: false }));
      records = r.data.map(fromRow);
      saveCache(); render(); setStatus('ok');
    } catch (e) {
      setStatus('offline');
    }
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var list = sorted(), cur = ongoing(), today = todayStr();
    var btn = $('toggle'), status = $('status');

    if (cur) {
      btn.className = 'big active';
      btn.innerHTML = '<span class="main">结束经期</span><span class="sub">今天是第 ' + Math.max(diff(cur.start, today) + 1, 1) + ' 天</span>';
      status.textContent = fmt(cur.start) + ' 开始';
    } else {
      btn.className = 'big idle';
      btn.innerHTML = '<span class="main">开始经期</span><span class="sub">记为 ' + fmt(today) + '</span>';
      status.textContent = list.length ? '距上次开始已 ' + diff(list[0].start, today) + ' 天' : '还没有记录，点一下按钮开始';
    }

    var cycles = [], periods = [];
    for (var i = 0; i < list.length; i++) {
      if (i > 0) cycles.push(diff(list[i].start, list[i - 1].start));
      if (list[i].end) periods.push(diff(list[i].start, list[i].end) + 1);
    }
    var ac = avg(cycles.slice(0, 6)), ap = avg(periods.slice(0, 6));
    $('sCycle').textContent = ac === null ? '–' : Math.round(ac * 10) / 10;
    $('sPeriod').textContent = ap === null ? '–' : Math.round(ap * 10) / 10;
    $('sNext').textContent = ac === null ? '–' : fmt(addDays(list[0].start, Math.round(ac)));
    $('note').textContent = ac === null ? '至少记录两次经期开始后，才能算出周期长度。' : '平均值取最近 6 次；预计日期仅供参考。';

    var box = $('list');
    if (!list.length) { box.innerHTML = '<div class="empty">这里会显示每次经期的起止日期、经期长度和周期长度。</div>'; return; }
    var html = '<ul>';
    list.forEach(function (r, i) {
      var newer = i > 0 ? list[i - 1] : null;
      var range = fmt(r.start) + (r.end ? ' – ' + fmt(r.end) : '');
      var tag = r.end ? '' : '<span class="tag">进行中</span>';
      var meta = r.end ? '经期 ' + (diff(r.start, r.end) + 1) + ' 天' : '经期已 ' + Math.max(diff(r.start, today) + 1, 1) + ' 天';
      var right = newer
        ? '<b>' + diff(r.start, newer.start) + '</b> 天<small>周期长度</small>'
        : '<b>' + (diff(r.start, today) + 1) + '</b><small>当前周期第几天</small>';
      html += '<li><button class="row" data-id="' + r.id + '"><div><div class="dates">' + range + tag + '</div><div class="meta">' + meta +
              '</div></div><div class="len">' + right + '</div></button></li>';
    });
    box.innerHTML = html + '</ul>';
  }

  /* ---------- 大按钮：开始 / 结束 ---------- */
  async function onToggle() {
    if (busy || !user) return;
    busy = true;
    try {
      var cur = ongoing(), today = todayStr();
      if (cur) {
        var end = today < cur.start ? cur.start : today;
        await must(sb.from('periods').update({ end_date: end }).eq('id', cur.id));
        await refresh();
        toast('已记录经期结束', async function () { await must(sb.from('periods').update({ end_date: null }).eq('id', cur.id)); });
      } else {
        var r = await must(sb.from('periods').insert({ start_date: today }).select('id').single());
        await refresh();
        toast('已记录经期开始', async function () { await must(sb.from('periods').delete().eq('id', r.data.id)); });
      }
    } catch (e) { toast(errText(e)); }
    busy = false;
  }

  /* ---------- 编辑 / 补录 ---------- */
  function openEdit(id) {
    editingId = id;
    var r = id ? records.filter(function (x) { return x.id === id; })[0] : null;
    $('editTitle').textContent = r ? '编辑记录' : '补录一条';
    $('fStart').value = r ? r.start : '';
    $('fEnd').value = r && r.end ? r.end : '';
    $('delBtn').hidden = !r;
    $('editErr').textContent = '';
    $('editDlg').showModal();
  }
  async function onSave() {
    if (busy) return;
    var s = $('fStart').value, en = $('fEnd').value, err = $('editErr');
    if (!s) { err.textContent = '请选择开始日期。'; return; }
    if (en && en < s) { err.textContent = '结束日期不能早于开始日期。'; return; }
    if (!en) {
      var other = records.filter(function (x) { return !x.end && x.id !== editingId; })[0];
      if (other) { err.textContent = '已经有一条进行中的记录（' + fmt(other.start) + ' 开始）。请先给它填上结束日期。'; return; }
    }
    if (records.some(function (x) { return x.start === s && x.id !== editingId; })) { err.textContent = '这个开始日期已经有记录了。'; return; }

    busy = true;
    try {
      var payload = { start_date: s, end_date: en || null };
      if (editingId) {
        var old = records.filter(function (x) { return x.id === editingId; })[0], oldId = editingId;
        await must(sb.from('periods').update(payload).eq('id', oldId));
        toast('已保存', async function () { await must(sb.from('periods').update({ start_date: old.start, end_date: old.end }).eq('id', oldId)); });
      } else {
        var r = await must(sb.from('periods').insert(payload).select('id').single());
        toast('已保存', async function () { await must(sb.from('periods').delete().eq('id', r.data.id)); });
      }
      $('editDlg').close();
      await refresh();
    } catch (e) { err.textContent = errText(e); }
    busy = false;
  }
  async function onDelete() {
    if (busy || !editingId) return;
    busy = true;
    try {
      var old = records.filter(function (x) { return x.id === editingId; })[0];
      await must(sb.from('periods').delete().eq('id', editingId));
      $('editDlg').close();
      await refresh();
      toast('已删除这条记录', async function () { await must(sb.from('periods').insert({ start_date: old.start, end_date: old.end })); });
    } catch (e) { $('editErr').textContent = errText(e); }
    busy = false;
  }

  /* ---------- 更多：备份、导入、退出登录 ---------- */
  function openMore() {
    $('whoami').textContent = user && user.email ? '当前账号：' + user.email : '';
    $('backupText').value = JSON.stringify(sorted().map(function (r) { return { start: r.start, end: r.end }; }));
    $('backupErr').textContent = '';
    $('moreDlg').showModal();
  }
  function onCopy() {
    var ta = $('backupText'), ok = false;
    ta.select();
    try { if (navigator.clipboard) { navigator.clipboard.writeText(ta.value); ok = true; } } catch (e) {}
    if (!ok) { try { ok = document.execCommand('copy'); } catch (e) {} }
    $('backupErr').textContent = ok ? '已复制。' : '请手动长按全选并复制。';
  }
  async function onImport() {
    if (busy || !user) return;
    var err = $('backupErr'), d;
    try {
      d = JSON.parse($('backupText').value);
      if (!Array.isArray(d) || !d.length || !d.every(function (r) { return r && DATE_RE.test(r.start) && (r.end == null || DATE_RE.test(r.end)); })) throw new Error('bad');
    } catch (e) { err.textContent = '格式不对，请粘贴完整的备份文字（一个由 start / end 组成的列表）。'; return; }

    busy = true; err.textContent = '正在导入…';
    try {
      var rows = d.map(function (r) { return { user_id: user.id, start_date: r.start, end_date: r.end || null }; });
      await must(sb.from('periods').upsert(rows, { onConflict: 'user_id,start_date' }));
      $('moreDlg').close();
      await refresh();
      toast('已导入 ' + rows.length + ' 条记录');
    } catch (e) { err.textContent = errText(e); }
    busy = false;
  }
  async function onLogout() {
    try { localStorage.removeItem(cacheKey()); } catch (e) {}   // 退出时清掉本机缓存
    $('moreDlg').close();
    await sb.auth.signOut();
  }

  /* ---------- 登录 ---------- */
  async function onLogin(e) {
    e.preventDefault();
    var err = $('loginErr'), btn = $('loginBtn');
    err.textContent = ''; btn.disabled = true;
    try {
      var r = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
      if (r.error) err.textContent = navigator.onLine === false ? '现在没有网络。' : '登录失败：邮箱或密码不对。';
    } catch (x) { err.textContent = '登录失败，请检查网络后重试。'; }
    btn.disabled = false;
  }
  function handleSession(session) {
    if (session && session.user) {
      if (user && user.id === session.user.id) return;   // 同一个人，不用重复加载
      user = session.user;
      records = []; loadCache(); render(); showView('main'); refresh();
    } else {
      user = null; records = [];
      $('password').value = '';
      showView('auth');
    }
  }

  /* ---------- 启动 ---------- */
  function init() {
    if (!configured) {
      $('setupMsg').textContent = '还没有填写 config.js 里的 Supabase 项目地址和密钥。';
      showView('setup'); return;
    }
    if (!window.supabase) {
      $('setupMsg').textContent = '登录组件没有加载成功。请联网后刷新页面。';
      showView('setup'); return;
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

    $('loginForm').addEventListener('submit', onLogin);
    $('toggle').addEventListener('click', onToggle);
    $('list').addEventListener('click', function (e) { var b = e.target.closest('.row'); if (b) openEdit(b.getAttribute('data-id')); });
    $('addBtn').addEventListener('click', function () { openEdit(null); });
    $('cancelBtn').addEventListener('click', function () { $('editDlg').close(); });
    $('saveBtn').addEventListener('click', onSave);
    $('delBtn').addEventListener('click', onDelete);
    $('moreBtn').addEventListener('click', openMore);
    $('closeMore').addEventListener('click', function () { $('moreDlg').close(); });
    $('copyBtn').addEventListener('click', onCopy);
    $('importBtn').addEventListener('click', onImport);
    $('logoutBtn').addEventListener('click', onLogout);
    $('undoBtn').addEventListener('click', async function () {
      var fn = undoFn; undoFn = null; $('toast').classList.remove('show');
      if (!fn || busy) return;
      busy = true;
      try { await fn(); await refresh(); } catch (e) { toast(errText(e)); }
      busy = false;
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && user && !busy) refresh(); });

    // 登录状态变化时切换界面（回调里不直接调数据库，放到下一个时间片再处理）
    sb.auth.onAuthStateChange(function (event, session) { setTimeout(function () { handleSession(session); }, 0); });
    sb.auth.getSession().then(function (r) { handleSession(r.data.session); });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () {}); });
  }
  init();
})();
