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

  const WORDS = RAW_WORDS.map(([en, ipa, zh, cat, group, note]) => ({
    en, ipa, zh, cat, group: group || '', note: note || ''
  }));
  const BY_EN = new Map(WORDS.map(w => [w.en, w]));
  const CAT_KEYS = Object.keys(CATEGORIES);

  const groupKeyOf = w => w.cat + '.' + w.group;
  const groupLabel = w => (GROUPS[w.cat] || {})[w.group] || '';
  const allGroupKeys = () => CAT_KEYS.flatMap(c => Object.keys(GROUPS[c] || {}).map(g => c + '.' + g));
  const GROUP_COUNT = {};
  WORDS.forEach(w => { const k = groupKeyOf(w); GROUP_COUNT[k] = (GROUP_COUNT[k] || 0) + 1; });

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
  function renderStats() {
    const total = WORDS.length;
    const seen = WORDS.filter(w => !isNew(w.en)).length;
    const mastered = WORDS.filter(w => statusOf(w.en) === 'mastered').length;
    const due = WORDS.filter(w => isDueToday(w.en)).length;
    const leech = WORDS.filter(w => isLeech(w.en)).length;
    const acc = state.totals.reviews ? Math.round((state.totals.correct / state.totals.reviews) * 100) : 0;

    $('#statGrid').innerHTML = [
      ['词库总量', total],
      ['已接触', seen],
      ['已掌握', mastered],
      ['今日待复习', due],
      ['难词', leech],
      ['连续学习', streak() + ' 天'],
      ['累计正确率', acc + '%']
    ].map(([k, v]) => `<div class="stat-card"><span>${k}</span><b>${v}</b></div>`).join('');

    $('#catBars').innerHTML = CAT_KEYS.map(k => {
      const words = WORDS.filter(w => w.cat === k);
      const learned = words.filter(w => !isNew(w.en)).length;
      const mast = words.filter(w => statusOf(w.en) === 'mastered').length;
      const pct = words.length ? Math.round((mast / words.length) * 100) : 0;
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

    /* 最近 30 天热力图 */
    const heat = [];
    for (let i = 29; i >= 0; i--) {
      const d = addDays(todayStr(), -i);
      const day = state.days[d] || {};
      const n = (day.reviews || 0) + (day.quiz || 0);
      const lvl = n === 0 ? 0 : n < 5 ? 1 : n < 15 ? 2 : n < 30 ? 3 : 4;
      heat.push(`<i class="heat-cell l${lvl}" title="${d} · 复习 ${day.reviews || 0} · 测验 ${day.quiz || 0}"></i>`);
    }
    $('#heatMap').innerHTML = heat.join('');
  }

  /* ================= 视图切换 ================= */
  let currentView = 'study';
  const VIEWS = ['study', 'library', 'quiz', 'stats'];

  function switchView(name, fromHash) {
    currentView = name;
    $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === name));
    $$('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-' + name));
    if (name === 'library') renderLibrary();
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

    if (e.target.closest('#btnExport')) { exportData(); return; }

    if (e.target.closest('#libMore')) { libLimit += 300; renderLibrary(); return; }
    if (e.target.closest('#btnReset')) {
      if (confirm('确定要清空全部学习进度吗？此操作不可撤销。')) {
        state = defaultState();
        save();
        study = null; quiz = null;
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
        if (!Array.isArray(state.settings.groups) || !state.settings.groups.length) state.settings.groups = allGroupKeys();
        save();
        renderChips(); renderSetup(); renderHeader(); renderStats(); renderLibrary();
        toast('进度已导入');
      } catch (err) {
        toast('文件格式不正确');
      }
    };
    reader.readAsText(file);
  }

  /* ================= 离线缓存 ================= */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return; // file:// 直接打开时不注册
    navigator.serviceWorker.register('sw.js').catch(() => { /* 注册失败不影响正常使用 */ });
  }

  /* ================= 启动 ================= */
  function init() {
    const catSel = $('#libCat');
    catSel.innerHTML = '<option value="all">全部学科</option>' +
      CAT_KEYS.map(k => `<option value="${k}">${CATEGORIES[k]}</option>`).join('');

    renderChips();
    renderSetup();
    renderHeader();
    renderStudyStage();
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
