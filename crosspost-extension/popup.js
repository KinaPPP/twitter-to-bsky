/**
 * popup.js — 設定の読み込み・保存・Threads トークン更新・catbox.moe 接続テスト
 */

const $ = (id) => document.getElementById(id);

// manifest.json からバージョンを動的取得
const _mv = chrome.runtime.getManifest().version;
document.addEventListener('DOMContentLoaded', () => {
  const badge = $('version-badge');
  if (badge) badge.textContent = `v${_mv}`;
});

const TOKEN_LIFETIME_DAYS = 60;
const WARN_DAYS           = 14;
const DANGER_DAYS         = 7;

// ----------------------------------------------------------------
//  background.js 経由の fetch
// ----------------------------------------------------------------
const bgFetch = (params) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type: 'FETCH', ...params }, (resp) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!resp) return reject(new Error('background からの応答がありません'));
    resolve(resp);
  });
});

// ----------------------------------------------------------------
//  有効期限 UI
// ----------------------------------------------------------------
function updateExpiryUI(issuedAt, token) {
  const dot        = $('expiry-dot');
  const text       = $('expiry-text');
  const progressW  = $('progress-wrap');
  const fill       = $('progress-fill');
  const refreshBtn = $('refresh-btn');

  if (!token) {
    dot.className = 'expiry-dot'; text.className = 'expiry-text';
    text.textContent = 'トークン未設定';
    progressW.style.display = 'none'; refreshBtn.disabled = true; return;
  }
  refreshBtn.disabled = false;

  if (!issuedAt) {
    dot.className = 'expiry-dot warn'; text.className = 'expiry-text warn';
    text.textContent = 'トークン取得済み（期限不明）';
    progressW.style.display = 'none'; return;
  }

  const issued   = new Date(issuedAt);
  const expiry   = new Date(issued.getTime() + TOKEN_LIFETIME_DAYS * 86400000);
  const msLeft   = expiry - new Date();
  const daysLeft = Math.ceil(msLeft / 86400000);
  const pct      = Math.max(0, Math.min(100, (msLeft / (TOKEN_LIFETIME_DAYS * 86400000)) * 100));

  progressW.style.display = '';

  if (daysLeft <= 0) {
    dot.className = 'expiry-dot expired'; text.className = 'expiry-text expired';
    text.textContent = '⚠ トークン期限切れ — 更新してください';
    fill.style.cssText = 'width:0%;background:var(--danger)';
  } else if (daysLeft <= DANGER_DAYS) {
    dot.className = 'expiry-dot danger'; text.className = 'expiry-text danger';
    text.textContent = `残り ${daysLeft} 日 — 今すぐ更新してください`;
    fill.style.cssText = `width:${pct}%;background:var(--danger)`;
  } else if (daysLeft <= WARN_DAYS) {
    dot.className = 'expiry-dot warn'; text.className = 'expiry-text warn';
    text.textContent = `残り ${daysLeft} 日 — まもなく期限切れ`;
    fill.style.cssText = `width:${pct}%;background:var(--warning)`;
  } else {
    dot.className = 'expiry-dot ok'; text.className = 'expiry-text ok';
    text.textContent = `残り ${daysLeft} 日（${expiry.toLocaleDateString('ja-JP')} まで）`;
    fill.style.cssText = `width:${pct}%;background:var(--success)`;
  }
}

// ----------------------------------------------------------------
//  設定ロード
// ----------------------------------------------------------------
chrome.storage.sync.get({
  bsky_handle:                 '',
  bsky_app_password:           '',
  bsky_crosspost_checked:      false,
  bsky_visible:                true,
  uploader:                    'catbox',
  litterbox_time:              '24h',
  mastodon_instance_url:       'https://mastodon.social',
  mastodon_api_key:            '',
  mastodon_crosspost_checked:  false,
  mastodon_visible:            true,
  threads_access_token:        '',
  threads_user_id:             '',
  threads_crosspost_checked:   false,
  threads_token_issued_at:     '',
  threads_visible:             true,
  alt_shortcuts_enabled:       true,
}, (items) => {
  $('bh').value    = items.bsky_handle;
  $('bp').value    = items.bsky_app_password;
  $('bd').checked  = items.bsky_crosspost_checked;
  $('mu').value    = items.mastodon_instance_url;
  $('mk').value    = items.mastodon_api_key;
  $('md').checked  = items.mastodon_crosspost_checked;
  $('tt').value    = items.threads_access_token;
  $('tu').value    = items.threads_user_id;
  $('tdf').checked = items.threads_crosspost_checked;
  $('bv').checked  = items.bsky_visible;
  // アップローダー設定
  const ulRadio = document.querySelector(`input[name="uploader"][value="${items.uploader}"]`);
  if (ulRadio) ulRadio.checked = true;
  $('litterbox-time').value = items.litterbox_time;
  $('litterbox-opts').style.display = items.uploader === 'litterbox' ? '' : 'none';
  $('mv').checked  = items.mastodon_visible;
  $('tv').checked  = items.threads_visible;
  // Alt+0〜3 ショートカット設定
  const altEnabled = items.alt_shortcuts_enabled;
  $('alt-sc-enabled').checked = altEnabled;
  $('alt-sc-block').classList.toggle('disabled', !altEnabled);
  updateExpiryUI(items.threads_token_issued_at, items.threads_access_token);
});

$('tt').addEventListener('input', () => updateExpiryUI('', $('tt').value.trim() || null));

// アップローダー切り替え
document.querySelectorAll('input[name="uploader"]').forEach(r => {
  r.addEventListener('change', () => {
    $('litterbox-opts').style.display = r.value === 'litterbox' ? '' : 'none';
  });
});

// Alt+0〜3 ショートカット切り替え（即時UIフィードバック）
$('alt-sc-enabled').addEventListener('change', () => {
  $('alt-sc-block').classList.toggle('disabled', !$('alt-sc-enabled').checked);
});

// ----------------------------------------------------------------
//  catbox.moe 接続テスト
//  1x1px の最小 JPEG を実際にアップロードして URL が返るか確認する
// ----------------------------------------------------------------
$('catbox-test-btn').addEventListener('click', async () => {
  const btn      = $('catbox-test-btn');
  const resultEl = $('catbox-test-result');

  btn.disabled     = true;
  btn.textContent  = '確認中…';
  resultEl.textContent = '';
  resultEl.className   = 'test-result';

  try {
    // 最小 JPEG (1x1px, 白) を Base64 で用意
    const TINY_JPEG_B64 =
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
      'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
      'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
      'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEA//EAB8QAA' +
      'ICAgMBAQAAAAAAAAAAAAECAwQREiExBf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEA' +
      'AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABtttoA//9k=';

    const resp = await bgFetch({
      url:      'https://catbox.moe/user/api.php',
      method:   'POST',
      headers:  {},
      body: {
        reqtype:      'fileupload',
        fileToUpload: { __type: 'blob', data: TINY_JPEG_B64, mimeType: 'image/jpeg', filename: 'test.jpg' },
      },
      bodyType: 'formdata',
    });

    const url = (resp.text || resp.data || '').toString().trim();
    if (url.startsWith('https://files.catbox.moe/')) {
      resultEl.textContent = `✓ 接続成功 — ${url}`;
      resultEl.className   = 'test-result success';
    } else {
      throw new Error(url || 'レスポンスなし');
    }
  } catch (err) {
    resultEl.textContent = `✕ 失敗: ${err.message}`;
    resultEl.className   = 'test-result error';
  } finally {
    btn.disabled    = false;
    btn.textContent = '📡 接続テスト';
  }
});

// ----------------------------------------------------------------
//  Threads トークン更新
// ----------------------------------------------------------------
$('refresh-btn').addEventListener('click', async () => {
  const token = $('tt').value.trim();
  if (!token) { showRefreshResult('error', 'まずアクセストークンを入力してください'); return; }

  const btn = $('refresh-btn');
  btn.disabled = true; btn.classList.add('loading');
  showRefreshResult('', '更新中…');

  try {
    const resp = await bgFetch({
      url:    `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`,
      method: 'GET',
    });

    if (!resp.ok || resp.data?.error) {
      throw new Error(resp.data?.error?.message || resp.data?.error_description || resp.error || `HTTP ${resp.status}`);
    }
    const newToken = resp.data?.access_token;
    if (!newToken) throw new Error('レスポンスにトークンが含まれていません');

    $('tt').value = newToken;
    const issuedAt = new Date().toISOString();
    await new Promise(resolve => chrome.storage.sync.set({ threads_access_token: newToken, threads_token_issued_at: issuedAt }, resolve));
    updateExpiryUI(issuedAt, newToken);

    const days = resp.data?.expires_in ? Math.round(resp.data.expires_in / 86400) : TOKEN_LIFETIME_DAYS;
    showRefreshResult('success', `✓ 更新成功 — 新しい有効期限: ${days} 日`);
  } catch (err) {
    console.error('[Threads Token Refresh]', err);
    showRefreshResult('error', '✕ 更新失敗: ' + err.message);
  } finally {
    btn.disabled = false; btn.classList.remove('loading');
  }
});

function showRefreshResult(type, msg) {
  const el = $('refresh-result');
  el.textContent = msg;
  el.className   = 'refresh-result' + (type ? ' ' + type : '');
}

// ----------------------------------------------------------------
//  保存
// ----------------------------------------------------------------
$('sv').addEventListener('click', () => {
  const token = $('tt').value.trim();
  chrome.storage.sync.get({ threads_access_token: '', threads_token_issued_at: '' }, (prev) => {
    const isNewToken = token && token !== prev.threads_access_token;
    chrome.storage.sync.set({
      bsky_handle:                 $('bh').value.trim(),
      bsky_app_password:           $('bp').value.trim(),
      bsky_crosspost_checked:      $('bd').checked,
      mastodon_instance_url:       $('mu').value.trim().replace(/\/$/, ''),
      mastodon_api_key:            $('mk').value.trim(),
      mastodon_crosspost_checked:  $('md').checked,
      threads_access_token:        token,
      threads_user_id:             $('tu').value.trim(),
      threads_crosspost_checked:   $('tdf').checked,
      threads_token_issued_at:     isNewToken ? new Date().toISOString() : prev.threads_token_issued_at,
      bsky_visible:                $('bv').checked,
      uploader:                    document.querySelector('input[name="uploader"]:checked')?.value || 'catbox',
      litterbox_time:              $('litterbox-time').value,
      mastodon_visible:            $('mv').checked,
      threads_visible:             $('tv').checked,
      alt_shortcuts_enabled:       $('alt-sc-enabled').checked,
    }, () => {
      const msg = $('status');
      msg.textContent = '✓ 保存しました';
      setTimeout(() => { window.close(); }, 800);
      chrome.storage.sync.get(['threads_token_issued_at', 'threads_access_token'], (s) => {
        updateExpiryUI(s.threads_token_issued_at, s.threads_access_token);
      });
      // Twitter/X タブをリロードして設定を即反映
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab && /^https:\/\/(twitter|x)\.com/.test(tab.url)) {
          chrome.tabs.reload(tab.id);
        }
      });
    });
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('sv').click();
});
