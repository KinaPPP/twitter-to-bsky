/**
 * background.js — Service Worker (MV3)
 *
 * 2種類の通信方式を提供:
 *
 * 1. sendMessage  → popup.js からの短命リクエスト用
 *    popup ページからの fetch は Origin: chrome-extension://... が付いて
 *    外部 API にブロックされるため、background 経由で行う。
 *
 * 2. connect() ポート → content.js からの長時間リクエスト用
 *    Bluesky/Mastodon/Threads への投稿は複数の API 呼び出しを連続するため、
 *    ポート接続で Service Worker を生存させながら処理する。
 */

// ----------------------------------------------------------------
//  sendMessage ハンドラー（popup.js 用）
// ----------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'FETCH') return false;
  handleFetch(message)
    .then(result => sendResponse(result))
    .catch(err   => sendResponse({ ok: false, error: err.message }));
  return true; // 非同期レスポンスのために必須
});

// ----------------------------------------------------------------
//  ポート接続ハンドラー（content.js 用）
// ----------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'crosspost-fetch') return;

  port.onMessage.addListener(async (message) => {
    if (message.type !== 'FETCH') return;
    try {
      const result = await handleFetch(message);
      port.postMessage({ id: message.id, ...result });
    } catch (err) {
      console.error('[Crosspost BG Error]', err);
      port.postMessage({ id: message.id, ok: false, error: err.message });
    }
  });
});

// ----------------------------------------------------------------
//  fetch 実行（共通）
// ----------------------------------------------------------------
async function handleFetch({ url, method = 'GET', headers = {}, body, bodyType, responseType }) {
  let fetchBody;
  let finalHeaders = { ...headers };

  if (body) {
    if (bodyType === 'base64') {
      fetchBody = base64ToArrayBuffer(body);
    } else if (bodyType === 'formdata') {
      const fd = new FormData();
      for (const [key, val] of Object.entries(body)) {
        if (val?.__type === 'blob') {
          const buf = base64ToArrayBuffer(val.data);
          fd.append(key, new Blob([buf], { type: val.mimeType }), val.filename || 'file');
        } else {
          fd.append(key, val);
        }
      }
      fetchBody = fd;
      // FormData の場合は Content-Type を fetch に自動設定させる
      delete finalHeaders['Content-Type'];
    } else {
      fetchBody = body;
    }
  }

  const response = await fetch(url, { method, headers: finalHeaders, body: fetchBody });
  const contentType = response.headers.get('Content-Type') || '';

  if (responseType === 'binary' || responseType === 'blob') {
    const buffer = await response.arrayBuffer();
    return {
      ok:       response.ok,
      status:   response.status,
      base64:   arrayBufferToBase64(buffer),
      mimeType: contentType.split(';')[0].trim(),
    };
  }

  // JSON レスポンス
  if (contentType.includes('application/json')) {
    const data = await response.json();
    return { ok: response.ok, status: response.status, data };
  }

  // テキスト（JSON パース試行）
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: response.ok, status: response.status, text };
  }
}

// ----------------------------------------------------------------
//  Base64 ユーティリティ
// ----------------------------------------------------------------
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
