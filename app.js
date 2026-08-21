const STORAGE_KEY = 'shadowing-app-scripts';
const SETTINGS_KEY = 'shadowing-app-settings';
const DB_NAME = 'shadowing-audio';
const DB_STORE = 'audio';

let scripts = loadScripts();
let settings = loadSettings();
let currentScriptId = null;
let seeking = false;
let filter = '';

// Speech timings for the script currently loaded in the player.
let words = null;      // [{ text, start, end, space }]

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
  const empty = { apiKey: '', voiceId: '', voiceId2: '', claudeKey: '', lookup: 'sentence' };
  try {
    return Object.assign(empty, JSON.parse(localStorage.getItem(SETTINGS_KEY)));
  } catch {
    return empty;
  }
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
    // Older entries hold a single recording: bare ArrayBuffer before word
    // timings existed, then { audio, alignment } before two voices.
    if (value instanceof ArrayBuffer) return { segments: [value], alignment: null };
    if (value.audio) return { segments: [value.audio], alignment: value.alignment || null };
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

// ---------- two voices in one recording ----------
// The speech API gives one voice per request, so a dialogue is generated in
// runs — consecutive lines by the same speaker — and the pieces are joined
// into a single buffer. Playback, seeking and highlighting then treat the
// exchange as the one continuous recording it should have been.

function joinBuffers(ctx, buffers) {
  const channels = Math.max(...buffers.map(b => b.numberOfChannels));
  const length = buffers.reduce((total, b) => total + b.length, 0);
  const joined = ctx.createBuffer(channels, length, buffers[0].sampleRate);

  let offset = 0;
  buffers.forEach(buffer => {
    for (let channel = 0; channel < channels; channel++) {
      const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
      joined.getChannelData(channel).set(source, offset);
    }
    offset += buffer.length;
  });
  return joined;
}

// Each run's timings start again from zero, so they are shifted by the audio
// that plays before them. A newline is inserted between runs because line
// grouping reads them out of the character stream.
function joinAlignments(parts) {
  if (parts.some(part => !part.alignment)) return null;

  const characters = [];
  const starts = [];
  const ends = [];
  let elapsed = 0;

  parts.forEach((part, index) => {
    const { characters: chars, character_start_times_seconds: s, character_end_times_seconds: e } = part.alignment;
    if (index > 0) {
      characters.push('\n');
      starts.push(elapsed);
      ends.push(elapsed);
    }
    chars.forEach((char, i) => {
      characters.push(char);
      starts.push(s[i] + elapsed);
      ends.push(e[i] + elapsed);
    });
    elapsed += part.duration;
  });

  return {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends
  };
}

// Consecutive lines by one speaker become a single request.
function speakerRuns(script) {
  const textLines = script.text.split('\n');
  const speakers = script.speakers;
  if (!speakers || speakers.length !== textLines.length) {
    return [{ text: script.text, voice: settings.voiceId }];
  }

  const cast = [...new Set(speakers)];
  const voices = [settings.voiceId, settings.voiceId2 || settings.voiceId];

  const runs = [];
  textLines.forEach((line, i) => {
    // A third speaker falls back to the first voice; there are only two.
    const voice = voices[Math.min(cast.indexOf(speakers[i]), voices.length - 1)];
    const last = runs[runs.length - 1];
    if (last && last.voice === voice && last.speaker === speakers[i]) last.text += `\n${line}`;
    else runs.push({ text: line, voice, speaker: speakers[i] });
  });
  return runs;
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

  async load(arrayBuffers) {
    const ctx = this.unlock();
    const buffers = [];
    for (const arrayBuffer of arrayBuffers) buffers.push(await this.decode(arrayBuffer));

    this.stop();
    this.ab = null;
    this.buffer = buffers.length === 1 ? buffers[0] : joinBuffers(ctx, buffers);
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

// ---------- sentences ----------
// A line of the script is one sentence (or one turn of a conversation), and it
// is the unit for everything the reader touches: what lights up during
// playback, what a tap seeks to, and what a hold explains.

let lines = [];      // [{ text, translation, start, end }]
let lineSpans = [];
let activeLine = -1;

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

// The spoken text carries the same newlines as the script, so the timings
// group into lines the same way the text does.
function timeLines(tokens) {
  const grouped = [];
  let current = null;
  tokens.forEach(token => {
    if (token.space) {
      if (token.text.includes('\n') && current) { grouped.push(current); current = null; }
      return;
    }
    if (!current) current = { start: token.start, end: token.end };
    current.end = token.end;
  });
  if (current) grouped.push(current);
  return grouped;
}

function renderScriptText(script) {
  const container = el('practice-text');
  if (!container) return;

  const texts = script.text.split('\n');
  const translations = (script.translation || '').split('\n');
  const timed = words ? timeLines(words) : null;
  // Only trust the timings when they describe the same number of lines as the
  // text; otherwise show the script and leave the highlight off.
  const timings = timed && timed.length === texts.length ? timed : null;

  const speakers = script.speakers && script.speakers.length === texts.length ? script.speakers : null;
  const cast = speakers ? [...new Set(speakers)] : [];

  lines = texts.map((text, i) => ({
    text,
    translation: translations[i] || '',
    speaker: speakers ? speakers[i] : null,
    voice: speakers ? Math.min(cast.indexOf(speakers[i]), 1) : 0,
    start: timings ? timings[i].start : null,
    end: timings ? timings[i].end : null
  }));

  container.innerHTML = '';
  lineSpans = [];
  activeLine = -1;

  lines.forEach((line, i) => {
    const span = document.createElement('span');
    span.className = line.speaker ? `line voice-${line.voice + 1}` : 'line';
    span.dataset.line = String(i);
    if (line.speaker) {
      const label = document.createElement('span');
      label.className = 'speaker';
      label.textContent = line.speaker;
      span.appendChild(label);
    }
    span.appendChild(document.createTextNode(line.text));
    container.appendChild(span);
    lineSpans.push(span);
  });

  container.classList.toggle('has-timings', !!timings);
  container.classList.toggle('native-lookup', settings.lookup === 'native');
}

function findLine(position) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.start === null) continue;
    if (position >= line.start && position <= line.end) return i;
  }
  return -1;
}

function updateHighlight(position) {
  if (!lines.length) return;
  const index = findLine(position);
  if (index === activeLine) return;
  if (lineSpans[activeLine]) lineSpans[activeLine].classList.remove('active');

  const span = lineSpans[index];
  if (span) {
    span.classList.add('active');
    // A passage long enough to scroll would otherwise leave the reader
    // following audio they can no longer see.
    if (player.playing) span.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  activeLine = index;
}

// Tap a sentence to start there; hold it for the translation. The hold must not
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
  const span = e.target.closest('.line');
  longPressFired = false;
  // Under the system lookup the hold belongs to iOS: intercepting it here
  // would stop the selection that raises 調べる and 翻訳.
  if (!span || settings.lookup === 'native') return;
  pressOrigin = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longPressFired = true;
    openSheet(Number(span.dataset.line));
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
  if (e.target.closest('.line') && settings.lookup !== 'native') e.preventDefault();
});

on('practice-text', 'click', e => {
  const span = e.target.closest('.line');
  if (!span || longPressFired) return;
  // A tap that lands on a selection is the user dismissing it, not a seek.
  if (settings.lookup === 'native' && !window.getSelection().isCollapsed) return;
  const line = lines[Number(span.dataset.line)];
  if (!line || line.start === null) return;
  player.seek(line.start);
  if (!player.playing) player.play();
});

// ---------- sentence sheet ----------

let sheetLine = -1;

function closeSheet() {
  setHidden('vocab-sheet', true);
  setHidden('sheet-backdrop', true);
  sheetLine = -1;
}

on('vocab-close', 'click', closeSheet);
on('sheet-backdrop', 'click', closeSheet);

function renderSheet() {
  const line = lines[sheetLine];
  if (!line) return;

  // The English is left selectable so iOS's own 調べる and 翻訳 stay reachable
  // for a single word, even while a hold on the script opens this sheet.
  let body = line.speaker ? `<p class="sheet-speaker">${escapeHtml(line.speaker)}</p>` : '';
  body += `<p class="sheet-en">${escapeHtml(line.text)}</p>`;

  if (line.translation) {
    body += `<p class="sheet-ja">${escapeHtml(line.translation)}</p>`;
  } else if (settings.claudeKey) {
    body += '<p class="sheet-note">和訳が登録されていません。</p>' +
      '<button id="btn-translate-line" class="panel-btn">この文の和訳を生成</button>';
  } else {
    body += '<p class="sheet-note">和訳が登録されていません。スクリプト追加時に和訳を書くか、設定でAnthropic API Keyを入力すると生成できます。</p>';
  }

  setVocabBody(body);
  on('btn-translate-line', 'click', translateLine);
}

function openSheet(index) {
  const sheet = el('vocab-sheet');
  if (!sheet || !lines[index]) return;
  sheetLine = index;
  setText('vocab-word', `${index + 1} / ${lines.length}`);
  sheet.hidden = false;
  setHidden('sheet-backdrop', false);
  renderSheet();
}

async function translateLine() {
  const script = getCurrentScript();
  const line = lines[sheetLine];
  if (!script || !line) return;

  const index = sheetLine;
  setVocabBody(`<p class="sheet-en">${escapeHtml(line.text)}</p><p class="sheet-note">翻訳中…</p>`);
  try {
    const { translation } = await fetchTranslation(line.text);
    line.translation = translation;
    const parts = (script.translation || '').split('\n');
    while (parts.length < lines.length) parts.push('');
    parts[index] = translation;
    script.translation = parts.join('\n');
    saveScripts();
    if (sheetLine === index) renderSheet();
  } catch (err) {
    setVocabBody(`<p class="sheet-en">${escapeHtml(line.text)}</p><p class="sheet-note">${escapeHtml(err.message)}</p>`);
  }
}

function setVocabBody(html) {
  const body = el('vocab-body');
  if (body) body.innerHTML = html;
}

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

// A blank line ends a block. Within one, English lines and Japanese lines are
// collected in order and matched up by position, so the two arrangements people
// write — alternating line by line, or all the English then all the Japanese —
// both land the same way and neither has to be detected.
// `A: Hello` — the label is short, sits before the first colon, and may be
// wrapped in markdown emphasis. Only accepted when every English line in the
// block carries one, since a lone colon is far more likely to be punctuation
// inside a sentence than a speaker.
// Emphasis is allowed on either side of the colon, since `**A:**` puts its
// closing pair after it and those asterisks would otherwise be read aloud.
const SPEAKER_RE = /^[*_]{0,2}\s*([^:：*_\n]{1,24}?)\s*[*_]{0,2}\s*[:：][*_]{0,2}\s*(\S.*)$/;
const LIST_MARKER_RE = /^\s*(?:[-*+•]|\d+[.)])\s+/;

function splitSpeaker(line) {
  const match = line.replace(LIST_MARKER_RE, '').match(SPEAKER_RE);
  return match ? { speaker: match[1].trim(), text: match[2].trim() } : { speaker: null, text: line };
}

function parseBlock(block) {
  const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
  const english = lines.filter(line => !isJapanese(line));
  const japanese = lines.filter(isJapanese);

  const parsed = english.map(splitSpeaker);
  const labelled = parsed.length > 0 && parsed.every(part => part.speaker);
  // Some but not all is the mistake worth reporting: the item silently reads
  // in one voice, and nothing on screen says why.
  const partlyLabelled = !labelled && parsed.some(part => part.speaker);

  return {
    // Labels are stripped from what gets stored: they would be read aloud.
    english: labelled ? parsed.map(part => part.text) : english,
    japanese: labelled ? japanese.map(line => splitSpeaker(line).text) : japanese,
    speakers: labelled ? parsed.map(part => part.speaker) : null,
    partlyLabelled,
    startsJapanese: lines.length > 0 && isJapanese(lines[0])
  };
}

function parseBlocks(text) {
  return text
    .split(/\n[ \t]*\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(parseBlock)
    .filter(block => block.english.length || block.japanese.length);
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

  const blocks = parseBlocks(raw);
  if (!blocks.length) return;
  if (blocks.some(block => block.startsJapanese)) {
    toast('各ブロックは英文から始めてください。和訳は英文の次の行に書きます', 'error');
    return;
  }


  const unit = getValue('input-unit') || 'block';
  const parts = [];

  for (const block of blocks) {
    // A block kept whole is what makes a conversation practisable in one run:
    // its turns stay in one item, so one recording carries the exchange.
    if (unit === 'block') {
      parts.push({
        text: block.english.join('\n'),
        translation: block.japanese.join('\n'),
        speakers: block.speakers
      });
      continue;
    }

    if (block.japanese.length && block.japanese.length !== block.english.length) {
      toast(`英文${block.english.length}行に対し和訳${block.japanese.length}行で数が合いません`, 'error');
      return;
    }

    for (let i = 0; i < block.english.length; i++) {
      const speaker = block.speakers ? [block.speakers[i]] : null;
      const line = { text: block.english[i], translation: block.japanese[i] || '', speakers: speaker };
      if (unit === 'line') {
        parts.push(line);
        continue;
      }
      const paired = pairScripts(line.text, line.translation);
      if (paired.mismatch) {
        toast(`英文${paired.mismatch.en}文に対し和訳${paired.mismatch.ja}文で数が合いません`, 'error');
        return;
      }
      parts.push(...paired);
    }
  }

  if (!parts.length) return;

  parts.forEach(part => {
    scripts.push({
      id: uid(),
      text: part.text,
      translation: part.translation || '',
      speakers: part.speakers || null,
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

  // A warning has to be the last thing said, or the success message buries it.
  if (blocks.some(block => block.partlyLabelled)) {
    toast('話者名が一部の行にしかないため、声は出し分けません。全ての英文行に付けてください', 'error');
  } else {
    toast(parts.length === 1 ? '追加しました' : `${parts.length}件に分けて追加しました`);
  }
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
  lines = [];
  lineSpans = [];
  activeLine = -1;
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
    await player.load(cached.segments.map(buffer => buffer.slice(0)));
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
  setHidden('script-hint', false);
  setText('script-hint', settings.lookup === 'native'
    ? '文をタップで頭出し・長押しで「調べる」「翻訳」'
    : '文をタップで頭出し・長押しで和訳');
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

async function speak(text, voice) {
  // with-timestamps also returns per-character timings, used for highlighting.
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': settings.apiKey },
      body: JSON.stringify({
        text,
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
  return {
    audio: base64ToArrayBuffer(payload.audio_base64),
    alignment: payload.alignment || payload.normalized_alignment || null
  };
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

  const btn = el('btn-generate');
  btn.disabled = true;
  btn.textContent = '生成中...';

  const runs = speakerRuns(script);
  const voices = new Set(runs.map(run => run.voice));
  // Which voices a script ends up using is otherwise invisible until it plays,
  // and by then it is too late to notice a label or a setting was missing.
  if (script.speakers && !settings.voiceId2) {
    toast('2人目のVoice IDが未設定のため、すべて同じ声で生成します');
  } else if (script.speakers && voices.size === 1) {
    toast('話者1と話者2のVoice IDが同じです', 'error');
  } else if (!script.speakers && settings.voiceId2) {
    toast('このスクリプトに話者名がないため、1つの声で生成します');
  }

  try {
    const parts = [];
    for (let i = 0; i < runs.length; i++) {
      setStatus(runs.length > 1 ? `音声を生成しています (${i + 1}/${runs.length})` : '音声を生成しています');
      const part = await speak(runs[i].text, runs[i].voice);
      if (currentScriptId !== script.id) return;
      // The duration each run occupies is needed to shift the next one's
      // timings, and only decoding gives it.
      const decoded = await player.decode(part.audio.slice(0));
      parts.push({ ...part, duration: decoded.duration });
    }

    const alignment = joinAlignments(parts);
    const segments = parts.map(part => part.audio);

    await cachePut(script.id, { segments, alignment });
    await player.load(segments.map(buffer => buffer.slice(0))); // decode detaches
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
setValue('input-voice-id-2', settings.voiceId2 || '');
setValue('input-claude-key', settings.claudeKey || '');
setValue('input-lookup', settings.lookup || 'sentence');

on('settings-form', 'submit', e => {
  e.preventDefault();
  settings.apiKey = getValue('input-api-key').trim();
  settings.voiceId = getValue('input-voice-id').trim();
  settings.voiceId2 = getValue('input-voice-id-2').trim();
  settings.claudeKey = getValue('input-claude-key').trim();
  settings.lookup = getValue('input-lookup') || 'sentence';
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
