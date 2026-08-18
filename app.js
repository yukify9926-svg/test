const STORAGE_KEY = 'shadowing-app-scripts';
const SETTINGS_KEY = 'shadowing-app-settings';
const DB_NAME = 'shadowing-audio';
const DB_STORE = 'audio';

let scripts = loadScripts();
let settings = loadSettings();
let currentScriptId = null;
let seeking = false;

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
    return (await dbRequest('readonly', store => store.get(id))) || null;
  } catch {
    return null;
  }
}

async function cachePut(id, arrayBuffer) {
  try {
    await dbRequest('readwrite', store => store.put(arrayBuffer, id));
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
    this.buffer = await this.decode(arrayBuffer);
    this.offset = 0;
  },

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  },

  position() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    const elapsed = (this.ctx.currentTime - this.startedAt) * this.rate;
    const pos = this.offset + elapsed;
    if (this.loop) return pos % this.duration;
    return Math.min(pos, this.duration);
  },

  play() {
    if (!this.buffer) return;
    const ctx = this.unlock();
    this.stopSource();
    if (!this.loop && this.offset >= this.duration - 0.01) this.offset = 0;

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    source.loop = this.loop;
    source.connect(ctx.destination);
    source.onended = () => {
      if (this.source !== source) return; // superseded by a newer source
      this.playing = false;
      this.offset = this.duration;
      this.source = null;
      onPlaybackChanged();
    };
    source.start(0, this.loop ? this.offset % this.duration : this.offset);

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
    const target = Math.max(0, Math.min(seconds, this.duration));
    if (this.playing) {
      this.offset = target;
      this.play();
    } else {
      this.offset = target;
      onPlaybackChanged();
    }
  },

  nudge(delta) {
    this.seek(this.position() + delta);
  },

  setRate(rate) {
    this.rate = rate;
    if (this.playing) {
      this.offset = this.position();
      this.play();
    }
  },

  setLoop(loop) {
    this.loop = loop;
    if (this.playing) {
      this.offset = this.position();
      this.play();
    }
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
}

function tick() {
  if (player.playing) updatePlayerUi();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

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

document.getElementById('script-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = document.getElementById('input-text').value.trim();
  if (!text) return;

  scripts.push({
    id: uid(),
    text,
    note: document.getElementById('input-note').value.trim(),
    tags: document.getElementById('input-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    createdAt: new Date().toISOString(),
    lastPracticed: null,
    practiceCount: 0
  });
  saveScripts();
  e.target.reset();
  renderScriptList();
  toast('追加しました');
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderScriptList() {
  const list = document.getElementById('script-list');
  document.getElementById('script-count').textContent = `(${scripts.length})`;

  if (scripts.length === 0) {
    list.innerHTML = '<p class="hint">まだスクリプトがありません。上のフォームから追加してください。</p>';
    return;
  }

  list.innerHTML = '';
  [...scripts].reverse().forEach(script => {
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
        player.stop();
        player.buffer = null;
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

async function selectScript(id) {
  if (currentScriptId === id) return;
  currentScriptId = id;
  player.stop();
  player.buffer = null;
  renderPractice();
  setStatus('');

  const cached = await cacheGet(id);
  if (!cached || currentScriptId !== id) {
    if (!cached) setStatus('「音声を生成」を押してください');
    return;
  }
  try {
    await player.load(cached.slice(0));
    if (currentScriptId !== id) return;
    setStatus('保存済みの音声を読み込みました');
    onPlaybackChanged();
  } catch {
    setStatus('「音声を生成」を押してください');
  }
}

function setStatus(message) {
  document.getElementById('player-status').textContent = message;
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
  document.getElementById('practice-text').textContent = script.text;
  document.getElementById('practice-note').textContent = script.note || '';
  document.getElementById('practice-stats').textContent =
    `練習回数 ${script.practiceCount}回` +
    (script.lastPracticed ? ` ・ 最終 ${new Date(script.lastPracticed).toLocaleString('ja-JP')}` : '');
  updatePlayerUi();
}

function step(delta) {
  if (scripts.length === 0) return;
  const index = scripts.findIndex(s => s.id === currentScriptId);
  const next = ((index < 0 ? 0 : index + delta) + scripts.length) % scripts.length;
  selectScript(scripts[next].id);
}

document.getElementById('btn-prev').addEventListener('click', () => step(-1));
document.getElementById('btn-next').addEventListener('click', () => step(1));

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
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${settings.voiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': settings.apiKey },
      body: JSON.stringify({
        text: script.text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.detail?.message || body?.detail?.status || '';
      } catch { /* non-JSON error body */ }
      throw new Error(`音声を生成できませんでした (${res.status})${detail ? ': ' + detail : ''}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    if (currentScriptId !== script.id) return;

    await cachePut(script.id, arrayBuffer);
    await player.load(arrayBuffer.slice(0)); // decodeAudioData detaches its input
    setStatus('再生できます');
    player.play();
  } catch (err) {
    setStatus('');
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '音声を生成';
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
      const added = mergeScripts(imported);
      toast(`${added}件を読み込みました`);
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
  const ok = await cacheClear();
  if (ok) {
    player.stop();
    player.buffer = null;
    setStatus('「音声を生成」を押してください');
    toast('保存済み音声を削除しました');
  } else {
    toast('削除できませんでした', 'error');
  }
});

// ---------- init ----------

renderScriptList();
renderPractice();
if (scripts.length > 0) selectScript(scripts[scripts.length - 1].id);
