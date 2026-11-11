(function () {
  'use strict';

  /* ================= 工具 ================= */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const shuffle = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const ICON_SPK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>';

  const CUSTOM_CAT = 'custom';
  const CUSTOM_LABEL = '自建词表';

  let WORDS = [];
  let BY_EN = new Map();
  let CAT_KEYS = Object.keys(CATEGORIES);

  const groupKeyOf = w => w.cat + '.' + w.group;
  const groupLabel = w => (GROUPS[w.cat] || {})[w.group] || '';
  const allGroupKeys = () => CAT_KEYS.flatMap(c => Object.keys(GROUPS[c] || {}).map(g => c + '.' + g));
  const GROUP_COUNT = {};

  /* 内置词库 + 用户导入词表，合并成运行时词表 */
  function rebuildWords() {
    WORDS = RAW_WORDS.map(([en, ipa, zh, cat, group, note]) => ({
      en, ipa, zh, cat, group: group || '', note: note || ''
    }));

    const custom = state.customWords || [];
    if (custom.length) {
      CATEGORIES[CUSTOM_CAT] = CUSTOM_LABEL;
      GROUPS[CUSTOM_CAT] = {};
      custom.forEach(w => {
        if (!GROUPS[CUSTOM_CAT][w.group]) GROUPS[CUSTOM_CAT][w.group] = w.groupLabel || w.group;
        WORDS.push({ en: w.en, ipa: w.ipa || '', zh: w.zh, cat: CUSTOM_CAT, group: w.group, note: w.note || '' });
      });
    } else {
      delete CATEGORIES[CUSTOM_CAT];
      delete GROUPS[CUSTOM_CAT];
    }

    BY_EN = new Map(WORDS.map(w => [w.en, w]));
    CAT_KEYS = Object.keys(CATEGORIES);
    Object.keys(GROUP_COUNT).forEach(k => { delete GROUP_COUNT[k]; });
    WORDS.forEach(w => { const k = groupKeyOf(w); GROUP_COUNT[k] = (GROUP_COUNT[k] || 0) + 1; });

    // 新增学科/分组自动并入学习范围
    if (state && state.settings) {
      const cats = new Set(state.settings.categories || []);
      CAT_KEYS.forEach(k => cats.add(k));
      state.settings.categories = Array.from(cats);
      const gs = new Set(state.settings.groups || []);
      allGroupKeys().forEach(k => gs.add(k));
      state.settings.groups = Array.from(gs);
    }
  }

  /* ================= 日期 ================= */
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => fmt(new Date());
  function addDays(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return fmt(dt);
  }

  /* ================= 状态 ================= */
  const KEY = 'medlexicon.v1';

  function defaultState() {
    return {
      version: 4,
      progress: {},
      days: {},
      totals: { reviews: 0, correct: 0 },
      customWords: [],
      settings: {
        categories: CAT_KEYS.slice(),
        groups: allGroupKeys(),
        direction: 'en2zh',
        newLimit: 20,
        quizTypes: ['en2zh', 'zh2en', 'spell'],
        quizCount: 10
      }
    };
  }

  let state = load();
  rebuildWords();

  /* ================= 主题 ================= */
  const THEME_KEY = 'medlexicon.theme';

  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* 忽略隐私模式限制 */ }
  }
  function toggleTheme() {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }

  /* ================= 跨标签页同步 ================= */
  const SYNC_CHANNEL = 'medlexicon-sync';
  const SESSION_ID = Math.random().toString(36).slice(2);
  let bc = null;
  try { bc = new BroadcastChannel(SYNC_CHANNEL); } catch (e) { bc = null; }
  function mergeState(incoming) {
    // 只在 incoming 更新时合并
    let changed = false;
    const inProgress = incoming.progress || {};
    for (const en of Object.keys(inProgress)) {
      const local = state.progress[en];
      const inc = inProgress[en];
      const localT = local && (local.touched || local.due || '');
      const incT = inc && (inc.touched || inc.due || '');
      if (!local || incT >= localT) {
        state.progress[en] = inc;
        changed = true;
      }
    }
    // totals 取较大值
    if ((incoming.totals && incoming.totals.reviews) > (state.totals && state.totals.reviews)) {
      state.totals = Object.assign({}, incoming.totals);
      changed = true;
    }
    // days 合并
    if (incoming.days) {
      for (const d of Object.keys(incoming.days)) {
        if (!state.days[d]) { state.days[d] = incoming.days[d]; changed = true; }
        else {
          for (const k of Object.keys(incoming.days[d])) {
            if ((incoming.days[d][k] || 0) > (state.days[d][k] || 0)) {
              state.days[d][k] = incoming.days[d][k];
              changed = true;
            }
          }
        }
      }
    }
    return changed;
  }
  function onExternalSync(ev) {
    const data = ev.data || (ev.storage && ev.storage.newValue ? JSON.parse(ev.storage.newValue) : null);
    if (!data || typeof data !== 'object') return;
    // 忽略自己发出的 BroadcastChannel 消息（Storage 事件本来就不会自己触发）
    if (data.__src && data.__src === SESSION_ID) return;
    const incoming = data.state ? data.state : data;
    if (!incoming || !incoming.progress) return;
    const changed = mergeState(incoming);
    if (changed) {
      state.version = defaultState().version;
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
      renderHeader(); renderStats(); renderLibrary(); renderSetup();
      toast('已从另一标签页同步');
    }
  }
  if (bc) bc.onmessage = onExternalSync;
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY && e.newValue) {
      document.documentElement.dataset.theme = e.newValue;
      return;
    }
    if (e.key === KEY && e.newValue) {
      try { onExternalSync({ data: JSON.parse(e.newValue) }); } catch (err) { /* ignore */ }
    }
  });

  function load() {
    const base = defaultState();
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return base;
      const s = JSON.parse(raw);
      const settings = Object.assign(base.settings, s.settings || {});
      // 词库扩充后，把新增学科与分组自动并入范围
      if (s.version !== base.version) {
        settings.categories = Array.from(new Set([].concat(settings.categories || [], CAT_KEYS)));
        settings.groups = allGroupKeys();
      }
      if (!Array.isArray(settings.groups) || !settings.groups.length) settings.groups = allGroupKeys();
      return {
        version: base.version,
        progress: s.progress || {},
        days: s.days || {},
        totals: Object.assign(base.totals, s.totals || {}),
        customWords: Array.isArray(s.customWords) ? s.customWords : [],
        settings
      };
    } catch (e) {
      return base;
    }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 忽略配额错误 */ }
    if (bc) {
      try { bc.postMessage({ __src: SESSION_ID, state }); } catch (e) { /* ignore */ }
    }
  }

  /* ================= 记忆状态 ================= */
  const rec = en => state.progress[en];
  const isNew = en => { const p = rec(en); return !p || !p.seen; };
  function statusOf(en) {
    const p = rec(en);
    if (!p || !p.seen) return 'new';
    if ((p.interval || 0) >= 21) return 'mastered';
    return 'learning';
  }
  function isDueToday(en) {
    const p = rec(en);
    return !!(p && p.seen && p.due <= todayStr());
  }
  /* 难词：答错次数达到阈值，说明这个词反复记不住 */
  const LEECH_LAPSES = 2;
  function isLeech(en) {
    const p = rec(en);
    return !!(p && p.seen && (p.lapses || 0) >= LEECH_LAPSES);
  }

  function bump(key, v) {
    const d = todayStr();
    if (!state.days[d]) state.days[d] = { reviews: 0, correct: 0, new: 0, quiz: 0, quizCorrect: 0 };
    state.days[d][key] = (state.days[d][key] || 0) + v;
    const keys = Object.keys(state.days).sort();
    while (keys.length > 150) delete state.days[keys.shift()];
  }

  function streak() {
    let d = todayStr();
    const today = state.days[d];
    if (!today || today.reviews === 0) d = addDays(d, -1);
    let n = 0;
    while (state.days[d] && state.days[d].reviews > 0) {
      n++;
      d = addDays(d, -1);
    }
    return n;
  }

  /* SM-2 变体：0 不认识 / 1 模糊 / 2 认识 */
  function review(en, grade) {
    const p = state.progress[en] || { ef: 2.5, interval: 0, reps: 0, lapses: 0, seen: 0, due: todayStr() };
    const wasNew = !p.seen;
    p.seen = (p.seen || 0) + 1;

    if (grade === 0) {
      p.reps = 0;
      p.lapses = (p.lapses || 0) + 1;
      p.ef = Math.max(1.3, (p.ef || 2.5) - 0.2);
      p.interval = 0;
      p.due = todayStr();
    } else if (grade === 1) {
      p.ef = Math.max(1.3, (p.ef || 2.5) - 0.15);
      p.interval = Math.max(1, Math.round((p.interval || 1) * 1.2));
      p.reps = (p.reps || 0) + 1;
      p.due = addDays(todayStr(), p.interval);
    } else {
      p.reps = (p.reps || 0) + 1;
      p.interval = p.reps === 1 ? 1 : p.reps === 2 ? 3 : Math.max(4, Math.round((p.interval || 1) * (p.ef || 2.5)));
      p.ef = Math.min(2.9, (p.ef || 2.5) + 0.05);
      p.due = addDays(todayStr(), p.interval);
    }
    p.last = grade;
    p.touched = todayStr();
    state.progress[en] = p;

    state.totals.reviews++;
    if (grade > 0) state.totals.correct++;
    bump('reviews', 1);
    if (grade > 0) bump('correct', 1);
    if (wasNew) bump('new', 1);
    save();
  }

  /* ================= 语音 ================= */
  let voices = [];
  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    voices = speechSynthesis.getVoices() || [];
  }
  if ('speechSynthesis' in window) {
    loadVoices();
    if (typeof speechSynthesis.onvoiceschanged !== 'undefined') {
      speechSynthesis.onvoiceschanged = loadVoices;
    }
  }
  function speak(text) {
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音朗读'); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/-/g, ' '));
    u.lang = 'en-US';
    u.rate = 0.88;
    const prefer = voices.find(v => /en[-_](US|GB)/i.test(v.lang) && /Samantha|Google|Natural|Aria|Zira|Daniel/i.test(v.name))
      || voices.find(v => /^en/i.test(v.lang));
    if (prefer) u.voice = prefer;
    speechSynthesis.speak(u);
  }

  /* ================= 提示 ================= */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  /* ================= 顶部与侧栏 ================= */
  function renderHeader() {
    $('#streakBadge').textContent = '连续学习 ' + streak() + ' 天';
  }

  function renderChips() {
    $('#catChips').innerHTML = CAT_KEYS.map(k =>
      `<button class="chip ${state.settings.categories.includes(k) ? 'on' : ''}" data-cat="${k}">${CATEGORIES[k]}</button>`
    ).join('');

    const qTypes = [['en2zh', '英→中'], ['zh2en', '中→英'], ['spell', '拼写'], ['listen', '听音']];
    $('#quizTypeChips').innerHTML = qTypes.map(([k, label]) =>
      `<button class="chip ${state.settings.quizTypes.includes(k) ? 'on' : ''}" data-qtype="${k}">${label}</button>`
    ).join('');

    $$('#dirSeg button').forEach(b => b.classList.toggle('on', b.dataset.dir === state.settings.direction));
    $('#newLimitRange').value = state.settings.newLimit;
    $('#newLimitVal').textContent = state.settings.newLimit;
    $('#quizCountRange').value = state.settings.quizCount;
    $('#quizCountVal').textContent = state.settings.quizCount;
    renderGroupChips();
  }

  function renderGroupChips() {
    const box = $('#groupChips');
    if (!box) return;
    const cats = CAT_KEYS.filter(k => state.settings.categories.includes(k));
    if (!cats.length) {
      box.innerHTML = '<p class="hint" style="margin:0">先选择学科，再挑具体分组。</p>';
      return;
    }
    box.innerHTML = cats.map(k => {
      const gs = Object.keys(GROUPS[k] || {});
      const on = gs.filter(g => state.settings.groups.includes(k + '.' + g)).length;
      const chips = gs.map(g => {
        const key = k + '.' + g;
        const isOn = state.settings.groups.includes(key);
        return `<button class="chip sm ${isOn ? 'on' : ''}" data-group="${key}">${GROUPS[k][g]}<i>${GROUP_COUNT[key] || 0}</i></button>`;
      }).join('');
      return `<div class="group-row">
        <div class="group-name">${CATEGORIES[k]}<span>${on}/${gs.length} 组</span></div>
        <div class="chips">${chips}</div>
      </div>`;
    }).join('');
  }

  function studyPool() {
    const cats = new Set(state.settings.categories);
    const groups = new Set(state.settings.groups);
    return WORDS.filter(w => cats.has(w.cat) && groups.has(groupKeyOf(w)));
  }

  function renderSetup() {
    const pool = studyPool();
    const due = pool.filter(w => isDueToday(w.en)).length;
    const fresh = pool.filter(w => isNew(w.en)).length;
    const mastered = pool.filter(w => statusOf(w.en) === 'mastered').length;
    $('#statDue').textContent = due;
    $('#statNew').textContent = Math.min(fresh, state.settings.newLimit);
    $('#statMastered').textContent = mastered;
  }

  /* ================= 学习 ================= */
  let study = null;

  function startStudy() {
    if (!state.settings.categories.length) { toast('请至少选择一个学科'); return; }
    const pool = studyPool();
    if (!pool.length) { toast('所选分组里还没有单词，换一组试试'); return; }

    // 复习：全部随机打乱
    const reviews = shuffle(pool.filter(w => isDueToday(w.en))).map(w => w.en);

    // 新词：按分组依次学习，一组学完再进入下一组
    const fresh = [];
    const limit = state.settings.newLimit;
    const groupOrder = CAT_KEYS.flatMap(c => Object.keys(GROUPS[c] || {}).map(g => c + '.' + g))
      .filter(key => state.settings.groups.includes(key));
    for (const key of groupOrder) {
      if (fresh.length >= limit) break;
      const groupNew = pool.filter(w => groupKeyOf(w) === key && isNew(w.en));
      for (const w of groupNew) {
        if (fresh.length >= limit) break;
        fresh.push(w.en);
      }
    }

    const queue = reviews.concat(fresh);
    if (!queue.length) { toast('这个范围内今天没有需要学习的词了，可以换一组或调高每日新词'); return; }

    study = { queue, done: 0, revealed: false, grades: [0, 0, 0], undo: null };
    renderStudyStage(state.settings.direction === 'listen');
  }

  /* 从词根族 / 图解区块直接开始一组学习 */
  function startStudyWith(ens) {
    const queue = shuffle(ens).slice(0, 60);
    if (!queue.length) { toast('这一组还没有词条'); return; }
    study = { queue, done: 0, revealed: false, grades: [0, 0, 0], undo: null };
    switchView('study');
    renderStudyStage(state.settings.direction === 'listen');
  }

  function renderStudyStage(autoSpeak) {
    const setup = $('#studySetupPanel');
    const wrap = $('#studySession');
    if (!study) {
      setup.hidden = false;
      wrap.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    setup.hidden = true;
    wrap.hidden = false;
    renderSession(!!autoSpeak);
  }

  /* 预测下一次间隔，用于评分按钮上的提示 */
  function previewText(en, grade) {
    if (grade === 0) return '稍后再现';
    const p = rec(en) || { ef: 2.5, interval: 0, reps: 0 };
    if (grade === 1) return Math.max(1, Math.round((p.interval || 1) * 1.2)) + ' 天后';
    const reps = (p.reps || 0) + 1;
    const iv = reps === 1 ? 1 : reps === 2 ? 3 : Math.max(4, Math.round((p.interval || 1) * (p.ef || 2.5)));
    return iv + ' 天后';
  }

  function doneHTML() {
    const total = study.grades[0] + study.grades[1] + study.grades[2];
    return `<div class="done-card">
      <div class="done-icon">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>
      </div>
      <h3>本轮完成</h3>
      <p class="sub">共完成 ${total} 张卡片，进度已保存</p>
      <div class="done-stats">
        <div><b>${study.grades[0]}</b><span>不认识</span></div>
        <div><b>${study.grades[1]}</b><span>模糊</span></div>
        <div><b>${study.grades[2]}</b><span>认识</span></div>
      </div>
      <div class="done-actions">
        <button class="btn" data-exit="1">回到设置</button>
        <button class="btn primary" data-restart="study">再来一组</button>
      </div>
    </div>`;
  }

  function renderSession(autoSpeak) {
    const wrap = $('#studySession');
    if (!study) return;
    if (!study.queue.length) { wrap.innerHTML = doneHTML(); return; }

    const w = BY_EN.get(study.queue[0]);
    if (!w) { study.queue.shift(); renderSession(autoSpeak); return; }

    const dir = state.settings.direction;
    const tag = CATEGORIES[w.cat] + ' · ' + groupLabel(w);
    const st = statusOf(w.en);
    const stText = st === 'new' ? '新词' : st === 'mastered' ? '已掌握' : '学习中';
    const total = study.done + study.queue.length;
    const pct = total ? Math.round((study.done / total) * 100) : 0;

    let front, answer, hint;
    if (dir === 'zh2en') {
      front = `<div class="fc-word zh">${esc(w.zh)}</div><div class="fc-sub">在脑中回忆对应的英文单词</div>`;
      answer = `<div class="fc-word">${esc(w.en)}</div>
        <div class="fc-ipa">${esc(w.ipa)}</div>
        <button class="speak-btn" data-speak="${esc(w.en)}">${ICON_SPK}<span>发音</span></button>
        ${w.note ? `<div class="fc-note">${esc(w.note)}</div>` : ''}`;
      hint = '中 → 英';
    } else if (dir === 'listen') {
      front = `<button class="speak-big" data-speak="${esc(w.en)}">${ICON_SPK}</button>
        <div class="fc-sub">听发音，回忆单词拼写与释义 · 可点喇叭重听</div>`;
      answer = `<div class="fc-word">${esc(w.en)}</div>
        <div class="fc-ipa">${esc(w.ipa)}</div>
        <div class="fc-zh">${esc(w.zh)}</div>
        ${w.note ? `<div class="fc-note">${esc(w.note)}</div>` : ''}`;
      hint = '听音';
    } else {
      front = `<div class="fc-word">${esc(w.en)}</div>
        <div class="fc-ipa">${esc(w.ipa)}</div>
        <button class="speak-btn" data-speak="${esc(w.en)}">${ICON_SPK}<span>发音</span></button>`;
      answer = `<div class="fc-zh">${esc(w.zh)}</div>
        ${w.note ? `<div class="fc-note">${esc(w.note)}</div>` : ''}`;
      hint = '英 → 中';
    }

    const p = rec(w.en);
    const meta = p && p.seen
      ? `已复习 ${p.seen} 次 · 当前间隔 ${p.interval} 天`
      : '新词 · 首次学习';

    wrap.innerHTML = `
      <div class="session-bar">
        <button class="ghost-btn" data-exit="1">结束本轮</button>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="counter">${study.done}<i> / ${total}</i></div>
        <button class="ghost-btn" data-undo="1" ${study.undo ? '' : 'hidden'}>撤销</button>
      </div>

      <div class="flashcard${study.revealed ? ' is-flipped' : ''}" id="flashcard">
        <div class="fc-inner">
          <div class="fc-face fc-front">
            <div class="fc-top"><span class="tag">${tag}</span><span class="badge ${st}">${stText}</span></div>
            <div class="fc-body">${front}</div>
            <div class="fc-flip-hint">点击卡片翻面</div>
          </div>
          <div class="fc-face fc-back">
            <div class="fc-top"><span class="tag">${tag}</span><span class="badge ${st}">${stText}</span></div>
            <div class="fc-body">${answer}</div>
            <div class="fc-flip-hint">点击卡片回到题目</div>
          </div>
        </div>
      </div>

      <div class="actions" id="studyActions">${actionsHTML(w)}</div>
      <p class="hint center" id="studyHint">${hint} · ${meta}</p>`;

    if (autoSpeak && dir === 'listen') setTimeout(() => speak(w.en), 220);
  }

  function actionsHTML(w) {
    if (!study.revealed) {
      return `<button class="btn primary reveal-btn" data-reveal="1">显示答案<span class="kbd">空格</span></button>`;
    }
    return `<div class="rate-row">
      <button class="btn rate again" data-grade="0">
        <span class="k">1</span><span class="lbl">不认识</span><span class="when">${previewText(w.en, 0)}</span>
      </button>
      <button class="btn rate hard" data-grade="1">
        <span class="k">2</span><span class="lbl">模糊</span><span class="when">${previewText(w.en, 1)}</span>
      </button>
      <button class="btn rate good" data-grade="2">
        <span class="k">3</span><span class="lbl">认识</span><span class="when">${previewText(w.en, 2)}</span>
      </button>
    </div>`;
  }

  /* 原地翻转，不重渲染整卡，保证动画连续 */
  function flipCard() {
    if (!study || !study.queue.length) return;
    const card = $('#flashcard');
    if (!card) return;
    study.revealed = !study.revealed;
    card.classList.toggle('is-flipped', study.revealed);
    const w = BY_EN.get(study.queue[0]);
    const box = $('#studyActions');
    if (w && box) box.innerHTML = actionsHTML(w);
  }

  function reveal() {
    if (!study || study.revealed || !study.queue.length) return;
    flipCard();
  }

  function rate(grade) {
    if (!study || !study.revealed || !study.queue.length) return;
    const en = study.queue[0];
    const snapshot = {
      state: JSON.stringify(state),
      queue: study.queue.slice(),
      done: study.done,
      grades: study.grades.slice()
    };

    review(en, grade);
    study.queue.shift();
    study.done++;
    study.grades[grade]++;
    if (grade === 0) {
      const pos = Math.min(3, study.queue.length);
      study.queue.splice(pos, 0, en);
    }

    study.undo = snapshot;
    study.revealed = false;
    renderSession(state.settings.direction === 'listen');
    renderHeader();
    renderSetup();
  }

  function undoRate() {
    if (!study || !study.undo) return;
    const u = study.undo;
    try { state = JSON.parse(u.state); } catch (e) { /* 快照损坏则忽略 */ }
    study.queue = u.queue.slice();
    study.done = u.done;
    study.grades = u.grades.slice();
    study.undo = null;
    study.revealed = false;
    save();
    renderSession(false);
    renderHeader();
    renderSetup();
  }

  function exitStudy() {
    study = null;
    renderStudyStage();
    renderSetup();
    renderHeader();
  }

  /* ================= 测验 ================= */
  let quiz = null;

  const QLABEL = { en2zh: '看英文选中文', zh2en: '看中文选英文', spell: '看释义拼写', listen: '听音拼写' };

  function startQuiz() {
    if (!state.settings.quizTypes.length) { toast('请至少选择一种题型'); return; }
    const learned = WORDS.filter(w => !isNew(w.en));
    const count = state.settings.quizCount;
    const src = learned.length >= count ? learned : WORDS;
    const picked = shuffle(src).slice(0, Math.min(count, src.length));
    quiz = { qs: picked.map(makeQuestion), i: 0, correct: 0, wrong: [], answered: false };
    renderQuiz();
  }

  function makeQuestion(w) {
    const types = state.settings.quizTypes;
    const type = types[Math.floor(Math.random() * types.length)];
    if (type === 'spell' || type === 'listen') return { type, word: w };
    const same = WORDS.filter(x => x.cat === w.cat && x.en !== w.en);
    const pool = same.length >= 3 ? same : WORDS.filter(x => x.en !== w.en);
    const others = shuffle(pool).slice(0, 3);
    return { type, word: w, options: shuffle([w].concat(others)) };
  }

  function quizEmpty() {
    return `<div class="stage-empty">
      <div class="orb">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v5.5L5.5 17A3 3 0 0 0 8 21h8a3 3 0 0 0 2.5-4L14 8.5V3"/><path d="M7.5 15h9"/></svg>
      </div>
      <h3>检验一下</h3>
      <p>选择题型与题量后开始测验。答错的词会立即回到复习队列，明天再见到它。</p>
    </div>`;
  }

  function renderQuiz() {
    const stage = $('#quizStage');
    if (!quiz) { stage.innerHTML = quizEmpty(); return; }
    if (quiz.i >= quiz.qs.length) { stage.innerHTML = quizResultHTML(); return; }

    const q = quiz.qs[quiz.i];
    const w = q.word;
    const n = quiz.qs.length;
    let body = '';

    if (q.type === 'spell' || q.type === 'listen') {
      const letters = w.en.replace(/[^a-zA-Z]/g, '').length;
      const prompt = q.type === 'listen'
        ? `<button class="speak-big" data-speak="${esc(w.en)}">${ICON_SPK}</button>
           <div class="quiz-ask">听发音，拼写出这个单词 · 点击喇叭重听</div>`
        : `<div class="quiz-word zh">${esc(w.zh)}</div>
           <div class="quiz-ask">提示：首字母 ${esc(w.en[0].toUpperCase())} ，共 ${letters} 个字母</div>`;
      body = `<div class="quiz-prompt">${prompt}</div>
        <div class="spell-row">
          <input type="text" id="spellInput" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入英文单词">
        </div>
        <div class="feedback" id="feedback"></div>
        <div class="quiz-foot"><button class="btn primary" id="btnSpellSubmit">提交</button></div>`;
    } else {
      const isEn2zh = q.type === 'en2zh';
      const prompt = isEn2zh
        ? `<div class="quiz-word">${esc(w.en)}<button class="speak-btn small" data-speak="${esc(w.en)}">${ICON_SPK}</button></div>
           <div class="quiz-ipa">${esc(w.ipa)}</div><div class="quiz-ask">选出正确的中文释义</div>`
        : `<div class="quiz-word zh">${esc(w.zh)}</div><div class="quiz-ask">选出正确的英文单词</div>`;
      const opts = q.options.map((o, i) =>
        `<button class="option" data-opt="${i}">
           <span class="key">${'ABCD'[i]}</span>
           <span>${esc(isEn2zh ? o.zh : o.en)}</span>
         </button>`).join('');
      body = `<div class="quiz-prompt">${prompt}</div>
        <div class="options" id="options">${opts}</div>
        <div class="feedback" id="feedback"></div>
        <div class="quiz-foot"><button class="btn primary" id="btnNext" hidden>下一题</button></div>`;
    }

    stage.innerHTML = `
      <div class="quiz-card">
        <div class="quiz-head">
          <span>第 ${quiz.i + 1} / ${n} 题</span>
          <span class="tag">${QLABEL[q.type]}</span>
        </div>
        ${body}
      </div>
      <div class="stage-head" style="margin-top:16px">
        <div class="progress"><i style="width:${(quiz.i / n) * 100}%"></i></div>
        <div class="stage-meta"><span>答对 ${quiz.correct}</span></div>
      </div>`;

    quiz.answered = false;
    if (q.type === 'listen') setTimeout(() => speak(w.en), 260);
    const input = $('#spellInput');
    if (input) {
      input.focus();
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submitSpell(); });
    }
  }

  function norm(s) {
    return String(s).toLowerCase().replace(/[^a-z]/g, '');
  }

  function gradeQuestion(ok) {
    const q = quiz.qs[quiz.i];
    const w = q.word;
    quiz.answered = true;
    if (ok) {
      quiz.correct++;
      review(w.en, 2);
    } else {
      quiz.wrong.push(w);
      review(w.en, 0);
    }
    bump('quiz', 1);
    if (ok) bump('quizCorrect', 1);
    renderHeader(); renderSetup();

    const fb = $('#feedback');
    if (ok) {
      fb.innerHTML = `<span class="ok">回答正确</span> · ${esc(w.en)} ${esc(w.ipa)} — ${esc(w.zh)}`;
    } else {
      fb.innerHTML = `<span class="no">正确答案</span> · ${esc(w.en)} ${esc(w.ipa)} — ${esc(w.zh)}${w.note ? '<br><span class="muted">' + esc(w.note) + '</span>' : ''}`;
    }
    const btn = $('#btnNext');
    if (btn) {
      btn.hidden = false;
      btn.dataset.next = '1';
      btn.focus();
    }
  }

  function answerOption(idx) {
    if (!quiz || quiz.answered) return;
    const q = quiz.qs[quiz.i];
    const chosen = q.options[Number(idx)];
    const ok = chosen.en === q.word.en;
    $$('#options .option').forEach((btn, i) => {
      btn.disabled = true;
      const o = q.options[i];
      if (o.en === q.word.en) btn.classList.add('right');
      else if (i === Number(idx)) btn.classList.add('wrong');
    });
    gradeQuestion(ok);
    speak(q.word.en);
  }

  function submitSpell() {
    if (!quiz || quiz.answered) return;
    const input = $('#spellInput');
    if (!input) return;
    const q = quiz.qs[quiz.i];
    const ok = norm(input.value) === norm(q.word.en);
    input.disabled = true;
    const btn = $('#btnSpellSubmit');
    if (btn) btn.hidden = true;
    gradeQuestion(ok);
    const next = $('#btnNext');
    if (!next) {
      const foot = document.querySelector('#quizStage .quiz-foot');
      if (foot) {
        foot.innerHTML = '<button class="btn primary" id="btnNext">下一题</button>';
      }
    }
  }

  function nextQuestion() {
    if (!quiz) return;
    quiz.i++;
    renderQuiz();
  }

  function quizResultHTML() {
    const n = quiz.qs.length;
    const acc = n ? Math.round((quiz.correct / n) * 100) : 0;
    const wrongList = quiz.wrong.slice(0, 12).map(w =>
      `<div class="lib-row" style="cursor:default">
         <div class="lib-top">
           <div>
             <div class="lib-en">${esc(w.en)}<span class="ipa">${esc(w.ipa)}</span></div>
             <div class="lib-zh">${esc(w.zh)}</div>
           </div>
           <div class="lib-side">
             <button class="icon-btn" data-speak="${esc(w.en)}">${ICON_SPK}</button>
           </div>
         </div>
       </div>`).join('');

    return `<div class="done-card">
      <h3>${acc >= 80 ? '表现不错' : acc >= 60 ? '继续加把劲' : '这些词还需要多见面'}</h3>
      <div class="done-stats">
        <div><b>${quiz.correct} / ${n}</b><span>答对</span></div>
        <div><b>${acc}%</b><span>正确率</span></div>
      </div>
      <button class="btn primary" data-quiz-again="1">再测一组</button>
    </div>
    ${quiz.wrong.length ? `<div style="margin-top:16px">
      <h2 style="font-size:14px;color:#475569;margin:0 0 10px">本轮错题（已重新排入复习）</h2>
      <div class="lib-list">${wrongList}</div>
    </div>` : ''}`;
  }

  /* ================= 词库 ================= */
  let libLimit = 200; // 首屏只渲染前若干条，避免 3898 行同时进 DOM

  function renderLibrary() {
    const q = $('#libSearch').value.trim().toLowerCase();
    const cat = $('#libCat').value;
    const st = $('#libStatus').value;

    const list = WORDS.filter(w => {
      if (cat !== 'all' && w.cat !== cat) return false;
      if (st === 'due' && !isDueToday(w.en)) return false;
      if (st === 'leech' && !isLeech(w.en)) return false;
      if (st !== 'all' && st !== 'due' && st !== 'leech' && statusOf(w.en) !== st) return false;
      if (q) {
        const hay = (w.en + ' ' + w.zh + ' ' + w.note + ' ' + groupLabel(w) + ' ' + CATEGORIES[w.cat]).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    $('#libCount').textContent = list.length + ' 词';

    if (!list.length) {
      $('#libList').innerHTML = '<div class="lib-empty">没有匹配的单词，换个关键词试试。</div>';
      return;
    }

    const shown = list.slice(0, libLimit);
    const rest = list.length - shown.length;
    const stText = { new: '未学', learning: '学习中', mastered: '已掌握' };
    $('#libList').innerHTML = shown.map(w => {
      const p = rec(w.en);
      const stKey = statusOf(w.en);
      const meta = p && p.seen
        ? `复习 ${p.reps} 次 · 间隔 ${p.interval} 天 · 下次 ${p.due <= todayStr() ? '今天' : p.due}` + (p.lapses ? ` · 遗忘 ${p.lapses} 次` : '')
        : '尚未学习';
      return `<div class="lib-row" data-en="${esc(w.en)}">
        <div class="lib-top">
          <div>
            <div class="lib-en">${esc(w.en)}<span class="ipa">${esc(w.ipa)}</span></div>
            <div class="lib-zh">${esc(w.zh)}</div>
          </div>
          <div class="lib-side">
            <span class="tag">${CATEGORIES[w.cat]} · ${groupLabel(w)}</span>
            <span class="badge ${stKey}">${stText[stKey]}</span>
            <button class="icon-btn" data-speak="${esc(w.en)}">${ICON_SPK}</button>
          </div>
        </div>
        <div class="lib-detail" hidden>
          <p>${w.note ? esc(w.note) : '暂无词根解析'}</p>
          <p class="muted">${meta}</p>
          <div class="row-actions">
            <button data-mark="known">标记为已掌握</button>
            <button data-mark="reset">重置该词进度</button>
          </div>
        </div>
      </div>`;
    }).join('') + (rest > 0
      ? `<button class="btn wide lib-more" id="libMore">显示更多（剩余 ${rest} 词）</button>`
      : '');
  }

  /* ================= 统计 ================= */
  /* ================= 探索：词根 ================= */
  /* 词根表：显示形式、匹配片段、含义。全部为通用希腊/拉丁词素，公共知识。 */
  const ROOTS = [
    ['cardi-', 'cardi', '心'], ['nephr-', 'nephr', '肾'], ['hepat-', 'hepat', '肝'],
    ['gastr-', 'gastr', '胃'], ['enter-', 'enter', '肠'], ['pulmon-', 'pulmon', '肺'],
    ['pneum-', 'pneum', '肺 / 气'], ['bronch-', 'bronch', '支气管'], ['trache-', 'trache', '气管'],
    ['laryng-', 'laryng', '喉'], ['pharyng-', 'pharyng', '咽'], ['rhin-', 'rhin', '鼻'],
    ['cyt-', 'cyt', '细胞'], ['hist-', 'hist', '组织'], ['derm-', 'derm', '皮肤'],
    ['oste-', 'oste', '骨'], ['chondr-', 'chondr', '软骨'], ['myo-', 'myo', '肌'],
    ['neur-', 'neur', '神经'], ['encephal-', 'encephal', '脑'], ['mening-', 'mening', '脑膜'],
    ['myel-', 'myel', '脊髓 / 骨髓'], ['psych-', 'psych', '精神'], ['ophthalm-', 'ophthalm', '眼'],
    ['retin-', 'retin', '视网膜'], ['odont-', 'odont', '牙'], ['stomat-', 'stomat', '口'],
    ['gloss-', 'gloss', '舌'], ['thorac-', 'thorac', '胸'], ['lapar-', 'lapar', '腹'],
    ['hyster-', 'hyster', '子宫'], ['oophor-', 'oophor', '卵巢'], ['prostat-', 'prostat', '前列腺'],
    ['cyst-', 'cyst', '囊 / 膀胱'], ['urethr-', 'urethr', '尿道'], ['ureter-', 'ureter', '输尿管'],
    ['pyel-', 'pyel', '肾盂'], ['angi-', 'angi', '血管'], ['phleb-', 'phleb', '静脉'],
    ['arteri-', 'arteri', '动脉'], ['thromb-', 'thromb', '血栓'], ['hemat-', 'hemat', '血'],
    ['leuk-', 'leuk', '白'], ['erythr-', 'erythr', '红'], ['lymph-', 'lymph', '淋巴'],
    ['splen-', 'splen', '脾'], ['thym-', 'thym', '胸腺'], ['thyroid-', 'thyroid', '甲状腺'],
    ['adren-', 'adren', '肾上腺'], ['pancreat-', 'pancreat', '胰'], ['glyc-', 'glyc', '糖'],
    ['lip-', 'lip', '脂'], ['carcin-', 'carcin', '癌'], ['onc-', 'onc', '肿瘤'],
    ['lith-', 'lith', '石'], ['scler-', 'scler', '硬'], ['-itis', 'itis', '炎症'],
    ['-oma', 'oma', '肿块 / 肿瘤'], ['-ectomy', 'ectomy', '切除术'], ['-otomy', 'otomy', '切开术'],
    ['-ostomy', 'ostomy', '造口术'], ['-plasty', 'plasty', '成形术'], ['-scopy', 'scopy', '内镜检查'],
    ['-graphy', 'graphy', '造影 / 记录'], ['-pathy', 'pathy', '病变'], ['-plasia', 'plasia', '增生'],
    ['-algia', 'algia', '疼痛'], ['-emia', 'emia', '血症'], ['-uria', 'uria', '尿'],
    ['-pnea', 'pnea', '呼吸'], ['-phagia', 'phagia', '吞咽'], ['-megaly', 'megaly', '增大'],
    ['-penia', 'penia', '减少'], ['-ptosis', 'ptosis', '下垂'], ['-rrhea', 'rrhea', '流出']
  ];

  function rootMembers(match) {
    const q = match.toLowerCase();
    /* 后缀词根按词尾匹配，避免 -oma 命中 stomach 这类假同源 */
    const suffix = ROOTS.some(([label, m]) => m === match && label[0] === '-');
    return WORDS.filter(w => {
      const en = w.en.toLowerCase();
      return suffix ? en.endsWith(q) : en.includes(q);
    });
  }

  function renderRoots() {
    const cards = [];
    ROOTS.forEach(([label, match, meaning]) => {
      const members = rootMembers(match);
      if (members.length < 4) return;
      const sample = members.slice(0, 6);
      cards.push(`
        <div class="root-card" data-root="${match}">
          <div class="root-head">
            <div>
              <b class="root-label">${esc(label)}</b>
              <span class="root-mean">${esc(meaning)}</span>
            </div>
            <span class="root-count">${members.length} 词</span>
          </div>
          <div class="chips">
            ${sample.map(w => `<button class="chip sm" data-word="${esc(w.en)}">${esc(w.en)}</button>`).join('')}
          </div>
          <div class="root-actions">
            <button class="btn sm-primary" data-study-root="${match}">学习这一族</button>
            <button class="btn" data-list-root="${match}">在词库查看</button>
          </div>
        </div>`);
    });
    $('#exploreRoot').innerHTML = cards.length
      ? `<div class="root-grid">${cards.join('')}</div>`
      : '<div class="lib-empty">没有可用的词根分组</div>';
  }

  /* ================= 探索：图解 ================= */
  /* 示意图为本项目自绘的简化结构图，仅用于定位词族，不追求解剖精度 */
  const DIAGRAMS = [
    {
      id: 'heart', title: '心脏', note: '心腔、瓣膜与大血管',
      parts: [
        { name: '右心房', keys: ['anatomy.heart'] },
        { name: '左心房', keys: ['anatomy.heart'] },
        { name: '右心室', keys: ['anatomy.heart', 'physiology.cardio'] },
        { name: '左心室', keys: ['anatomy.heart', 'physiology.cardio'] },
        { name: '主动脉', keys: ['anatomy.vessel', 'patho.cardio'] },
        { name: '肺动脉', keys: ['anatomy.vessel', 'physiology.resp'] },
        { name: '冠状动脉', keys: ['anatomy.vessel', 'patho.cardio', 'pharm.cardio'] }
      ],
      svg: `<svg viewBox="0 0 380 320" role="img" aria-label="心脏示意图">
        <defs><clipPath id="clipHeart"><path d="M190 132C170 100 124 92 100 122 72 156 100 206 190 292 280 206 308 156 280 122 256 92 210 100 190 132Z"/></clipPath></defs>
        <g clip-path="url(#clipHeart)">
          <g class="organ" data-part="右心房"><rect x="60" y="100" width="130" height="92"/><text class="organ-label" x="120" y="152" text-anchor="middle">右心房</text></g>
          <g class="organ" data-part="左心房"><rect x="190" y="100" width="130" height="92"/><text class="organ-label" x="260" y="152" text-anchor="middle">左心房</text></g>
          <g class="organ" data-part="右心室"><rect x="60" y="192" width="130" height="102"/><text class="organ-label" x="146" y="222" text-anchor="middle">右心室</text></g>
          <g class="organ" data-part="左心室"><rect x="190" y="192" width="130" height="102"/><text class="organ-label" x="234" y="222" text-anchor="middle">左心室</text></g>
        </g>
        <path class="organ-line" d="M190 132C170 100 124 92 100 122 72 156 100 206 190 292 280 206 308 156 280 122 256 92 210 100 190 132Z"/>
        <g class="organ vessel" data-part="主动脉"><path d="M206 138C214 104 248 96 264 114"/><text class="organ-label" x="272" y="104">主动脉</text></g>
        <g class="organ vessel" data-part="肺动脉"><path d="M174 138C166 104 132 96 116 114"/><text class="organ-label" x="108" y="104" text-anchor="end">肺动脉</text></g>
        <g class="organ vessel" data-part="冠状动脉"><path d="M146 198C172 176 208 176 234 198"/><line class="leader" x1="146" y1="198" x2="120" y2="222"/><text class="organ-label" x="114" y="228" text-anchor="end">冠状动脉</text></g>
        <text class="map-title" x="190" y="314" text-anchor="middle">心脏 · 心腔、瓣膜与大血管</text>
      </svg>`
    },
    {
      id: 'brain', title: '脑', note: '脑叶、小脑与脑干',
      parts: [
        { name: '额叶', keys: ['anatomy.brain', 'clinical.neuro'] },
        { name: '顶叶', keys: ['anatomy.brain'] },
        { name: '颞叶', keys: ['anatomy.brain'] },
        { name: '枕叶', keys: ['anatomy.brain'] },
        { name: '小脑', keys: ['anatomy.brain', 'physiology.neuro'] },
        { name: '脑干', keys: ['anatomy.brain', 'physiology.neuro', 'clinical.neuro'] }
      ],
      svg: `<svg viewBox="0 0 360 300" role="img" aria-label="脑示意图">
        <defs><clipPath id="clipBrain"><ellipse cx="170" cy="132" rx="108" ry="82"/></clipPath></defs>
        <g clip-path="url(#clipBrain)">
          <g class="organ" data-part="额叶"><rect x="58" y="46" width="112" height="90"/><text class="organ-label" x="112" y="94" text-anchor="middle">额叶</text></g>
          <g class="organ" data-part="顶叶"><rect x="170" y="46" width="112" height="90"/><text class="organ-label" x="226" y="94" text-anchor="middle">顶叶</text></g>
          <g class="organ" data-part="颞叶"><rect x="58" y="136" width="112" height="82"/><text class="organ-label" x="112" y="180" text-anchor="middle">颞叶</text></g>
          <g class="organ" data-part="枕叶"><rect x="170" y="136" width="112" height="82"/><text class="organ-label" x="226" y="180" text-anchor="middle">枕叶</text></g>
        </g>
        <ellipse class="organ-line" cx="170" cy="132" rx="108" ry="82"/>
        <g class="organ" data-part="小脑"><ellipse cx="262" cy="240" rx="40" ry="24"/><text class="organ-label" x="262" y="244" text-anchor="middle">小脑</text></g>
        <g class="organ" data-part="脑干"><rect x="142" y="222" width="56" height="30" rx="15"/><text class="organ-label" x="170" y="241" text-anchor="middle">脑干</text></g>
        <text class="map-title" x="180" y="282" text-anchor="middle">脑 · 脑叶、小脑与脑干</text>
      </svg>`
    },
    {
      id: 'kidney', title: '肾', note: '皮质、髓质与肾盂',
      parts: [
        { name: '肾皮质', keys: ['anatomy.renal'] },
        { name: '肾髓质', keys: ['anatomy.renal'] },
        { name: '肾盂', keys: ['anatomy.renal', 'clinical.renal'] },
        { name: '肾单位', keys: ['physiology.renal'] },
        { name: '滤过与重吸收', keys: ['physiology.renal', 'pharm.renal'] }
      ],
      svg: `<svg viewBox="0 0 360 300" role="img" aria-label="肾示意图">
        <g class="organ" data-part="肾皮质">
          <path d="M150 52C96 52 62 100 62 154 62 208 108 248 156 248 184 248 198 228 198 202 198 186 188 172 188 154 188 136 198 122 198 98 198 74 180 52 150 52Z"/>
          <line class="leader" x1="70" y1="104" x2="88" y2="116"/>
          <text class="organ-label" x="64" y="100" text-anchor="end">肾皮质</text>
        </g>
        <g class="organ" data-part="肾髓质">
          <path transform="translate(150 152) scale(.66) translate(-150 -152)" d="M150 52C96 52 62 100 62 154 62 208 108 248 156 248 184 248 198 228 198 202 198 186 188 172 188 154 188 136 198 122 198 98 198 74 180 52 150 52Z"/>
          <text class="organ-label" x="128" y="158">肾髓质</text>
        </g>
        <g class="organ" data-part="肾盂">
          <ellipse cx="184" cy="154" rx="13" ry="26"/>
          <line class="leader" x1="198" y1="154" x2="224" y2="154"/>
          <text class="organ-label" x="230" y="158">肾盂</text>
        </g>
        <g class="organ" data-part="肾单位">
          <circle cx="292" cy="92" r="17"/>
          <line class="leader" x1="276" y1="96" x2="238" y2="120"/>
          <text class="organ-label" x="300" y="96">肾单位</text>
        </g>
        <path class="organ-line" d="M150 52C96 52 62 100 62 154 62 208 108 248 156 248 184 248 198 228 198 202 198 186 188 172 188 154 188 136 198 122 198 98 198 74 180 52 150 52Z"/>
        <text class="map-title" x="180" y="286" text-anchor="middle">肾 · 皮质、髓质与肾盂</text>
      </svg>`
    },
    {
      id: 'lung', title: '肺', note: '气道、肺叶与气体交换',
      parts: [
        { name: '气管', keys: ['anatomy.resp'] },
        { name: '支气管', keys: ['anatomy.resp', 'patho.resp'] },
        { name: '左肺上叶', keys: ['anatomy.resp'] },
        { name: '左肺下叶', keys: ['anatomy.resp'] },
        { name: '右肺上叶', keys: ['anatomy.resp'] },
        { name: '右肺中叶', keys: ['anatomy.resp'] },
        { name: '右肺下叶', keys: ['anatomy.resp'] },
        { name: '通气功能', keys: ['physiology.resp', 'physiology.method'] }
      ],
      svg: `<svg viewBox="0 0 360 300" role="img" aria-label="肺示意图">
        <defs>
          <clipPath id="clipLLung"><path d="M150 104C118 104 92 136 92 182 92 224 116 252 148 252 164 252 172 238 172 220V124C172 112 162 104 150 104Z"/></clipPath>
          <clipPath id="clipRLung"><path d="M210 104C242 104 268 136 268 182 268 224 244 252 212 252 196 252 188 238 188 220V124C188 112 198 104 210 104Z"/></clipPath>
        </defs>
        <g class="organ" data-part="气管"><rect x="170" y="34" width="22" height="58" rx="10"/><text class="organ-label" x="188" y="62">气管</text></g>
        <g class="organ vessel" data-part="支气管"><path d="M178 92 146 124"/><path d="M184 92 216 124"/><text class="organ-label" x="238" y="86">支气管</text></g>
        <g clip-path="url(#clipLLung)">
          <g class="organ" data-part="左肺上叶"><rect x="86" y="100" width="92" height="78"/><text class="organ-label" x="126" y="146" text-anchor="middle">上叶</text></g>
          <g class="organ" data-part="左肺下叶"><rect x="86" y="178" width="92" height="80"/><text class="organ-label" x="126" y="222" text-anchor="middle">下叶</text></g>
        </g>
        <g clip-path="url(#clipRLung)">
          <g class="organ" data-part="右肺上叶"><rect x="182" y="100" width="92" height="56"/><text class="organ-label" x="228" y="134" text-anchor="middle">上叶</text></g>
          <g class="organ" data-part="右肺中叶"><rect x="182" y="156" width="92" height="46"/><text class="organ-label" x="228" y="184" text-anchor="middle">中叶</text></g>
          <g class="organ" data-part="右肺下叶"><rect x="182" y="202" width="92" height="56"/><text class="organ-label" x="228" y="234" text-anchor="middle">下叶</text></g>
        </g>
        <path class="organ-line" d="M150 104C118 104 92 136 92 182 92 224 116 252 148 252 164 252 172 238 172 220V124C172 112 162 104 150 104Z"/>
        <path class="organ-line" d="M210 104C242 104 268 136 268 182 268 224 244 252 212 252 196 252 188 238 188 220V124C188 112 198 104 210 104Z"/>
        <text class="map-title" x="180" y="286" text-anchor="middle">肺 · 气道、肺叶与气体交换</text>
      </svg>`
    }
  ];

  let activeDiagram = 'heart';
  let activePart = '';

  function wordsOfKeys(keys) {
    const seen = new Set();
    const out = [];
    keys.forEach(k => {
      WORDS.filter(w => groupKeyOf(w) === k).forEach(w => {
        if (!seen.has(w.en)) { seen.add(w.en); out.push(w); }
      });
    });
    return out;
  }

  function renderMap() {
    const d = DIAGRAMS.find(x => x.id === activeDiagram) || DIAGRAMS[0];
    const part = d.parts.find(p => p.name === activePart) || null;
    const list = wordsOfKeys(part ? part.keys : d.parts.flatMap(p => p.keys));

    $('#exploreMap').innerHTML = `
      <div class="map-tabs chips">
        ${DIAGRAMS.map(x => `<button class="chip ${x.id === d.id ? 'on' : ''}" data-diagram="${x.id}">${x.title}</button>`).join('')}
      </div>
      <div class="map-body">
        <div class="map-canvas panel">
          ${d.svg}
          <div class="map-legend chips">
            ${d.parts.map(p => `<button class="chip sm ${part && part.name === p.name ? 'on' : ''}" data-part="${esc(p.name)}">${esc(p.name)}</button>`).join('')}
          </div>
        </div>
        <div class="map-side panel">
          <h2>${part ? esc(part.name) : d.title + ' 相关词'}</h2>
          <p class="hint">${part ? '点击图中其他区块或下方标签切换。' : '点击图中任一区块，只看该部位相关的词。'}</p>
          <div class="map-words">
            ${list.slice(0, 24).map(w => `<button class="chip sm" data-word="${esc(w.en)}">${esc(w.en)}<i>${esc(w.zh)}</i></button>`).join('') || '<span class="muted">暂无词条</span>'}
          </div>
          <div class="map-actions">
            <span class="muted">共 ${list.length} 词</span>
            ${part ? `<button class="btn primary" data-study-diagram="1">学习这 ${Math.min(list.length, 60)} 词</button>` : ''}
          </div>
        </div>
      </div>`;

    $$('#exploreMap .organ').forEach(el => el.classList.toggle('is-on', el.dataset.part === activePart));
  }

  function renderExplore() {
    renderRoots();
    renderMap();
  }
  /* ================= 统计 ================= */
  function renderStats() {
    const total = WORDS.length;
    const seen = WORDS.filter(w => !isNew(w.en)).length;
    const mastered = WORDS.filter(w => statusOf(w.en) === 'mastered').length;
    const due = WORDS.filter(w => isDueToday(w.en)).length;
    const leech = WORDS.filter(w => isLeech(w.en)).length;
    const acc = state.totals.reviews ? Math.round((state.totals.correct / state.totals.reviews) * 100) : 0;

    $('#statGrid').innerHTML = [
      ['词库总量', total, ''],
      ['已接触', seen, ''],
      ['已掌握', mastered, 'mastered'],
      ['今日待复习', due, 'due'],
      ['难词', leech, 'leech'],
      ['连续学习', streak() + ' 天', ''],
      ['累计正确率', acc + '%', '']
    ].map(([k, v, jump]) => `<div class="stat-card${jump ? ' is-link' : ''}"${jump ? ` data-jump="${jump}"` : ''}><span>${k}</span><b>${v}</b></div>`).join('');

    $('#catBars').innerHTML = CAT_KEYS.map(k => {
      const words = WORDS.filter(w => w.cat === k);
      const learned = words.filter(w => !isNew(w.en)).length;
      const pct = words.length ? Math.round((learned / words.length) * 100) : 0;
      return `<div class="cat-bar">
        <span class="name">${CATEGORIES[k]}</span>
        <div class="track"><i style="width:${pct}%"></i></div>
        <span class="num">${learned}/${words.length}</span>
      </div>`;
    }).join('');

    const week = [];
    const wd = ['日', '一', '二', '三', '四', '五', '六'];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(todayStr(), -i);
      const rec2 = state.days[d];
      week.push({ d, v: rec2 ? rec2.reviews : 0, label: i === 0 ? '今天' : '周' + wd[new Date(d.replace(/-/g, '/')).getDay()] });
    }
    const max = Math.max(1, ...week.map(x => x.v));
    $('#weekBars').innerHTML = week.map(x => `
      <div class="week-col">
        <span class="val">${x.v}</span>
        <div class="bar ${x.v ? '' : 'zero'}" style="height:${x.v ? Math.max(8, (x.v / max) * 110) : 4}px"></div>
        <span class="day">${x.label}</span>
      </div>`).join('');

    /* 全年热力图：53 周 × 7 天，按周一为每周起点对齐 */
    const heat = [];
    const end = todayStr();
    const dow = (new Date(end + 'T00:00:00').getDay() + 6) % 7; // 周一=0
    const span = 52 * 7 + dow + 1;
    const start = addDays(end, -(span - 1));
    for (let i = 0; i < span; i++) {
      const d = addDays(start, i);
      if (d > end) {
        heat.push('<i class="heat-cell blank"></i>');
        continue;
      }
      const day = state.days[d] || {};
      const n = (day.reviews || 0) + (day.quiz || 0);
      const lvl = n === 0 ? 0 : n < 5 ? 1 : n < 15 ? 2 : n < 30 ? 3 : 4;
      heat.push(`<i class="heat-cell l${lvl}" title="${d} · 复习 ${day.reviews || 0} · 测验 ${day.quiz || 0}"></i>`);
    }
    $('#heatMap').innerHTML = heat.join('');
  }

  /* ================= 视图切换 ================= */
  let currentView = 'study';
  const VIEWS = ['study', 'library', 'explore', 'quiz', 'stats'];

  function switchView(name, fromHash) {
    currentView = name;
    $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === name));
    $$('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-' + name));
    if (name === 'library') renderLibrary();
    if (name === 'explore') renderExplore();
    if (name === 'stats') renderStats();
    if (name === 'study') { renderStudyStage(); renderSetup(); }
    if (name === 'quiz' && !quiz) $('#quizStage').innerHTML = quizEmpty();
    if (!fromHash) {
      try { history.replaceState(null, '', '#' + name); } catch (e) { /* file:// 下可能不支持 */ }
    }
  }

  /* 支持 /#library 这类直达链接，方便分享某个视图 */
  function viewFromHash() {
    const h = (location.hash || '').replace('#', '');
    return VIEWS.includes(h) ? h : '';
  }

  /* ================= 事件 ================= */
  document.addEventListener('click', e => {
    const speakBtn = e.target.closest('[data-speak]');
    if (speakBtn) {
      e.stopPropagation();
      speak(speakBtn.getAttribute('data-speak'));
      return;
    }

    const gradeBtn = e.target.closest('[data-grade]');
    if (gradeBtn) { rate(Number(gradeBtn.dataset.grade)); return; }

    if (e.target.closest('[data-reveal]')) { reveal(); return; }
    if (e.target.closest('[data-exit]')) { exitStudy(); return; }
    if (e.target.closest('[data-undo]')) { undoRate(); return; }

    const optBtn = e.target.closest('[data-opt]');
    if (optBtn) { answerOption(optBtn.dataset.opt); return; }

    if (e.target.closest('#btnNext')) { nextQuestion(); return; }
    if (e.target.closest('#btnSpellSubmit')) { submitSpell(); return; }

    if (e.target.closest('[data-restart]')) { startStudy(); return; }
    if (e.target.closest('[data-quiz-again]')) { startQuiz(); return; }

    if (e.target.closest('#btnStartStudy')) { startStudy(); return; }
    if (e.target.closest('#btnStartQuiz')) { startQuiz(); return; }

    const tab = e.target.closest('.tab');
    if (tab) { switchView(tab.dataset.view); return; }

    if (e.target.closest('#btnTheme')) { toggleTheme(); return; }

    /* ---- 探索：词根 / 图解 ---- */
    const expSeg = e.target.closest('#exploreSeg button');
    if (expSeg) {
      const mode = expSeg.dataset.exp;
      $$('#exploreSeg button').forEach(b => b.classList.toggle('on', b === expSeg));
      $('#exploreRoot').hidden = mode !== 'root';
      $('#exploreMap').hidden = mode !== 'map';
      $('#exploreHint').textContent = mode === 'root'
        ? '按词根把同源词放在一起：先认词根，再认词族。'
        : '点击图中区块，只看该部位相关的词。示意图为简化结构，仅作词族索引，不作为解剖学参考。';
      return;
    }
    const diagramBtn = e.target.closest('[data-diagram]');
    if (diagramBtn) {
      activeDiagram = diagramBtn.dataset.diagram;
      activePart = '';
      renderMap();
      return;
    }
    const partBtn = e.target.closest('[data-part]');
    if (partBtn) {
      activePart = partBtn.dataset.part;
      renderMap();
      return;
    }
    const studyRoot = e.target.closest('[data-study-root]');
    if (studyRoot) {
      startStudyWith(rootMembers(studyRoot.dataset.studyRoot).map(w => w.en));
      return;
    }
    const listRoot = e.target.closest('[data-list-root]');
    if (listRoot) {
      $('#libStatus').value = 'all';
      $('#libCat').value = 'all';
      $('#libSearch').value = listRoot.dataset.listRoot;
      libLimit = 200;
      switchView('library');
      return;
    }
    const studyPart = e.target.closest('[data-study-diagram]');
    if (studyPart) {
      const d = DIAGRAMS.find(x => x.id === activeDiagram);
      const p = d && d.parts.find(x => x.name === activePart);
      if (p) startStudyWith(wordsOfKeys(p.keys).map(w => w.en));
      return;
    }
    const wordChip = e.target.closest('[data-word]');
    if (wordChip) {
      $('#libStatus').value = 'all';
      $('#libCat').value = 'all';
      $('#libSearch').value = wordChip.dataset.word;
      libLimit = 200;
      switchView('library');
      return;
    }

    const catChip = e.target.closest('[data-cat]');
    if (catChip) {
      const k = catChip.dataset.cat;
      const arr = state.settings.categories;
      const i = arr.indexOf(k);
      if (i >= 0) arr.splice(i, 1); else arr.push(k);
      save(); renderChips(); renderSetup();
      return;
    }

    const groupChip = e.target.closest('[data-group]');
    if (groupChip) {
      const k = groupChip.dataset.group;
      const arr = state.settings.groups;
      const i = arr.indexOf(k);
      if (i >= 0) arr.splice(i, 1); else arr.push(k);
      save(); renderChips(); renderSetup();
      return;
    }

    if (e.target.closest('#btnGroupAll')) {
      const cats = new Set(state.settings.categories);
      const add = allGroupKeys().filter(k => cats.has(k.split('.')[0]));
      state.settings.groups = Array.from(new Set(state.settings.groups.concat(add)));
      save(); renderChips(); renderSetup();
      return;
    }

    if (e.target.closest('#btnGroupNone')) {
      const cats = new Set(state.settings.categories);
      state.settings.groups = state.settings.groups.filter(k => !cats.has(k.split('.')[0]));
      save(); renderChips(); renderSetup();
      return;
    }

    const qChip = e.target.closest('[data-qtype]');
    if (qChip) {
      const k = qChip.dataset.qtype;
      const arr = state.settings.quizTypes;
      const i = arr.indexOf(k);
      if (i >= 0) arr.splice(i, 1); else arr.push(k);
      save(); renderChips();
      return;
    }

    const dirBtn = e.target.closest('#dirSeg button');
    if (dirBtn) {
      state.settings.direction = dirBtn.dataset.dir;
      save(); renderChips();
      return;
    }

    const markBtn = e.target.closest('[data-mark]');
    if (markBtn) {
      const row = markBtn.closest('.lib-row');
      const en = row.dataset.en;
      if (markBtn.dataset.mark === 'known') {
        const p = state.progress[en] || { ef: 2.5, interval: 0, reps: 0, lapses: 0, seen: 0 };
        p.seen = Math.max(1, p.seen || 0);
        p.interval = 30;
        p.reps = Math.max(3, p.reps || 0);
        p.due = addDays(todayStr(), 30);
        state.progress[en] = p;
        toast('已标记为掌握');
      } else {
        delete state.progress[en];
        toast('已重置该词');
      }
      save(); renderLibrary(); renderSetup(); renderHeader();
      return;
    }

    const libRow = e.target.closest('.lib-row');
    if (libRow && libRow.dataset.en && !e.target.closest('button')) {
      const detail = libRow.querySelector('.lib-detail');
      if (detail) detail.hidden = !detail.hidden;
      return;
    }

    const jump = e.target.closest('[data-jump]');
    if (jump) {
      $('#libStatus').value = jump.dataset.jump;
      $('#libCat').value = 'all';
      $('#libSearch').value = '';
      libLimit = 200;
      switchView('library');
      return;
    }

    if (e.target.closest('#btnExport')) { exportData(); return; }
    if (e.target.closest('#btnWordTemplate')) { downloadWordTemplate(); return; }
    if (e.target.closest('#btnClearCustom')) { clearCustomWords(); return; }

    if (e.target.closest('#libMore')) { libLimit += 300; renderLibrary(); return; }
    if (e.target.closest('#btnReset')) {
      if (confirm('确定要清空全部学习进度吗？此操作不可撤销。')) {
        const keepCustom = state.customWords || [];
        state = defaultState();
        state.customWords = keepCustom;
        rebuildWords();
        save();
        study = null; quiz = null;
        renderCatOptions(); renderCustomInfo();
        renderChips(); renderSetup(); renderHeader(); renderStudyStage();
        $('#quizStage').innerHTML = quizEmpty();
        if (currentView === 'stats') renderStats();
        if (currentView === 'library') renderLibrary();
        toast('进度已重置');
      }
      return;
    }

    if (e.target.closest('#flashcard')) { flipCard(); return; }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'newLimitRange') {
      state.settings.newLimit = Number(e.target.value);
      $('#newLimitVal').textContent = e.target.value;
      save(); renderSetup();
    }
    if (e.target.id === 'quizCountRange') {
      state.settings.quizCount = Number(e.target.value);
      $('#quizCountVal').textContent = e.target.value;
      save();
    }
    if (e.target.id === 'libSearch') { libLimit = 200; renderLibrary(); }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'libCat' || e.target.id === 'libStatus') { libLimit = 200; renderLibrary(); }
    if (e.target.id === 'importFile') importData(e.target.files[0]);
    if (e.target.id === 'importWords') importWordList(e.target.files[0]);
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (currentView === 'quiz') {
      if (!quiz) return;
      if (quiz.answered) {
        if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); nextQuestion(); }
        return;
      }
      const q = quiz.qs[quiz.i];
      if (q && q.options) {
        const idx = ['1', '2', '3', '4'].indexOf(e.key);
        if (idx >= 0 && idx < q.options.length) answerOption(idx);
      }
      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      switchView('library');
      $('#libSearch').focus();
      return;
    }

    if (currentView !== 'study' || !study) return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); reveal(); return; }
    if (!study.revealed) return;
    if (e.key === '1') rate(0);
    else if (e.key === '2') rate(1);
    else if (e.key === '3') rate(2);
  });

  /* ================= 数据导入导出 ================= */
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'medlexicon-progress-' + todayStr() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('进度已导出');
  }

  function importData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object' || !data.progress) throw new Error('bad');
        state.progress = data.progress || {};
        state.days = data.days || {};
        state.totals = Object.assign({ reviews: 0, correct: 0 }, data.totals || {});
        if (data.settings) state.settings = Object.assign(state.settings, data.settings);
        if (Array.isArray(data.customWords)) state.customWords = data.customWords;
        if (!Array.isArray(state.settings.groups) || !state.settings.groups.length) state.settings.groups = allGroupKeys();
        rebuildWords();
        save();
        renderCatOptions(); renderCustomInfo();
        renderChips(); renderSetup(); renderHeader(); renderStats(); renderLibrary();
        toast('进度已导入');
      } catch (err) {
        toast('文件格式不正确');
      }
    };
    reader.readAsText(file);
  }

  /* ================= 自定义词表 ================= */
  function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function renderCatOptions() {
    $('#libCat').innerHTML = '<option value="all">全部学科</option>' +
      CAT_KEYS.map(k => `<option value="${k}">${CATEGORIES[k]}</option>`).join('');
  }

  function renderCustomInfo() {
    const n = (state.customWords || []).length;
    const el = $('#customInfo');
    if (!el) return;
    el.innerHTML = n
      ? `已导入 <b>${n}</b> 条自定义词条，可在词库的「自建词表」中查看。<button class="link-btn" id="btnClearCustom">清空自定义词表</button>`
      : '自定义词表会作为「自建词表」学科出现在学习与词库中，只存在本机。CSV 每行：<code>英文,音标,中文释义,记忆点</code>（音标与记忆点可留空）。';
  }

  function refreshAfterWordsChange() {
    rebuildWords();
    renderCatOptions();
    renderChips();
    renderGroupChips();
    renderSetup();
    renderHeader();
    renderLibrary();
    renderStats();
    renderCustomInfo();
  }

  function importWordList(file) {
    if (!file) return;
    const listName = (file.name || '自定义').replace(/\.[^.]+$/, '').slice(0, 20) || '自定义';
    const group = 'u' + Date.now().toString(36);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '').replace(/^\ufeff/, '').trim();
      if (!text) { toast('文件是空的'); return; }

      let rows = [];
      if (text[0] === '[' || text[0] === '{') {
        try {
          const data = JSON.parse(text);
          const arr = Array.isArray(data) ? data : (data.words || []);
          rows = arr.map(x => Array.isArray(x) ? x : [x.en || x.term, x.ipa, x.zh || x.meaning, x.note]);
        } catch (e) {
          toast('JSON 解析失败，请检查格式');
          return;
        }
      } else {
        rows = text.split(/\r?\n/).map(l => splitCsvLine(l).map(s => s.trim()));
        if (rows.length && /^(英文|word|term)$/i.test(rows[0][0])) rows.shift();
      }

      const seen = new Set(WORDS.map(w => w.en.toLowerCase()));
      const added = [];
      rows.forEach(r => {
        const en = String((r && r[0]) || '').trim();
        const zh = String((r && r[2]) || '').trim();
        if (!en || !zh) return;
        if (seen.has(en.toLowerCase())) return;
        seen.add(en.toLowerCase());
        added.push({
          en, zh,
          ipa: String((r && r[1]) || '').trim(),
          note: String((r && r[3]) || '').trim(),
          group, groupLabel: listName
        });
      });

      if (!added.length) { toast('没有可导入的新词条'); return; }
      state.customWords = (state.customWords || []).concat(added).slice(0, 5000);
      save();
      refreshAfterWordsChange();
      toast(`已导入 ${added.length} 个词条`);
    };
    reader.readAsText(file);
  }

  function downloadWordTemplate() {
    const csv = '\ufeff英文,音标,中文释义,记忆点\nmyocardial infarction,/ˌmaɪəˈkɑːrdiəl ɪnˈfɑːrkʃn/,心肌梗死,myo- 肌 + cardial 心的\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'medlexicon-wordlist-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function clearCustomWords() {
    if (!(state.customWords || []).length) return;
    if (!confirm('确定清空所有自定义词表吗？内置词库不受影响。')) return;
    state.customWords = [];
    save();
    refreshAfterWordsChange();
    toast('自定义词表已清空');
  }

  /* ================= 离线缓存 ================= */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return; // file:// 直接打开时不注册
    navigator.serviceWorker.register('sw.js').catch(() => { /* 注册失败不影响正常使用 */ });
  }

  /* ================= 启动 ================= */
  function init() {
    renderCatOptions();
    renderChips();
    renderSetup();
    renderHeader();
    renderStudyStage();
    renderCustomInfo();
    $('#quizStage').innerHTML = quizEmpty();

    const hv = viewFromHash();
    if (hv) switchView(hv, true);
    window.addEventListener('hashchange', () => {
      const v = viewFromHash();
      if (v && v !== currentView) switchView(v, true);
    });

    registerServiceWorker();
    save();
  }

  init();
})();
