const STORAGE_KEY = 'shadowing-app-scripts';
const SETTINGS_KEY = 'shadowing-app-settings';

let scripts = loadScripts();
let settings = loadSettings();
let currentScriptId = null;
let audioBlobUrls = {};

function loadScripts() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
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

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'practice') renderPractice();
}

// --- Script list ---
document.getElementById('script-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = document.getElementById('input-text').value.trim();
  const note = document.getElementById('input-note').value.trim();
  const tags = document.getElementById('input-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  if (!text) return;

  scripts.push({
    id: uid(),
    text,
    note,
    tags,
    createdAt: new Date().toISOString(),
    lastPracticed: null,
    practiceCount: 0
  });
  saveScripts();
  e.target.reset();
  renderScriptList();
});

function renderScriptList() {
  const list = document.getElementById('script-list');
  document.getElementById('script-count').textContent = `(${scripts.length})`;
  if (scripts.length === 0) {
    list.innerHTML = '<p class="hint">まだスクリプトがありません。上のフォームから追加してください。</p>';
    return;
  }
  list.innerHTML = '';
  [...scripts].reverse().forEach(s => {
    const card = document.createElement('div');
    card.className = 'script-card';
    card.innerHTML = `
      <p>${escapeHtml(s.text)}</p>
      ${s.note ? `<p class="note">${escapeHtml(s.note)}</p>` : ''}
      ${s.tags.length ? `<div class="tags">${s.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <p class="meta">練習回数: ${s.practiceCount}回${s.lastPracticed ? ' / 最終練習: ' + new Date(s.lastPracticed).toLocaleDateString('ja-JP') : ' / 未練習'}</p>
      <div class="card-actions">
        <button class="practice-this">練習する</button>
        <button class="secondary delete-this">削除</button>
      </div>
    `;
    card.querySelector('.practice-this').addEventListener('click', () => {
      currentScriptId = s.id;
      switchTab('practice');
    });
    card.querySelector('.delete-this').addEventListener('click', () => {
      if (!confirm('このスクリプトを削除しますか?')) return;
      scripts = scripts.filter(x => x.id !== s.id);
      saveScripts();
      renderScriptList();
    });
    list.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Practice ---
document.getElementById('btn-next-due').addEventListener('click', () => {
  if (scripts.length === 0) return;
  const sorted = [...scripts].sort((a, b) => {
    if (!a.lastPracticed && !b.lastPracticed) return 0;
    if (!a.lastPracticed) return -1;
    if (!b.lastPracticed) return 1;
    return new Date(a.lastPracticed) - new Date(b.lastPracticed);
  });
  currentScriptId = sorted[0].id;
  renderPractice();
});

function getCurrentScript() {
  return scripts.find(s => s.id === currentScriptId) || null;
}

function renderPractice() {
  const script = getCurrentScript();
  const empty = document.getElementById('practice-empty');
  const body = document.getElementById('practice-body');
  const meta = document.getElementById('practice-meta');

  if (!script) {
    empty.hidden = false;
    body.hidden = true;
    meta.textContent = '';
    return;
  }

  empty.hidden = true;
  body.hidden = false;
  meta.textContent = `全 ${scripts.length} 件`;

  document.getElementById('practice-text').textContent = script.text;
  document.getElementById('practice-note').textContent = script.note || '';
  document.getElementById('practice-stats').textContent =
    `練習回数: ${script.practiceCount}回${script.lastPracticed ? ' / 最終練習: ' + new Date(script.lastPracticed).toLocaleString('ja-JP') : ''}`;

  const player = document.getElementById('audio-player');
  if (audioBlobUrls[script.id]) {
    player.src = audioBlobUrls[script.id];
  } else {
    player.removeAttribute('src');
  }
  player.playbackRate = parseFloat(document.getElementById('speed-range').value);
}

document.getElementById('btn-generate').addEventListener('click', async () => {
  const script = getCurrentScript();
  if (!script) return;
  if (!settings.apiKey || !settings.voiceId) {
    alert('先に「設定」タブでElevenLabsのAPIキーとVoice IDを入力してください。');
    switchTab('settings');
    return;
  }

  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.textContent = '生成中...';

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${settings.voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': settings.apiKey
      },
      body: JSON.stringify({
        text: script.text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`ElevenLabs API エラー (${res.status}): ${errText}`);
    }

    const blob = await res.blob();
    if (audioBlobUrls[script.id]) URL.revokeObjectURL(audioBlobUrls[script.id]);
    audioBlobUrls[script.id] = URL.createObjectURL(blob);

    const player = document.getElementById('audio-player');
    player.src = audioBlobUrls[script.id];
    player.playbackRate = parseFloat(document.getElementById('speed-range').value);
    player.play();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '音声を生成';
  }
});

document.getElementById('speed-range').addEventListener('input', e => {
  const rate = parseFloat(e.target.value);
  document.getElementById('speed-value').textContent = `${rate.toFixed(2)}x`;
  document.getElementById('audio-player').playbackRate = rate;
});

document.getElementById('loop-toggle').addEventListener('change', e => {
  document.getElementById('audio-player').loop = e.target.checked;
});

document.getElementById('btn-mark-practiced').addEventListener('click', () => {
  const script = getCurrentScript();
  if (!script) return;
  script.practiceCount += 1;
  script.lastPracticed = new Date().toISOString();
  saveScripts();
  renderPractice();
  renderScriptList();
});

// --- Settings ---
function fillSettingsForm() {
  document.getElementById('input-api-key').value = settings.apiKey || '';
  document.getElementById('input-voice-id').value = settings.voiceId || '';
}

document.getElementById('settings-form').addEventListener('submit', e => {
  e.preventDefault();
  settings.apiKey = document.getElementById('input-api-key').value.trim();
  settings.voiceId = document.getElementById('input-voice-id').value.trim();
  saveSettings();
  alert('設定を保存しました。');
});

// --- Import / Export ---
document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(scripts, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scripts.json';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('input-import').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('不正な形式です');
      const existingIds = new Set(scripts.map(s => s.id));
      const merged = scripts.concat(imported.filter(s => s && s.id && !existingIds.has(s.id)));
      scripts = merged;
      saveScripts();
      renderScriptList();
      alert(`${imported.length}件を読み込みました。`);
    } catch (err) {
      alert('JSONの読み込みに失敗しました: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('btn-load-sample').addEventListener('click', async () => {
  try {
    const res = await fetch('data/scripts.sample.json');
    if (!res.ok) throw new Error('サンプルデータの取得に失敗しました');
    const sample = await res.json();
    const existingIds = new Set(scripts.map(s => s.id));
    scripts = scripts.concat(sample.filter(s => !existingIds.has(s.id)));
    saveScripts();
    renderScriptList();
    alert(`${sample.length}件のサンプルを読み込みました。`);
  } catch (err) {
    alert(err.message);
  }
});

// --- Init ---
renderScriptList();
fillSettingsForm();
