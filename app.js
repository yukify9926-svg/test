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
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || { apiKey: '', voiceId: '' };
  } catch {
    return { apiKey: '', voiceId: '' };
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
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = kind === 'error' ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 2600);
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
  document.getElementById('btn-playpause').textContent = player.playing ? '❚❚' : '▶';
  updatePlayerUi();
}

function updatePlayerUi() {
  const duration = player.duration;
  const position = player.position();
  document.getElementById('time-current').textContent = formatTime(position);
  document.getElementById('time-total').textContent = formatTime(duration);
  if (!seeking) {
    document.getElementById('seek').value = duration ? Math.round((position / duration) * 1000) : 0;
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
  const el = document.getElementById('practice-text');
  el.innerHTML = '';
  wordSpans = [];
  activeWord = -1;

  if (!words) {
    el.textContent = script.text;
    el.classList.remove('has-words');
    return;
  }

  el.classList.add('has-words');
  words.forEach((word, index) => {
    if (word.space) {
      el.appendChild(document.createTextNode(word.text));
      wordSpans.push(null);
      return;
    }
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = word.text;
    span.dataset.index = String(index);
    el.appendChild(span);
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

document.getElementById('practice-text').addEventListener('click', e => {
  const span = e.target.closest('.word');
  if (!span || !words) return;
  const word = words[Number(span.dataset.index)];
  if (!word) return;
  player.seek(word.start);
  if (!player.playing) player.play();
});

// ---------- tabs ----------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'practice') renderPractice();
  window.scrollTo(0, 0);
}

document.getElementById('btn-goto-list').addEventListener('click', () => switchTab('list'));

// ---------- script list ----------

function splitSentences(text) {
  const out = [];
  const re = /[^.!?…]+[.!?…]*["')\]]*\s*/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const sentence = match[0].trim();
    if (sentence) out.push(sentence);
  }
  return out.length ? out : [text.trim()];
}

document.getElementById('script-form').addEventListener('submit', e => {
  e.preventDefault();
  const raw = document.getElementById('input-text').value.trim();
  if (!raw) return;

  const note = document.getElementById('input-note').value.trim();
  const tags = document.getElementById('input-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const parts = document.getElementById('input-split').checked ? splitSentences(raw) : [raw];

  parts.forEach(text => {
    scripts.push({
      id: uid(),
      text,
      note: parts.length === 1 ? note : '',
      tags,
      createdAt: new Date().toISOString(),
      lastPracticed: null,
      practiceCount: 0
    });
  });

  saveScripts();
  document.getElementById('input-text').value = '';
  document.getElementById('input-note').value = '';
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

document.getElementById('search-input').addEventListener('input', e => {
  filter = e.target.value.trim().toLowerCase();
  renderScriptList();
});

function renderScriptList() {
  const list = document.getElementById('script-list');
  document.getElementById('script-count').textContent = `(${scripts.length})`;

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
  document.getElementById('player-status').textContent = message;
}

// The generate button doubles as the way to re-make audio that predates
// word timings, so its label follows what the current script already has.
function updateGenerateButton() {
  const btn = document.getElementById('btn-generate');
  if (!player.buffer) btn.textContent = '音声を生成';
  else if (words) btn.textContent = '音声を作り直す';
  else btn.textContent = 'ハイライト付きで作り直す';
}

function renderPractice() {
  const script = getCurrentScript();
  const empty = document.getElementById('practice-empty');
  const body = document.getElementById('practice-body');

  if (!script) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }

  empty.hidden = true;
  body.hidden = false;

  const index = scripts.findIndex(s => s.id === script.id);
  document.getElementById('practice-position').textContent = `${index + 1} / ${scripts.length}`;
  renderScriptText(script);
  document.getElementById('practice-note').textContent = script.note || '';
  document.getElementById('practice-stats').textContent =
    `練習回数 ${script.practiceCount}回` +
    (script.lastPracticed ? ` ・ 最終 ${new Date(script.lastPracticed).toLocaleString('ja-JP')}` : '');
  updatePlayerUi();
  updateGenerateButton();
}

function step(delta) {
  if (scripts.length === 0) return;
  const index = scripts.findIndex(s => s.id === currentScriptId);
  const next = ((index < 0 ? 0 : index + delta) + scripts.length) % scripts.length;
  selectScript(scripts[next].id);
}

document.getElementById('btn-prev').addEventListener('click', () => step(-1));
document.getElementById('btn-next').addEventListener('click', () => step(1));

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

document.getElementById('btn-generate').addEventListener('click', async () => {
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

document.getElementById('btn-playpause').addEventListener('click', () => {
  if (!player.buffer) {
    toast('先に「音声を生成」を押してください');
    return;
  }
  if (player.playing) player.pause();
  else player.play();
});

document.getElementById('btn-rewind').addEventListener('click', () => player.nudge(-5));
document.getElementById('btn-forward').addEventListener('click', () => player.nudge(5));

const seek = document.getElementById('seek');
['pointerdown', 'touchstart'].forEach(type => seek.addEventListener(type, () => { seeking = true; }));
seek.addEventListener('input', () => {
  seeking = true;
  document.getElementById('time-current').textContent = formatTime((seek.value / 1000) * player.duration);
});
seek.addEventListener('change', () => {
  player.seek((seek.value / 1000) * player.duration);
  seeking = false;
});

const speedRange = document.getElementById('speed-range');
speedRange.addEventListener('input', () => {
  document.getElementById('speed-value').textContent = `${parseFloat(speedRange.value).toFixed(2)}x`;
});
speedRange.addEventListener('change', () => player.setRate(parseFloat(speedRange.value)));

document.getElementById('loop-toggle').addEventListener('change', e => player.setLoop(e.target.checked));

// ---------- A-B repeat ----------

let abStart = null;

function updateAbUi() {
  const btn = document.getElementById('btn-ab');
  const clear = document.getElementById('btn-ab-clear');
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

document.getElementById('btn-ab').addEventListener('click', () => {
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

document.getElementById('btn-ab-clear').addEventListener('click', () => {
  abStart = null;
  player.setAb(null);
  updateAbUi();
  toast('区間リピートを解除しました');
});

document.getElementById('btn-mark-practiced').addEventListener('click', () => {
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

document.getElementById('input-api-key').value = settings.apiKey || '';
document.getElementById('input-voice-id').value = settings.voiceId || '';

document.getElementById('settings-form').addEventListener('submit', e => {
  e.preventDefault();
  settings.apiKey = document.getElementById('input-api-key').value.trim();
  settings.voiceId = document.getElementById('input-voice-id').value.trim();
  saveSettings();
  document.activeElement?.blur();
  toast('設定を保存しました');
});

// ---------- import / export ----------

document.getElementById('btn-export').addEventListener('click', () => {
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

document.getElementById('input-import').addEventListener('change', e => {
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

document.getElementById('btn-load-sample').addEventListener('click', async () => {
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

document.getElementById('btn-clear-audio').addEventListener('click', async () => {
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
