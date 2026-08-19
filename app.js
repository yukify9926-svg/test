const STORAGE_KEY = 'shadowing-app-scripts';
const SETTINGS_KEY = 'shadowing-app-settings';
const DB_NAME = 'shadowing-audio';
const DB_STORE = 'audio';

let scripts = loadScripts();
let settings = loadSettings();
let currentScriptId = null;
let seeking = false;
let filter = '';

// Word timings for the script currently loaded in the player.
let words = null;      // [{ text, start, end, space }]
let wordSpans = [];    // element per words index (null for whitespace)
let activeWord = -1;

// ---------- DOM helpers ----------
// A cached index.html can outlive its app.js on mobile, and a single missing
// node used to throw at load time and leave every later listener unbound —
// including playback. Missing nodes now disable just their own feature.

function el(id) {
  return document.getElementById(id);
}

function on(id, event, handler, options) {
  const node = el(id);
  if (node) node.addEventListener(event, handler, options);
  return node;
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

function setHidden(id, hidden) {
  const node = el(id);
  if (node) node.hidden = hidden;
}

function getValue(id) {
  const node = el(id);
  return node ? node.value : '';
}

function setValue(id, value) {
  const node = el(id);
  if (node) node.value = value;
}

function isChecked(id) {
  const node = el(id);
  return node ? node.checked : false;
}

// ---------- storage ----------

function loadScripts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveScripts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts));
}

function loadSettings() {
  const empty = { apiKey: '', voiceId: '', claudeKey: '', lookup: 'native' };
  try {
    return Object.assign(empty, JSON.parse(localStorage.getItem(SETTINGS_KEY)));
  } catch {
    return empty;
  }
}

function nativeLookup() {
  return settings.lookup !== 'claude';
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- audio cache (IndexedDB) ----------
// Failures are non-fatal: the app simply regenerates the audio.

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbRequest(mode, run) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const req = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function cacheGet(id) {
  try {
    const value = await dbRequest('readonly', store => store.get(id));
    if (!value) return null;
    // Entries written before word timings existed are bare ArrayBuffers.
    if (value instanceof ArrayBuffer) return { audio: value, alignment: null };
    return value;
  } catch {
    return null;
  }
}

async function cachePut(id, entry) {
  try {
    await dbRequest('readwrite', store => store.put(entry, id));
  } catch {
    /* storage full or unavailable — regenerating still works */
  }
}

async function cacheClear() {
  try {
    await dbRequest('readwrite', store => store.clear());
    return true;
  } catch {
    return false;
  }
}

// ---------- toast (replaces alert/confirm, which mobile browsers can block) ----------

let toastTimer;

function toast(message, kind) {
  const node = el('toast');
  if (!node) return;
  node.textContent = message;
  node.className = kind === 'error' ? 'toast error' : 'toast';
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'error' ? 7000 : 2600);
}

// ---------- Claude API (translation and vocabulary) ----------
// The official SDK is vendored at vendor/anthropic.js and imported on demand,
// so the rest of the app keeps working when these features go unused.

let claudeClient = null;

async function getClaude() {
  if (!settings.claudeKey) throw new Error('「設定」タブでAnthropic API Keyを入力してください');
  if (claudeClient && claudeClient.key === settings.claudeKey) return claudeClient.client;
  const { default: Anthropic } = await import('./vendor/anthropic.js');
  const client = new Anthropic({ apiKey: settings.claudeKey, dangerouslyAllowBrowser: true });
  claudeClient = { key: settings.claudeKey, client };
  return client;
}

async function askClaude(prompt, schema) {
  const client = await getClaude();
  let res;
  try {
    res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }]
    });
  } catch (err) {
    throw new Error(err.status === 401
      ? 'Anthropic API Keyが正しくないようです'
      : `Claude APIエラー: ${err.message}`);
  }
  const block = res.content.find(b => b.type === 'text');
  if (!block) throw new Error('応答を取得できませんでした');
  return JSON.parse(block.text);
}

function fetchTranslation(text) {
  return askClaude(
    `次の英文を日本語に訳してください。英語学習者が英文の構造をつかめるよう、意訳しすぎない自然な訳にしてください。\n\n英文: ${text}`,
    {
      type: 'object',
      properties: { translation: { type: 'string', description: '英文全体の日本語訳' } },
      required: ['translation'],
      additionalProperties: false
    }
  );
}

function fetchVocab(word, sentence) {
  return askClaude(
    `英語学習者向けに、文中の語を解説してください。辞書的な語義の羅列ではなく、この文脈での意味を中心に説明してください。\n\n文: ${sentence}\n対象の語: ${word}`,
    {
      type: 'object',
      properties: {
        base: { type: 'string', description: '見出し語(原形)。句動詞やイディオムの一部ならその全体' },
        pos: { type: 'string', description: '品詞を日本語で(例: 動詞、名詞、形容詞、句動詞)' },
        meaning: { type: 'string', description: 'この文脈での意味を日本語で簡潔に' },
        note: { type: 'string', description: 'ニュアンス、使いどころ、類義語との違いなどを1〜2文で' },
        example: { type: 'string', description: 'この語を使った別の平易な英語例文を1つ' },
        exampleJa: { type: 'string', description: 'その例文の日本語訳' }
      },
      required: ['base', 'pos', 'meaning', 'note', 'example', 'exampleJa'],
      additionalProperties: false
    }
  );
}

// ---------- Web Audio player ----------
// The <audio> element cannot seek in ElevenLabs' streamed MP3 (no duration
// metadata), so playback runs through the Web Audio API instead.

const player = {
  ctx: null,
  buffer: null,
  source: null,
  offset: 0,
  startedAt: 0,
  rate: 1,
  loop: false,
  ab: null,        // [start, end] when an A-B region is set
  playing: false,

  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      // iOS starts a page in an ambient session, where the ringer switch
      // silences Web Audio (an <audio> element would have been exempt).
      // Declaring playback asks for a session that is not tied to the ringer.
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch { /* not supported — the ringer switch then applies */ }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  decode(arrayBuffer) {
    const ctx = this.unlock();
    return new Promise((resolve, reject) => {
      const ret = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    });
  },

  async load(arrayBuffer) {
    this.stop();
    this.ab = null;
    this.buffer = await this.decode(arrayBuffer);
    this.offset = 0;
  },

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  },

  get regionStart() { return this.ab ? this.ab[0] : 0; },
  get regionEnd() { return this.ab ? this.ab[1] : this.duration; },
  get looping() { return this.loop || !!this.ab; },

  position() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    const raw = this.offset + (this.ctx.currentTime - this.startedAt) * this.rate;
    if (!this.looping) return Math.min(raw, this.duration);
    const start = this.regionStart;
    const length = this.regionEnd - start;
    if (length <= 0 || raw < this.regionEnd) return Math.min(raw, this.duration);
    return start + ((raw - this.regionEnd) % length);
  },

  play() {
    if (!this.buffer) return;
    const ctx = this.unlock();
    this.stopSource();

    if (this.ab && (this.offset < this.ab[0] || this.offset >= this.ab[1])) this.offset = this.ab[0];
    else if (!this.looping && this.offset >= this.duration - 0.01) this.offset = 0;

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    source.loop = this.looping;
    source.loopStart = this.regionStart;
    source.loopEnd = this.regionEnd;
    source.connect(ctx.destination);
    source.onended = () => {
      if (this.source !== source) return; // superseded by a newer source
      this.playing = false;
      this.offset = this.duration;
      this.source = null;
      onPlaybackChanged();
    };
    source.start(0, this.offset);

    this.source = source;
    this.startedAt = ctx.currentTime;
    this.playing = true;
    onPlaybackChanged();
  },

  stopSource() {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    source.onended = null;
    try { source.stop(); } catch { /* already stopped */ }
  },

  pause() {
    if (!this.playing) return;
    this.offset = this.position();
    this.stopSource();
    this.playing = false;
    onPlaybackChanged();
  },

  stop() {
    this.stopSource();
    this.playing = false;
    this.offset = 0;
    onPlaybackChanged();
  },

  seek(seconds) {
    if (!this.buffer) return;
    this.offset = Math.max(0, Math.min(seconds, this.duration));
    if (this.playing) this.play();
    else onPlaybackChanged();
  },

  nudge(delta) {
    this.seek(this.position() + delta);
  },

  restart() {
    // Re-arm the current source so loop/rate/region changes take effect now.
    if (this.playing) {
      this.offset = this.position();
      this.play();
    } else {
      onPlaybackChanged();
    }
  },

  setRate(rate) {
    this.rate = rate;
    this.restart();
  },

  setLoop(loop) {
    this.loop = loop;
    this.restart();
  },

  setAb(region) {
    this.ab = region;
    this.restart();
  }
};

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function onPlaybackChanged() {
  setText('btn-playpause', player.playing ? '❚❚' : '▶');
  updatePlayerUi();
}

function updatePlayerUi() {
  const duration = player.duration;
  const position = player.position();
  setText('time-current', formatTime(position));
  setText('time-total', formatTime(duration));
  const seekNode = el('seek');
  if (!seeking && seekNode) {
    seekNode.value = duration ? Math.round((position / duration) * 1000) : 0;
  }
  updateHighlight(position);
}

function tick() {
  if (player.playing) updatePlayerUi();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- word highlighting ----------

function buildWords(alignment) {
  if (!alignment || !Array.isArray(alignment.characters)) return null;
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds || [];
  const ends = alignment.character_end_times_seconds || [];
  if (starts.length !== chars.length || ends.length !== chars.length) return null;

  const result = [];
  let current = null;
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) {
      if (current) { result.push(current); current = null; }
      result.push({ text: chars[i], space: true });
      continue;
    }
    if (!current) current = { text: '', start: starts[i], end: ends[i] };
    current.text += chars[i];
    current.end = ends[i];
  }
  if (current) result.push(current);
  return result.some(w => !w.space) ? result : null;
}

function renderScriptText(script) {
  const container = el('practice-text');
  if (!container) return;
  container.innerHTML = '';
  wordSpans = [];
  activeWord = -1;

  container.classList.toggle('native-lookup', nativeLookup());

  if (!words) {
    container.textContent = script.text;
    container.classList.remove('has-words');
    return;
  }

  container.classList.add('has-words');
  words.forEach((word, index) => {
    if (word.space) {
      container.appendChild(document.createTextNode(word.text));
      wordSpans.push(null);
      return;
    }
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = word.text;
    span.dataset.index = String(index);
    container.appendChild(span);
    wordSpans.push(span);
  });
}

function findWord(position) {
  if (!words) return -1;
  // Most lookups land on the active word or the one after it.
  for (let i = Math.max(0, activeWord); i < words.length; i++) {
    const word = words[i];
    if (word.space) continue;
    if (position < word.start) break;
    if (position <= word.end) return i;
  }
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word.space && position >= word.start && position <= word.end) return i;
  }
  return -1;
}

function updateHighlight(position) {
  if (!words) return;
  const index = findWord(position);
  if (index === activeWord) return;
  if (wordSpans[activeWord]) wordSpans[activeWord].classList.remove('active');
  if (wordSpans[index]) wordSpans[index].classList.add('active');
  activeWord = index;
}

// Tap a word to seek to it; press and hold to look it up. The hold must not
// also fire the tap, so the click that follows a long press is swallowed.
const LONG_PRESS_MS = 450;
let pressTimer = null;
let pressOrigin = null;
let longPressFired = false;

function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
  pressOrigin = null;
}

on('practice-text', 'pointerdown', e => {
  const span = e.target.closest('.word');
  longPressFired = false;
  // Under native lookup the hold belongs to iOS: intercepting it here would
  // stop the selection that raises 調べる and 翻訳.
  if (!span || nativeLookup()) return;
  pressOrigin = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longPressFired = true;
    openVocab(span);
  }, LONG_PRESS_MS);
});

on('practice-text', 'pointermove', e => {
  if (!pressOrigin) return;
  if (Math.hypot(e.clientX - pressOrigin.x, e.clientY - pressOrigin.y) > 10) cancelPress();
});

['pointerup', 'pointercancel', 'pointerleave'].forEach(type => {
  on('practice-text', type, cancelPress);
});

on('practice-text', 'contextmenu', e => {
  if (e.target.closest('.word') && !nativeLookup()) e.preventDefault();
});

on('practice-text', 'click', e => {
  const span = e.target.closest('.word');
  if (!span) return;
  if (longPressFired) return; // the hold already handled this press
  // A tap that lands on a selection is the user dismissing it, not a seek.
  if (nativeLookup() && !window.getSelection().isCollapsed) return;
  if (!words) return;
  const word = words[Number(span.dataset.index)];
  if (!word) return;
  player.seek(word.start);
  if (!player.playing) player.play();
});

// ---------- vocabulary sheet ----------

function stripPunctuation(text) {
  return text.replace(/^[^\p{L}\p{N}'’-]+|[^\p{L}\p{N}'’-]+$/gu, '');
}

function closeVocab() {
  setHidden('vocab-sheet', true);
  setHidden('sheet-backdrop', true);
}

on('vocab-close', 'click', closeVocab);
on('sheet-backdrop', 'click', closeVocab);

function setVocabBody(html) {
  const body = el('vocab-body');
  if (body) body.innerHTML = html;
}

function renderVocab(entry) {
  setVocabBody(`
    <p class="vocab-pos">${escapeHtml(entry.pos)}</p>
    <p class="vocab-meaning">${escapeHtml(entry.meaning)}</p>
    ${entry.note ? `<p class="vocab-note">${escapeHtml(entry.note)}</p>` : ''}
    <div class="vocab-example">
      <p class="vocab-example-en">${escapeHtml(entry.example)}</p>
      <p class="vocab-example-ja">${escapeHtml(entry.exampleJa)}</p>
    </div>`);
}

async function openVocab(span) {
  const script = getCurrentScript();
  const sheet = el('vocab-sheet');
  if (!script || !sheet) return;

  const word = stripPunctuation(span.textContent);
  if (!word) return;

  setText('vocab-word', word);
  sheet.hidden = false;
  setHidden('sheet-backdrop', false);

  const key = word.toLowerCase();
  const cached = script.vocab && script.vocab[key];
  if (cached) {
    setText('vocab-word', cached.base || word);
    renderVocab(cached);
    return;
  }

  if (!settings.claudeKey) {
    setVocabBody('<p class="vocab-note">「設定」タブでAnthropic API Keyを入力すると、語彙の解説が表示されます。</p>');
    return;
  }

  setVocabBody('<p class="vocab-note">調べています…</p>');
  try {
    const entry = await fetchVocab(word, script.text);
    script.vocab = script.vocab || {};
    script.vocab[key] = entry;
    saveScripts();
    if (sheet.hidden) return;
    setText('vocab-word', entry.base || word);
    renderVocab(entry);
  } catch (err) {
    setVocabBody(`<p class="vocab-note">${escapeHtml(err.message)}</p>`);
  }
}

// ---------- translation ----------

let translationVisible = true;

function renderTranslation(script) {
  const btn = el('btn-translate');
  const text = el('practice-translation');
  if (!btn || !text) return;

  btn.hidden = false;
  if (!script.translation) {
    text.hidden = true;
    btn.textContent = '日本語訳を表示';
    return;
  }
  text.textContent = script.translation;
  text.hidden = !translationVisible;
  btn.textContent = translationVisible ? '日本語訳を隠す' : '日本語訳を表示';
}

on('btn-translate', 'click', async () => {
  const script = getCurrentScript();
  if (!script) return;

  if (script.translation) {
    translationVisible = !translationVisible;
    renderTranslation(script);
    return;
  }

  if (!settings.claudeKey) {
    toast('和訳が未登録です。追加時に和訳を貼るか、設定タブでAnthropic API Keyを入力してください', 'error');
    return;
  }

  const btn = document.getElementById('btn-translate');
  btn.disabled = true;
  btn.textContent = '翻訳中...';
  try {
    const { translation } = await fetchTranslation(script.text);
    script.translation = translation;
    saveScripts();
    translationVisible = true;
    renderTranslation(script);
  } catch (err) {
    toast(err.message, 'error');
    renderTranslation(script);
  } finally {
    btn.disabled = false;
  }
});

// ---------- tabs ----------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'practice') renderPractice();
  measureDock();
  window.scrollTo(0, 0);
}

on('btn-goto-list', 'click', () => switchTab('list'));

// ---------- script list ----------

// Splitting follows the shape of what was pasted: line-per-sentence transcripts
// split on newlines, a flowing paragraph splits on sentence punctuation.
function splitByPunctuation(text, pattern) {
  const out = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const sentence = match[0].trim();
    if (sentence) out.push(sentence);
  }
  return out.length ? out : [text.trim()];
}

function splitLines(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length > 1 ? lines : null;
}

function splitEnglish(text) {
  return splitLines(text) || splitByPunctuation(text, /[^.!?…]+[.!?…]*["')\]]*\s*/g);
}

function splitJapanese(text) {
  return splitLines(text) || splitByPunctuation(text, /[^。！？.!?]+[。！？.!?]*[」』）]*\s*/g);
}

// Hiragana, katakana and CJK ideographs. A line carrying any of these is the
// translation; everything else is treated as the English side.
const JAPANESE_CHARS = /[぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿]/;

function isJapanese(line) {
  return JAPANESE_CHARS.test(line);
}

// Reads one pasted block holding both languages. Two arrangements are accepted
// because they cannot be confused: English and Japanese alternating line by
// line, or every English line followed by the same number of Japanese lines.
function parseCombined(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return [];

  const japanese = lines.map(isJapanese);
  if (japanese[0]) return { orphan: lines[0] };

  const firstJa = japanese.indexOf(true);
  const blockPaired = firstJa > 1 &&
    japanese.slice(firstJa).every(Boolean) &&
    firstJa === lines.length - firstJa;
  if (blockPaired) {
    return lines.slice(0, firstJa).map((text, i) => ({ text, translation: lines[firstJa + i] }));
  }

  const pairs = [];
  lines.forEach(line => {
    if (!isJapanese(line)) {
      pairs.push({ text: line, translation: '' });
      return;
    }
    const last = pairs[pairs.length - 1];
    last.translation = last.translation ? `${last.translation} ${line}` : line;
  });
  return pairs;
}

// Pairs English with a supplied translation. Returns null when the two sides
// have different counts, since guessing an alignment would mislabel lines.
function pairScripts(english, japanese) {
  const en = splitEnglish(english);
  if (!japanese) return en.map(text => ({ text, translation: '' }));
  const ja = splitJapanese(japanese);
  if (ja.length !== en.length) return { mismatch: { en: en.length, ja: ja.length } };
  return en.map((text, i) => ({ text, translation: ja[i] }));
}

on('script-form', 'submit', e => {
  e.preventDefault();
  const raw = getValue('input-text').trim();
  if (!raw) return;

  const note = getValue('input-note').trim();
  const tags = getValue('input-tags').split(',').map(t => t.trim()).filter(Boolean);

  let parts = parseCombined(raw);
  if (parts.orphan) {
    toast('英文から始めてください。和訳は英文の次の行に書きます', 'error');
    return;
  }
  if (!parts.length) return;

  // A line is one practice item, however many sentences it holds — that is
  // what makes a multi-sentence section possible, and it keeps a given line
  // behaving the same whether it was pasted alone or among others. Splitting
  // further is an explicit request, and then it applies to every line.
  if (isChecked('input-split')) {
    const expanded = [];
    for (const part of parts) {
      const paired = pairScripts(part.text, part.translation);
      if (paired.mismatch) {
        toast(`英文${paired.mismatch.en}件に対し和訳${paired.mismatch.ja}件で数が合いません。区切りを揃えてください`, 'error');
        return;
      }
      expanded.push(...paired);
    }
    parts = expanded;
  }

  parts.forEach(part => {
    scripts.push({
      id: uid(),
      text: part.text,
      translation: part.translation || '',
      note: parts.length === 1 ? note : '',
      tags,
      createdAt: new Date().toISOString(),
      lastPracticed: null,
      practiceCount: 0
    });
  });

  saveScripts();
  setValue('input-text', '');
  setValue('input-note', '');
  document.activeElement?.blur();
  renderScriptList();
  toast(parts.length === 1 ? '追加しました' : `${parts.length}件に分けて追加しました`);
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function matchesFilter(script) {
  if (!filter) return true;
  const haystack = [script.text, script.note, ...(script.tags || [])].join(' ').toLowerCase();
  return haystack.includes(filter);
}

on('search-input', 'input', e => {
  filter = e.target.value.trim().toLowerCase();
  renderScriptList();
});

function renderScriptList() {
  const list = el('script-list');
  if (!list) return;
  setText('script-count', `(${scripts.length})`);

  const visible = scripts.filter(matchesFilter);

  if (visible.length === 0) {
    list.innerHTML = `<p class="hint">${scripts.length === 0
      ? 'まだスクリプトがありません。上のフォームから追加してください。'
      : '一致するスクリプトがありません。'}</p>`;
    return;
  }

  list.innerHTML = '';
  [...visible].reverse().forEach(script => {
    const card = document.createElement('div');
    card.className = 'script-card';
    card.innerHTML = `
      <p class="text">${escapeHtml(script.text)}</p>
      ${script.note ? `<p class="note">${escapeHtml(script.note)}</p>` : ''}
      ${script.tags && script.tags.length ? `<div class="tags">${script.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <p class="meta">練習 ${script.practiceCount}回 ・ ${script.lastPracticed ? new Date(script.lastPracticed).toLocaleDateString('ja-JP') : '未練習'}</p>
      <div class="card-actions">
        <button class="practice-this">練習する</button>
        <button class="delete-this">削除</button>
      </div>`;

    card.querySelector('.practice-this').addEventListener('click', () => {
      selectScript(script.id);
      switchTab('practice');
    });

    // Two-step delete: confirm() can be blocked by the browser's dialog settings.
    const deleteBtn = card.querySelector('.delete-this');
    let confirming = false;
    let confirmTimer;
    deleteBtn.addEventListener('click', () => {
      if (!confirming) {
        confirming = true;
        deleteBtn.textContent = '本当に?';
        deleteBtn.classList.add('confirming');
        confirmTimer = setTimeout(() => {
          confirming = false;
          deleteBtn.textContent = '削除';
          deleteBtn.classList.remove('confirming');
        }, 4000);
        return;
      }
      clearTimeout(confirmTimer);
      scripts = scripts.filter(s => s.id !== script.id);
      saveScripts();
      if (currentScriptId === script.id) {
        currentScriptId = null;
        clearAudio();
      }
      renderScriptList();
      renderPractice();
      toast('削除しました');
    });

    list.appendChild(card);
  });
}

// ---------- practice ----------

function getCurrentScript() {
  return scripts.find(s => s.id === currentScriptId) || null;
}

function clearAudio() {
  player.stop();
  player.buffer = null;
  player.ab = null;
  words = null;
  wordSpans = [];
  activeWord = -1;
  updateAbUi();
  updateGenerateButton();
}

async function selectScript(id) {
  if (currentScriptId === id) return;
  currentScriptId = id;
  clearAudio();
  renderPractice();
  setStatus('');

  const cached = await cacheGet(id);
  if (!cached || currentScriptId !== id) {
    if (!cached) setStatus('「音声を生成」を押してください');
    return;
  }

  try {
    await player.load(cached.audio.slice(0));
    if (currentScriptId !== id) return;
    words = buildWords(cached.alignment);
    renderPractice();
    setStatus(words
      ? '保存済みの音声を読み込みました'
      : 'この音声にはハイライトがありません。作り直すと単語が光ります');
    onPlaybackChanged();
  } catch {
    setStatus('「音声を生成」を押してください');
  }
}

function setStatus(message) {
  setText('player-status', message);
}

// What the dock offers depends on whether this script has audio yet: without
// it the only useful action is generating, so that becomes the whole bar and
// the transport stays out of the way. Once audio exists the transport takes
// the bar and generating — now a re-make, including for audio old enough to
// lack word timings — moves into the panel behind the ⋯ button.
function updateGenerateButton() {
  const btn = el('btn-generate');
  if (!btn) return;

  const hasAudio = !!player.buffer;
  setHidden('dock-playback', !hasAudio);

  // Audio from before word timings existed plays but cannot be highlighted,
  // and the status line invites re-making it. That invitation needs its button
  // in reach, so it stays in the bar rather than moving behind ⋯.
  const inBar = !hasAudio || !words;
  btn.textContent = !hasAudio ? '音声を生成'
    : words ? '音声を作り直す'
    : 'ハイライト付きで作り直す';
  btn.classList.toggle('secondary', hasAudio);

  btn.classList.toggle('wide', inBar);
  btn.classList.toggle('panel-btn', !inBar);

  const target = el(inBar ? 'dock-bar' : 'dock-panel');
  if (target && btn.parentElement !== target) {
    if (inBar) target.insertBefore(btn, el('player-status'));
    else target.appendChild(btn);
  }
  measureDock();
}

// The script scrolls behind the dock, so the page needs to know how tall the
// dock currently is to leave room under the text.
function measureDock() {
  const dock = document.querySelector('.dock');
  const height = dock ? dock.offsetHeight : 0;
  document.documentElement.style.setProperty('--dock-h', `${height}px`);
}

on('btn-more', 'click', () => {
  const panel = el('dock-panel');
  const btn = el('btn-more');
  if (!panel || !btn) return;
  const opening = panel.hidden;
  panel.hidden = !opening;
  btn.setAttribute('aria-expanded', String(opening));
  measureDock();
});

if (window.ResizeObserver) {
  const dock = document.querySelector('.dock');
  if (dock) new ResizeObserver(measureDock).observe(dock);
}

function renderPractice() {
  const script = getCurrentScript();

  if (!script) {
    setHidden('practice-empty', false);
    setHidden('practice-body', true);
    return;
  }

  setHidden('practice-empty', true);
  setHidden('practice-body', false);

  const index = scripts.findIndex(s => s.id === script.id);
  setText('practice-position', `${index + 1} / ${scripts.length}`);
  renderScriptText(script);
  setHidden('word-hint', !words);
  setText('word-hint', nativeLookup()
    ? '単語をタップで頭出し・長押しで「調べる」「翻訳」'
    : '単語をタップで頭出し・長押しで語彙');
  renderTranslation(script);
  setText('practice-note', script.note || '');
  setText('practice-stats',
    `練習回数 ${script.practiceCount}回` +
    (script.lastPracticed ? ` ・ 最終 ${new Date(script.lastPracticed).toLocaleString('ja-JP')}` : ''));
  updatePlayerUi();
  updateGenerateButton();
}

function step(delta) {
  if (scripts.length === 0) return;
  const index = scripts.findIndex(s => s.id === currentScriptId);
  const next = ((index < 0 ? 0 : index + delta) + scripts.length) % scripts.length;
  selectScript(scripts[next].id);
}

on('btn-prev', 'click', () => step(-1));
on('btn-next', 'click', () => step(1));

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

on('btn-generate', 'click', async () => {
  const script = getCurrentScript();
  if (!script) return;

  player.unlock(); // must happen inside the tap, before any await

  if (!settings.apiKey || !settings.voiceId) {
    toast('先に「設定」タブでAPIキーとVoice IDを入力してください', 'error');
    switchTab('settings');
    return;
  }

  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.textContent = '生成中...';
  setStatus('ElevenLabsで音声を生成しています');

  try {
    // with-timestamps also returns per-character timings, used for highlighting.
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${settings.voiceId}/with-timestamps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': settings.apiKey },
        body: JSON.stringify({
          text: script.text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      }
    );

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.detail?.message || body?.detail?.status || '';
      } catch { /* non-JSON error body */ }
      throw new Error(`音声を生成できませんでした (${res.status})${detail ? ': ' + detail : ''}`);
    }

    const payload = await res.json();
    if (currentScriptId !== script.id) return;

    const audio = base64ToArrayBuffer(payload.audio_base64);
    const alignment = payload.alignment || payload.normalized_alignment || null;

    await cachePut(script.id, { audio, alignment });
    await player.load(audio.slice(0)); // decodeAudioData detaches its input
    words = buildWords(alignment);
    renderPractice();
    setStatus(words ? '再生できます' : '再生できます(ハイライトなし)');
    player.play();
  } catch (err) {
    setStatus('');
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    updateGenerateButton();
  }
});

on('btn-playpause', 'click', () => {
  if (!player.buffer) {
    toast('先に「音声を生成」を押してください');
    return;
  }
  if (player.playing) player.pause();
  else player.play();
});

on('btn-rewind', 'click', () => player.nudge(-5));
on('btn-forward', 'click', () => player.nudge(5));

function seekFraction() {
  const node = el('seek');
  return node ? Number(node.value) / 1000 : 0;
}

['pointerdown', 'touchstart'].forEach(type => {
  on('seek', type, () => { seeking = true; });
});

// Releasing has to clear the flag on its own. Touching the slider without
// moving it — brushing past while scrolling, tapping where the thumb already
// sits — fires no change event, and the flag used to latch on there and freeze
// the bar for the rest of the session. Listening on the window also covers a
// release that happens away from the slider.
['pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach(type => {
  window.addEventListener(type, () => { seeking = false; });
});

on('seek', 'input', () => {
  seeking = true;
  setText('time-current', formatTime(seekFraction() * player.duration));
});
on('seek', 'change', () => {
  player.seek(seekFraction() * player.duration);
  seeking = false;
});

function currentRate() {
  const node = el('speed-range');
  return node ? parseFloat(node.value) : 1;
}

on('speed-range', 'input', () => {
  setText('speed-value', `${currentRate().toFixed(2)}x`);
});
on('speed-range', 'change', () => player.setRate(currentRate()));

on('loop-toggle', 'change', e => player.setLoop(e.target.checked));

// ---------- A-B repeat ----------

let abStart = null;

function updateAbUi() {
  const btn = el('btn-ab');
  const clear = el('btn-ab-clear');
  if (!btn || !clear) return;
  if (player.ab) {
    btn.textContent = `A-B ${formatTime(player.ab[0])} - ${formatTime(player.ab[1])}`;
    btn.classList.add('armed');
    clear.hidden = false;
  } else if (abStart !== null) {
    btn.textContent = `B地点を設定 (A: ${formatTime(abStart)})`;
    btn.classList.add('armed');
    clear.hidden = false;
  } else {
    btn.textContent = 'A-B区間リピート';
    btn.classList.remove('armed');
    clear.hidden = true;
  }
}

on('btn-ab', 'click', () => {
  if (!player.buffer) {
    toast('先に「音声を生成」を押してください');
    return;
  }
  if (player.ab) return; // already looping; use 解除 to reset

  const position = player.position();
  if (abStart === null) {
    abStart = position;
    updateAbUi();
    toast('A地点を設定しました');
    return;
  }
  if (position <= abStart + 0.3) {
    toast('B地点はA地点より後ろを指定してください', 'error');
    return;
  }
  player.setAb([abStart, position]);
  abStart = null;
  updateAbUi();
  toast('区間リピートを開始しました');
});

on('btn-ab-clear', 'click', () => {
  abStart = null;
  player.setAb(null);
  updateAbUi();
  toast('区間リピートを解除しました');
});

on('btn-mark-practiced', 'click', () => {
  const script = getCurrentScript();
  if (!script) return;
  script.practiceCount += 1;
  script.lastPracticed = new Date().toISOString();
  saveScripts();
  renderPractice();
  renderScriptList();
  toast('練習を記録しました');
});

// ---------- settings ----------

setValue('input-api-key', settings.apiKey || '');
setValue('input-voice-id', settings.voiceId || '');
setValue('input-claude-key', settings.claudeKey || '');
setValue('input-lookup', settings.lookup || 'native');

on('settings-form', 'submit', e => {
  e.preventDefault();
  settings.apiKey = getValue('input-api-key').trim();
  settings.voiceId = getValue('input-voice-id').trim();
  settings.claudeKey = getValue('input-claude-key').trim();
  settings.lookup = getValue('input-lookup') || 'native';
  saveSettings();
  renderPractice();
  document.activeElement?.blur();
  toast('設定を保存しました');
});

// ---------- import / export ----------

on('btn-export', 'click', () => {
  const blob = new Blob([JSON.stringify(scripts, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scripts.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

on('input-import', 'change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('形式が正しくありません');
      toast(`${mergeScripts(imported)}件を読み込みました`);
    } catch (err) {
      toast('読み込めませんでした: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

on('btn-load-sample', 'click', async () => {
  try {
    const res = await fetch('data/scripts.sample.json');
    if (!res.ok) throw new Error('サンプルを取得できませんでした');
    const added = mergeScripts(await res.json());
    toast(added ? `${added}件を読み込みました` : 'サンプルは読み込み済みです');
  } catch (err) {
    toast(err.message, 'error');
  }
});

function mergeScripts(incoming) {
  const existingIds = new Set(scripts.map(s => s.id));
  const additions = incoming.filter(s => s && s.id && !existingIds.has(s.id));
  scripts = scripts.concat(additions);
  saveScripts();
  renderScriptList();
  return additions.length;
}

on('btn-clear-audio', 'click', async () => {
  if (!(await cacheClear())) {
    toast('削除できませんでした', 'error');
    return;
  }
  clearAudio();
  renderPractice();
  setStatus('「音声を生成」を押してください');
  toast('保存済み音声を削除しました');
});

// ---------- init ----------

renderScriptList();
renderPractice();
updateAbUi();
if (scripts.length > 0) selectScript(scripts[scripts.length - 1].id);
