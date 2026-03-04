/**
 * content.js — Crosspost Extension
 * 速度最適化版: 全処理を可能な限り並列化
 *
 * 並列化ポイント:
 *  1. Mastodon / Threads / Bluesky への投稿を同時開始
 *  2. catbox.moe への複数画像アップロードを同時実行
 *  3. Bluesky への複数画像アップロードを同時実行
 *  4. Mastodon への複数画像アップロードを同時実行
 *  5. Threads カルーセルの子コンテナ作成を同時実行
 *  6. 子コンテナのポーリングを同時実行
 */

(async function () {
  'use strict';

  const POST_TOOLBAR_SELECTOR = 'div[data-testid="toolBar"]:not(.cross-injected)';
  const RE_YOUTUBE = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const RE_SPOTIFY = /open\.spotify\.com\/(intl-[a-z]+\/)?(?:track|album|artist|playlist)\/[A-Za-z0-9]+/i;
  const THREADS_MAX_IMAGES = 4;

  let is_processing = false;
  let settings = {};

  // ----------------------------------------------------------------
  //  設定ロード
  // ----------------------------------------------------------------
  const loadSettings = () => new Promise(resolve => {
    chrome.storage.sync.get({
      bsky_handle:                '',
      bsky_app_password:          '',
      bsky_crosspost_checked:     false,
      mastodon_instance_url:      'https://mastodon.social',
      mastodon_api_key:           '',
      mastodon_crosspost_checked: false,
      threads_access_token:       '',
      threads_user_id:            '',
      threads_crosspost_checked:  false,
      bsky_visible:               true,
      mastodon_visible:           true,
      threads_visible:            true,
      uploader:                   'catbox',
      litterbox_time:             '24h',
      alt_shortcuts_enabled:      true,
    }, (items) => { settings = items; resolve(items); });
  });

  await loadSettings();

  // ----------------------------------------------------------------
  //  background.js との通信（ポート方式）
  // ----------------------------------------------------------------
  let _portIdCounter = 0;

  // ----------------------------------------------------------------
  //  Service Worker keep-alive（MV3対策）
  //  crosspost処理中は持続ポートを1本開いてスリープを防ぐ
  // ----------------------------------------------------------------
  let _keepAlivePort = null;
  let _keepAliveTimer = null;

  // Service Worker を確実に起動させてから処理を開始する
  async function wakeUpServiceWorker() {
    for (let i = 0; i < 5; i++) {
      try {
        await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'PING' }, (resp) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(resp);
          });
        });
        console.log(`[Crosspost] SW起動確認 (試行${i + 1})`);
        return; // 成功
      } catch (_) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    console.warn('[Crosspost] SW起動確認失敗、続行します');
  }

  function startKeepAlive() {
    if (_keepAlivePort) return;
    const connect = () => {
      try {
        _keepAlivePort = chrome.runtime.connect({ name: 'crosspost-fetch' });
        _keepAlivePort.onDisconnect.addListener(() => {
          _keepAlivePort = null;
          // タイマーが生きていれば再接続（処理中）
          if (_keepAliveTimer) {
            setTimeout(() => { if (_keepAliveTimer) connect(); }, 500);
          }
        });
      } catch (_) {}
    };
    connect();
    // 20秒ごとにPINGでService Workerを生存させる
    _keepAliveTimer = setInterval(() => {
      if (_keepAlivePort) {
        try { _keepAlivePort.postMessage({ type: 'PING' }); } catch (_) {}
      }
    }, 20000);
  }

  function stopKeepAlive() {
    if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; }
    if (_keepAlivePort) { try { _keepAlivePort.disconnect(); } catch (_) {} _keepAlivePort = null; }
  }

  // bgFetch: リトライ付き個別ポート方式
  const bgFetch = (params, _retry = 0) => new Promise((resolve, reject) => {
    const id   = ++_portIdCounter;
    let _resolved = false; // レスポンス受信済みフラグ
    let port;
    try {
      port = chrome.runtime.connect({ name: 'crosspost-fetch' });
    } catch (e) {
      return reject(new Error('connect失敗: ' + e.message));
    }

    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('bgFetch timeout: ' + params.url));
    }, 180000);

    port.onMessage.addListener((msg) => {
      if (msg.id !== id) return;
      _resolved = true;
      clearTimeout(timer);
      port.disconnect();
      if (msg.ok === false && msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      void chrome.runtime.lastError; // エラーを握りつぶしてコンソール警告を抑制
      if (_resolved) return; // レスポンス済みなら何もしない
      // レスポンスなしで切断 → リトライ（最大3回、間隔を延ばす）
      if (_retry < 3) {
        const delay = (_retry + 1) * 800;
        console.warn(`[Crosspost] bgFetch port closed (retry ${_retry + 1}/3, delay ${delay}ms):`, params.url);
        setTimeout(() => bgFetch(params, _retry + 1).then(resolve).catch(reject), delay);
      } else {
        reject(new Error('Failed to fetch'));
      }
    });

    port.postMessage({ type: 'FETCH', id, ...params });
  });


  // ----------------------------------------------------------------
  //  Blob → Base64
  // ----------------------------------------------------------------
  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  // ----------------------------------------------------------------
  //  画像リサイズ
  // ----------------------------------------------------------------
  const resize_image = (blob, maxPx = 1280, quality = 0.90) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.createElement('img');
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else       { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(resolve, 'image/jpeg', quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(blob);
  });

  // ----------------------------------------------------------------
  //  Bluesky 用: 976KB 以下になるまで段階的に圧縮
  //  Bluesky の uploadBlob 上限は 976.56KB (1,000,000 bytes)
  // ----------------------------------------------------------------
  const BSKY_MAX_BYTES = 976 * 1024; // 976KB

  const compressForBsky = async (blob) => {
    // 段階的な圧縮パラメータ: [最大px, 品質]
    const steps = [
      [1280, 0.90],
      [1280, 0.80],
      [1024, 0.80],
      [1024, 0.70],
      [ 800, 0.75],
      [ 800, 0.65],
      [ 640, 0.70],
    ];

    if (blob.size <= BSKY_MAX_BYTES) return blob;

    for (const [maxPx, quality] of steps) {
      const resized = await resize_image(blob, maxPx, quality);
      console.log(`[Crosspost] Bsky compress: ${maxPx}px q${quality} → ${Math.round(resized.size / 1024)}KB`);
      if (resized.size <= BSKY_MAX_BYTES) return resized;
    }
    // 最終手段: 最小設定で強制圧縮
    return await resize_image(blob, 640, 0.60);
  };

  // ----------------------------------------------------------------
  //  画像アップロード（catbox.moe または litterbox.catbox.moe）
  // ----------------------------------------------------------------
  async function uploadToHost(blob) {
    if (blob.size > 50 * 1024 * 1024) blob = await resize_image(blob);
    // catbox.moe / litterbox ともに CORS 非許可のため bgFetch（background.js）経由でアップロード
    const b64 = await blobToBase64(blob);

    if (settings.uploader === 'litterbox') {
      const resp = await bgFetch({
        url:      'https://litterbox.catbox.moe/resources/internals/api.php',
        method:   'POST',
        body: {
          reqtype:      'fileupload',
          time:         settings.litterbox_time || '24h',
          fileToUpload: { __type: 'blob', data: b64, mimeType: blob.type, filename: 'image.jpg' },
        },
        bodyType: 'formdata',
      });
      const url = (resp.text || resp.data || '').toString().trim();
      if (!url.startsWith('https://files.catbox.moe/') && !url.startsWith('https://litter.catbox.moe/')) {
        throw new Error(`litterbox アップロード失敗: ${url || 'レスポンスなし'}`);
      }
      return url;
    } else {
      const resp = await bgFetch({
        url:      'https://catbox.moe/user/api.php',
        method:   'POST',
        body: {
          reqtype:      'fileupload',
          fileToUpload: { __type: 'blob', data: b64, mimeType: blob.type, filename: 'image.jpg' },
        },
        bodyType: 'formdata',
      });
      const url = (resp.text || resp.data || '').toString().trim();
      if (!url.startsWith('https://files.catbox.moe/')) {
        throw new Error(`catbox.moe アップロード失敗: ${url || 'レスポンスなし'}`);
      }
      return url;
    }
  }

  // ----------------------------------------------------------------
  //  【並列】複数画像アップロード
  // ----------------------------------------------------------------
  async function uploadAllToHost(images) {
    // ポート圧迫を防ぐため1枚ずつ順番にアップロード
    const urls = [];
    for (let i = 0; i < images.length; i++) {
      console.log(`[Crosspost] catbox upload[${i+1}/${images.length}] start`);
      const blob = await fetch(images[i].src).then(r => r.blob());
      const url  = await uploadToHost(blob);
      console.log(`[Crosspost] catbox upload[${i+1}/${images.length}] done: ${url}`);
      urls.push(url);
    }
    return urls;
  }

  // ----------------------------------------------------------------
  //  Bluesky — facet 生成
  // ----------------------------------------------------------------
  const getFacets = (text) => {
    const facets = [];
    for (const match of text.matchAll(/https?:\/\/\S+/g)) {
      facets.push({
        index: {
          byteStart: new TextEncoder().encode(text.slice(0, match.index)).length,
          byteEnd:   new TextEncoder().encode(text.slice(0, match.index + match[0].length)).length,
        },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: match[0] }],
      });
    }
    return facets;
  };

  // ----------------------------------------------------------------
  //  Mastodon 投稿
  //  【並列】複数画像を同時アップロード
  // ----------------------------------------------------------------
  async function postToMastodon(text, images) {
    const { mastodon_instance_url: mUrl, mastodon_api_key: mKey } = settings;
    if (!mUrl || !mKey) throw new Error('設定が不足しています（Instance URL / API Key）');

    // 【並列】全画像を同時アップロード
    const mediaIds = (await Promise.all(
      images.map(async (img) => {
        const blob = await fetch(img.src).then(r => r.blob());
        const b64  = await blobToBase64(blob);
        const resp = await bgFetch({
          url:      `${mUrl}/api/v1/media`,
          method:   'POST',
          headers:  { 'Authorization': `Bearer ${mKey}` },
          body:     { file: { __type: 'blob', data: b64, mimeType: blob.type, filename: 'image.jpg' } },
          bodyType: 'formdata',
        });
        return resp.data?.id || null;
      })
    )).filter(Boolean);

    const resp = await bgFetch({
      url:      `${mUrl}/api/v1/statuses`,
      method:   'POST',
      headers:  { 'Authorization': `Bearer ${mKey}`, 'Content-Type': 'application/json' },
      body:     JSON.stringify({ status: text, media_ids: mediaIds }),
      bodyType: 'json',
    });
    if (!resp.ok) throw new Error(`Mastodon API エラー (HTTP ${resp.status})`);
  }

  // ----------------------------------------------------------------
  //  Threads コンテナ処理完了待ち（ポーリング）
  //  最初の待機を短くして体感速度を改善
  // ----------------------------------------------------------------
  async function waitForThreadsContainer(containerId, token, label = '') {
    const BASE = 'https://graph.threads.net/v1.0';
    // 最初は1秒待機、以降2秒間隔
    // CAROUSEL は処理が重いため間隔を多めに用意（最大 1 + 2×29 = 59秒）
    const isCarousel = label === 'CAROUSEL';
    const intervals = isCarousel
      ? [1000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000,
         2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000,
         2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]
      : [1000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000];

    for (let i = 0; i < intervals.length; i++) {
      await new Promise(r => setTimeout(r, intervals[i]));
      const statusResp = await bgFetch({
        url:    `${BASE}/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(token)}`,
        method: 'GET',
      });
      const status = statusResp.data?.status;
      console.log(`[Crosspost] Threads ${label} (try ${i + 1}): ${status}`);

      if (status === 'FINISHED') return;
      if (status === 'ERROR') throw new Error(`コンテナエラー: ${statusResp.data?.error_message || '不明'}`);
    }
    throw new Error(`コンテナのタイムアウト: ${label}`);
  }

  // Threads コンテナ公開（共通）
  async function publishThreadsContainer(uid, creationId, token) {
    const resp = await bgFetch({
      url:      `https://graph.threads.net/v1.0/${uid}/threads_publish`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify({ creation_id: creationId, access_token: token }),
      bodyType: 'json',
    });
    if (!resp.ok && !resp.data?.id) {
      throw new Error(`公開失敗: ${resp.data?.error?.message || JSON.stringify(resp.data)}`);
    }
  }

  // ----------------------------------------------------------------
  //  Threads 投稿
  //  【並列】catbox アップロード、子コンテナ作成、ポーリングを並列化
  // ----------------------------------------------------------------
  async function postToThreads(text, images) {
    const { threads_access_token: token, threads_user_id: uid } = settings;
    if (!token) throw new Error('アクセストークンが未設定です');
    if (!uid)   throw new Error('User ID が未設定です');

    const BASE = 'https://graph.threads.net/v1.0';
    const targetImages = images.slice(0, THREADS_MAX_IMAGES);

    // ---- 画像なし: テキスト投稿 ----
    if (targetImages.length === 0) {
      const resp = await bgFetch({
        url: `${BASE}/${uid}/threads`, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_type: 'TEXT', text, access_token: token }),
        bodyType: 'json',
      });
      const id = resp.data?.id;
      if (!id) throw new Error(`コンテナ作成失敗: ${resp.data?.error?.message}`);
      await waitForThreadsContainer(id, token, 'TEXT');
      await publishThreadsContainer(uid, id, token);
      return;
    }

    // ---- 画像URL取得: Bluesky CDN優先 → catboxフォールバック ----
    // Bluesky設定済み → Bluesky CDNを中継に使用（外部サービス不要）
    // Bluesky未設定  → catbox.moe / litterbox にフォールバック
    let imageUrls;
    if (settings.bsky_handle && settings.bsky_app_password) {
      try {
        imageUrls = await uploadViaBskyCdn(targetImages);
        console.log('[Crosspost] Bluesky CDN URLs:', imageUrls);
      } catch (e) {
        console.warn('[Crosspost] Bluesky CDN 失敗、catboxにフォールバック:', e.message);
        const uploaderName = settings.uploader === 'litterbox' ? 'litterbox' : 'catbox.moe';
        imageUrls = await uploadAllToHost(targetImages);
        console.log('[Crosspost] catbox URLs (fallback):', imageUrls);
      }
    } else {
      const uploaderName = settings.uploader === 'litterbox' ? 'litterbox' : 'catbox.moe';
      imageUrls = await uploadAllToHost(targetImages);
      console.log('[Crosspost] catbox URLs:', imageUrls);
    }
    const catboxUrls = imageUrls;

    // ---- 画像 1 枚: IMAGE 投稿 ----
    if (catboxUrls.length === 1) {
      const resp = await bgFetch({
        url: `${BASE}/${uid}/threads`, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_type: 'IMAGE', image_url: catboxUrls[0], text, access_token: token }),
        bodyType: 'json',
      });
      const id = resp.data?.id;
      if (!id) throw new Error(`コンテナ作成失敗: ${resp.data?.error?.message}`);
      await waitForThreadsContainer(id, token, 'IMAGE');
      await publishThreadsContainer(uid, id, token);
      return;
    }

    // ---- 画像 2〜4 枚: CAROUSEL 投稿 ----
    // 子コンテナは順番に作成（Threads API は並列リクエストに非対応）
    const childIds = [];
    for (let i = 0; i < catboxUrls.length; i++) {
      const resp = await bgFetch({
        url: `${BASE}/${uid}/threads`, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media_type: 'IMAGE', image_url: catboxUrls[i],
          is_carousel_item: true, access_token: token,
        }),
        bodyType: 'json',
      });
      const id = resp.data?.id;
      if (!id) throw new Error(`子コンテナ[${i + 1}]作成失敗: ${resp.data?.error?.message || JSON.stringify(resp.data)}`);
      childIds.push(id);
    }

    // 【並列】全子コンテナの処理完了を同時に待つ
    await Promise.all(
      childIds.map((id, i) => waitForThreadsContainer(id, token, `IMAGE[${i + 1}/${childIds.length}]`))
    );

    // カルーセル親コンテナ作成
    const carouselResp = await bgFetch({
      url: `${BASE}/${uid}/threads`, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'CAROUSEL', children: childIds.join(','), text, access_token: token,
      }),
      bodyType: 'json',
    });
    const carouselId = carouselResp.data?.id;
    if (!carouselId) throw new Error(`カルーセルコンテナ作成失敗: ${carouselResp.data?.error?.message}`);

    await waitForThreadsContainer(carouselId, token, 'CAROUSEL');
    await publishThreadsContainer(uid, carouselId, token);
  }

  // ----------------------------------------------------------------
  //  Bluesky external embed 生成ヘルパー
  //  （Twitterカード・OGP共通でカードデータを Bluesky にアップロード）
  // ----------------------------------------------------------------
  async function buildExternalEmbed(auth, uri, title, description, imageUrl) {
    let thumb;
    if (imageUrl) {
      try {
        const imgUrl = imageUrl.startsWith('http') ? imageUrl : new URL(imageUrl, uri).href;
        const imgResp = await bgFetch({ url: imgUrl, method: 'GET', responseType: 'binary' });
        if (imgResp.base64) {
          let imgBlob = await (async () => {
            const buf = Uint8Array.from(atob(imgResp.base64), c => c.charCodeAt(0)).buffer;
            return new Blob([buf], { type: imgResp.mimeType || 'image/jpeg' });
          })();
          imgBlob = await compressForBsky(imgBlob);
          const b64 = await blobToBase64(imgBlob);
          const upResp = await bgFetch({
            url: 'https://bsky.social/xrpc/com.atproto.repo.uploadBlob', method: 'POST',
            headers: { 'Authorization': `Bearer ${auth.accessJwt}`, 'Content-Type': imgBlob.type },
            body: b64, bodyType: 'base64',
          });
          thumb = upResp.data?.blob;
        }
      } catch (e) {
        console.warn('[Crosspost] embed image upload failed:', e.message);
      }
    }
    return {
      $type: 'app.bsky.embed.external',
      external: { uri, title, description: description || '', thumb },
    };
  }

  // ----------------------------------------------------------------
  //  OGP 取得（一般URL用 Bluesky カード）
  //  background.js 経由で fetch → CORS 回避
  // ----------------------------------------------------------------
  async function fetchOgp(url) {
    try {
      // OGP取得専用: バイナリで取得して charset 自動検出（FlyFreeと同方式）
      const resp = await new Promise((resolve, reject) => {
        const id   = ++_portIdCounter;
        const port = chrome.runtime.connect({ name: 'crosspost-fetch' });
        const timer = setTimeout(() => {
          port.disconnect();
          reject(new Error('OGP fetch timeout (10s)'));
        }, 10000);
        port.onMessage.addListener((msg) => {
          if (msg.id !== id) return;
          clearTimeout(timer);
          port.disconnect();
          resolve(msg);
        });
        port.onDisconnect.addListener(() => {
          clearTimeout(timer);
          resolve({ ok: false, base64: '' });
        });
        port.postMessage({ type: 'FETCH', id, url, method: 'GET', responseType: 'binary', headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
        }});
      });

      // base64 → ArrayBuffer → charset検出 → 正しいエンコーディングでデコード
      let html = '';
      if (resp.base64) {
        const bin    = atob(resp.base64);
        const bytes  = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const buf    = bytes.buffer;

        // まず UTF-8 でデコードして charset を確認
        const utf8Html = new TextDecoder('utf-8').decode(buf);
        const charsetMatch = utf8Html.match(/<meta[^>]+charset=["']?([A-Za-z0-9\-]+)["']?/i)
                          || utf8Html.match(/charset=([A-Za-z0-9\-]+)/i);
        const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8';
        console.log('[Crosspost] OGP charset:', charset);

        // UTF-8以外（Shift-JIS, EUC-JPなど）は再デコード
        html = (charset === 'utf-8' || charset === 'utf8')
          ? utf8Html
          : new TextDecoder(charset).decode(buf);
      } else {
        html = resp.text || (typeof resp.data === 'string' ? resp.data : '') || '';
      }

      const getMeta = (prop) => {
        // og: プロパティ
        const ogMatch = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
                     || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'));
        if (ogMatch) return ogMatch[1];
        // name= フォールバック（description など）
        const nameMatch = html.match(new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
                       || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${prop}["']`, 'i'));
        return nameMatch ? nameMatch[1] : null;
      };

      // title フォールバック: <title> タグ
      const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);

      const title       = getMeta('title')       || (titleTag ? titleTag[1].trim() : null);
      const description = getMeta('description') || '';
      let   imageUrl    = getMeta('image');

      // og:image が相対URLの場合は絶対URLに変換
      if (imageUrl) {
        try { imageUrl = new URL(imageUrl, url).href; } catch (_) {}
      }

      console.log('[Crosspost] OGP result:', { title, imageUrl });

      // HTML エンティティのデコード
      const decode = (str) => str
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ');

      // title が取れなかった場合は null を返してカードなし扱いにする
      if (!title) return null;

      return {
        title:       decode(title),
        description: decode(description || ''),
        imageUrl,
      };
    } catch (e) {
      console.warn('[Crosspost] OGP fetch failed:', e.message);
      return null;
    }
  }

  // ----------------------------------------------------------------
  //  Bluesky CDN を Threads 画像中継に使用
  //  uploadBlob → blob.ref.$link (CID) + auth.did → CDN URL → Threads に渡す
  //  CDN URL形式: https://cdn.bsky.app/img/feed_fullsize/plain/{did}/{cid}@jpeg
  //  Bluesky設定済みの場合は catbox.moe 不要（外部サービス依存なし）
  // ----------------------------------------------------------------
  async function uploadViaBskyCdn(images) {
    const { bsky_handle, bsky_app_password } = settings;

    // Bluesky 認証
    const authResp = await bgFetch({
      url: 'https://bsky.social/xrpc/com.atproto.server.createSession', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: bsky_handle, password: bsky_app_password }),
      bodyType: 'json',
    });
    const auth = authResp.data;
    if (!auth?.accessJwt) throw new Error('Bluesky 認証失敗');
    console.log('[Crosspost] Bluesky 認証OK, did:', auth.did);

    // 全画像を並列アップロード
    const blobList = await Promise.all(
      images.map(img => fetch(img.src).then(r => r.blob()))
    );

    const cdnUrls = await Promise.all(
      blobList.map(async (blob, i) => {
        blob = await compressForBsky(blob);
        const b64 = await blobToBase64(blob);
        const upResp = await bgFetch({
          url: 'https://bsky.social/xrpc/com.atproto.repo.uploadBlob', method: 'POST',
          headers: { 'Authorization': `Bearer ${auth.accessJwt}`, 'Content-Type': blob.type },
          body: b64, bodyType: 'base64',
        });
        const cid = upResp.data?.blob?.ref?.$link;
        if (!cid) throw new Error(`画像[${i+1}] CID取得失敗: ${JSON.stringify(upResp.data)}`);

        // CDN URL を2パターン試す → まず cdn.bsky.app
        const cdnUrl = `https://cdn.bsky.app/img/feed_fullsize/plain/${auth.did}/${cid}@jpeg`;
        console.log(`[Crosspost] 画像[${i+1}] CID: ${cid}`);
        console.log(`[Crosspost] 画像[${i+1}] CDN URL: ${cdnUrl}`);
        return { cdnUrl, fallbackUrl: `https://bsky.social/xrpc/com.atproto.sync.getBlob?did=${auth.did}&cid=${cid}`, cid, did: auth.did };
      })
    );

    console.log('[Crosspost] 全CDN URL生成完了:', cdnUrls.map(u => u.cdnUrl));
    return cdnUrls.map(u => u.cdnUrl);
  }

  // ----------------------------------------------------------------
  //  Bluesky 投稿
  //  【並列】複数画像を同時アップロード
  // ----------------------------------------------------------------
  async function postToBsky(text, images, root) {
    const { bsky_handle, bsky_app_password } = settings;
    if (!bsky_handle || !bsky_app_password) throw new Error('Handle / App Password が未設定です');

    const authResp = await bgFetch({
      url: 'https://bsky.social/xrpc/com.atproto.server.createSession', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: bsky_handle, password: bsky_app_password }),
      bodyType: 'json',
    });
    const auth = authResp.data;
    if (!auth?.accessJwt) throw new Error('認証失敗: ' + JSON.stringify(authResp.data));

    let embed;

    if (images.length > 0) {
      // 【並列】全画像を同時アップロード
      const blobList = await Promise.all(
        images.map(img => fetch(img.src).then(r => r.blob()))
      );
      const embeds = (await Promise.all(
        blobList.map(async (blob) => {
          blob = await compressForBsky(blob);
          const b64 = await blobToBase64(blob);
          const upResp = await bgFetch({
            url: 'https://bsky.social/xrpc/com.atproto.repo.uploadBlob', method: 'POST',
            headers: { 'Authorization': `Bearer ${auth.accessJwt}`, 'Content-Type': blob.type },
            body: b64, bodyType: 'base64',
          });
          return upResp.data?.blob ? { image: upResp.data.blob, alt: '' } : null;
        })
      )).filter(Boolean);
      embed = { $type: 'app.bsky.embed.images', images: embeds };

    } else {
      const ytMatch = text.match(RE_YOUTUBE);
      // YouTube URL
      if (ytMatch) {
        const videoId = ytMatch[1];
        const ytUrl   = `https://www.youtube.com/watch?v=${videoId}`;

        // oEmbed API・サムネイルを並列取得
        const [oembedResp, thumbResp] = await Promise.all([
          bgFetch({ url: `https://www.youtube.com/oembed?url=${encodeURIComponent(ytUrl)}&format=json`, method: 'GET' }),
          bgFetch({ url: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, method: 'GET', responseType: 'binary' }),
        ]);

        const oembed      = oembedResp.data || {};
        const title       = oembed.title       || (root.querySelector('[data-testid="card.wrapper"]')?.innerText.split('\n')[0]) || 'YouTube Video';
        const description = oembed.author_name  ? `YouTube video by ${oembed.author_name}` : '';

        if (thumbResp.base64) {
          const upResp = await bgFetch({
            url: 'https://bsky.social/xrpc/com.atproto.repo.uploadBlob', method: 'POST',
            headers: { 'Authorization': `Bearer ${auth.accessJwt}`, 'Content-Type': 'image/jpeg' },
            body: thumbResp.base64, bodyType: 'base64',
          });
          embed = {
            $type: 'app.bsky.embed.external',
            external: { uri: ytUrl, title, description, thumb: upResp.data?.blob },
          };
        }
      } else {
        // 一般URL → Twitter のカード DOM から情報を取得
        // 自分のツイートにURLが含まれる場合のみカードを探す
        // root全体（primaryColumn）ではなく投稿エリア直近に絞ることで他ツイートのカードを誤取得しない
        const textUrl = text.match(/https?:\/\/\S+/)?.[0]?.replace(/[)>.,!?]+$/, '');
        // ツールバーの祖先を遡って投稿エリアのコンテナを特定（ダイアログ or 投稿エリアの直近div）
        // ツールバーから上位に遡り、テキストエリアも含む最近の共通祖先を投稿エリアとして特定
        const toolbar = root.querySelector('[data-testid="toolBar"]');
        let composeArea = null;
        if (toolbar) {
          // 祖先を最大10階層遡り、card.wrapper が見つかる最も近い祖先を探す
          let el = toolbar.parentElement;
          for (let i = 0; i < 10 && el; i++) {
            if (el.querySelector('[data-testid="card.wrapper"]')) { composeArea = el; break; }
            el = el.parentElement;
          }
        }
        const card = (textUrl && composeArea) ? composeArea.querySelector('[data-testid="card.wrapper"]') : null;
        if (card) {
          // カードのURL・タイトル・説明・サムネイルを DOM から取得
          const cardLink    = card.querySelector('a[href]');
          const pageUrl     = cardLink?.href || textUrl;
          const cardTexts   = Array.from(card.querySelectorAll('span')).map(s => s.innerText.trim()).filter(Boolean);
          // Twitterカードのspan構造: [ドメイン, タイトル, 説明] or [ドメイン, タイトル]
          // ドメインらしい文字列（.を含む短いテキスト）をスキップして最初の長いテキストをタイトルとする
          const nonDomain   = cardTexts.filter(t => t.length > 30 || (!t.includes('.') && t.length > 5));
          const title       = nonDomain[0] || cardTexts[1] || cardTexts[0] || '';
          const description = nonDomain[1] || cardTexts[2] || '';
          // サムネイル画像（card内のimg）
          const cardImg     = card.querySelector('img[src]');

          if (pageUrl && title) {
            embed = await buildExternalEmbed(auth, pageUrl, title, description, cardImg?.src);
          }
        }

        // ② Twitterカードなし → Spotify oEmbed 優先、それ以外は直接OGP取得
        if (!embed && textUrl) {
          const spotifyMatch = textUrl.match(RE_SPOTIFY);
          if (spotifyMatch) {
            // Spotify: oEmbed API でアーティスト名・サムネイルを取得
            console.log('[Crosspost] Spotify oEmbed 取得中:', textUrl);
            try {
              const oembedResp = await bgFetch({
                url: `https://open.spotify.com/oembed?url=${encodeURIComponent(textUrl)}`,
                method: 'GET',
              });
              const oembed = oembedResp.data;
              console.log('[Crosspost] Spotify oEmbed:', oembed);
              if (oembed?.title) {
                const thumbUrl = oembed.thumbnail_url || null;
                embed = await buildExternalEmbed(auth, textUrl, oembed.title, oembed.provider_name || 'Spotify', thumbUrl);
              }
            } catch (e) {
              console.warn('[Crosspost] Spotify oEmbed 失敗:', e.message);
            }
          }

          // Spotify以外 or Spotify失敗時 → 通常OGP取得
          if (!embed) {
            const ogp = await fetchOgp(textUrl);
            if (ogp) {
              embed = await buildExternalEmbed(auth, textUrl, ogp.title, ogp.description, ogp.imageUrl);
            }
          }
        }
      }
    }

    const postResp = await bgFetch({
      url: 'https://bsky.social/xrpc/com.atproto.repo.createRecord', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${auth.accessJwt}` },
      body: JSON.stringify({
        repo: auth.did, collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text, facets: getFacets(text), createdAt: new Date().toISOString(), embed },
      }),
      bodyType: 'json',
    });
    if (!postResp.ok && !postResp.data?.uri) throw new Error('投稿失敗: ' + JSON.stringify(postResp.data));
  }

  // ----------------------------------------------------------------
  //  クロスポスト実行
  //  【並列】Mastodon / Threads / Bluesky を同時投稿
  // ----------------------------------------------------------------
  const execCrosspost = async (root, originalBtn) => {
    if (is_processing) return;
    await loadSettings();

    const bCb = root?.querySelector('.cross-bsky-cb');
    const mCb = root?.querySelector('.cross-mast-cb');
    const tCb = root?.querySelector('.cross-threads-cb');

    if (!bCb?.checked && !mCb?.checked && !tCb?.checked) {
      originalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 999 }));
      return;
    }

    is_processing = true;
    showToast('クロスポスト中…', 'processing');
    await wakeUpServiceWorker();
    startKeepAlive();

    const text   = root.querySelector('[data-testid="tweetTextarea_0"]')?.innerText || '';
    const images = Array.from(root.querySelectorAll('[data-testid="attachments"] img'))
                       .filter(i => i.src.startsWith('blob:'));

    // 【並列】3プラットフォームへ同時投稿
    const jobs = [
      mCb?.checked ? postToMastodon(text, images).then(() => ({ platform: 'Mastodon', ok: true  }))
                                                  .catch(e  => ({ platform: 'Mastodon', ok: false, error: e.message })) : null,
      tCb?.checked ? postToThreads(text, images) .then(() => ({ platform: 'Threads',  ok: true  }))
                                                  .catch(e  => ({ platform: 'Threads',  ok: false, error: e.message })) : null,
      bCb?.checked ? postToBsky(text, images, root).then(() => ({ platform: 'Bluesky', ok: true  }))
                                                    .catch(e  => ({ platform: 'Bluesky', ok: false, error: e.message })) : null,
    ].filter(Boolean);

    try {
      const results = await Promise.all(jobs);

      const failed  = results.filter(r => !r.ok);
      const success = results.filter(r =>  r.ok);

      if (failed.length === 0) {
        showToast(`${success.map(r => r.platform).join(' / ')} に投稿完了 ✓`, 'success');
      } else {
        failed.forEach(r => {
          console.error(`[Crosspost] ${r.platform} 失敗:`, r.error);
          showToast(`${r.platform} 失敗: ${r.error}`, 'error');
        });
      }

      // チェックボックスのリセット
      const succeededPlatforms = new Set(success.map(r => r.platform));
      if (failed.length === 0) {
        if (bCb) bCb.checked = settings.bsky_crosspost_checked;
        if (mCb) mCb.checked = settings.mastodon_crosspost_checked;
        if (tCb) tCb.checked = settings.threads_crosspost_checked;
      } else {
        if (bCb && succeededPlatforms.has('Bluesky'))  bCb.checked = false;
        if (mCb && succeededPlatforms.has('Mastodon')) mCb.checked = false;
        if (tCb && succeededPlatforms.has('Threads'))  tCb.checked = false;
      }

      originalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 999 }));

    } catch (e) {
      // 予期せぬエラー（bgFetchポート切れ等）— Twitterをハングさせないためにここでも捕捉
      console.error('[Crosspost] 予期せぬエラー:', e);
      showToast('予期せぬエラー: ' + e.message, 'error');
    } finally {
      // どんな状況でも必ずリセット — これがないとTwitterごとハングする
      is_processing = false;
      stopKeepAlive();
    }
  };

  // ----------------------------------------------------------------
  //  トースト通知（error はクリックで閉じる）
  // ----------------------------------------------------------------
  // type:
  //   'processing' — スピナー付き、消えない（処理中）
  //   'info'       — 4秒で消える（補足情報）
  //   'success'    — 4秒で消える（完了）
  //   'error'      — クリックで消える（エラー）
  const showToast = (msg, type = 'info') => {
    const existing = document.getElementById('cross-toast');
    if (existing) existing.remove();

    const colors = { processing: '#1d9bf0', info: '#1d9bf0', success: '#00ba7c', error: '#f4212e' };
    const toast  = document.createElement('div');
    toast.id = 'cross-toast';
    toast.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:${colors[type]}; color:white; padding:10px 16px 10px 20px;
      border-radius:20px; font-size:14px; font-weight:bold;
      z-index:100000; box-shadow:0 4px 16px rgba(0,0,0,0.4);
      transition:opacity 0.3s; font-family:sans-serif;
      max-width:88vw; display:flex; align-items:center; gap:10px;
      cursor:${type === 'error' ? 'pointer' : 'default'};
    `;

    // スピナー（processing タイプのみ）
    if (type === 'processing') {
      const spinner = document.createElement('span');
      spinner.style.cssText = [
        'width:14px', 'height:14px', 'border-radius:50%',
        'border:2px solid rgba(255,255,255,0.35)',
        'border-top-color:white',
        'animation:cross-spin 0.7s linear infinite',
        'flex-shrink:0', 'display:inline-block',
      ].join(';');
      toast.appendChild(spinner);
      // アニメーション定義（初回のみ）
      if (!document.getElementById('cross-toast-style')) {
        const style = document.createElement('style');
        style.id = 'cross-toast-style';
        style.textContent = '@keyframes cross-spin { to { transform:rotate(360deg); } }';
        document.head.appendChild(style);
      }
    }

    const msgSpan = document.createElement('span');
    msgSpan.textContent = msg;
    msgSpan.style.cssText = 'flex:1; word-break:break-word; white-space:pre-wrap;';
    toast.appendChild(msgSpan);

    if (type === 'error') {
      const x = document.createElement('span');
      x.textContent = '✕';
      x.style.cssText = 'font-size:16px;opacity:0.8;flex-shrink:0;line-height:1;';
      toast.appendChild(x);
      toast.addEventListener('click', () => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      });
    }

    document.body.appendChild(toast);
    // processing は消えない。error はクリックで消える。それ以外は4秒
    if (type !== 'error' && type !== 'processing') {
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
    }
  };


  // ----------------------------------------------------------------
  //  イベントハンドラー
  // ----------------------------------------------------------------
  const handleAction = (e) => {
    if (e.detail === 999) return;

    if (e.type === 'keydown' && (e.ctrlKey || e.altKey) && e.key === 'Enter') {
      const bt = document.querySelector('[data-testid*="tweetButton"]');
      if (bt && !bt.disabled) {
        const root = bt.closest('div[role="dialog"]') || document.querySelector('div[data-testid="primaryColumn"]');
        const any  = root?.querySelector('.cross-bsky-cb')?.checked ||
                     root?.querySelector('.cross-mast-cb')?.checked ||
                     root?.querySelector('.cross-threads-cb')?.checked;
        if (any) { e.preventDefault(); e.stopImmediatePropagation(); execCrosspost(root, bt); }
      }
      return;
    }

    // Alt+0〜3: チェックボックス切り替え（設定で無効化可能）
    if (e.type === 'keydown' && e.altKey && !e.ctrlKey && ['0','1','2','3'].includes(e.key)) {
      if (!settings.alt_shortcuts_enabled) return;

      // 投稿エリアの root を特定
      const bt   = document.querySelector('[data-testid*="tweetButton"]');
      const root = bt
        ? (bt.closest('div[role="dialog"]') || document.querySelector('div[data-testid="primaryColumn"]'))
        : document.querySelector('div[data-testid="primaryColumn"]');
      if (!root) return;

      const bCb = root.querySelector('.cross-bsky-cb');
      const tCb = root.querySelector('.cross-threads-cb');
      const mCb = root.querySelector('.cross-mast-cb');

      // 表示されているチェックボックスのみ対象
      const visible = [bCb, tCb, mCb].filter(Boolean);
      if (visible.length === 0) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.key === '0') {
        // Alt+0: 全体 — 1つでもONなら全OFF、全OFFなら全ON
        const anyOn = visible.some(cb => cb.checked);
        visible.forEach(cb => {
          cb.checked = !anyOn;
          cb.dispatchEvent(new Event('change'));
        });
      } else {
        // Alt+1/2/3: 個別トグル（番号は表示順: Bsky=1, Threads=2, Mast=3）
        const targets = [bCb, tCb, mCb];
        const idx = parseInt(e.key) - 1;
        const cb  = targets[idx];
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      }
      return;
    }

    if (e.type === 'click') {
      const bt   = e.currentTarget;
      const root = bt.closest('div[role="dialog"]') || bt.closest('div[data-testid="primaryColumn"]');
      const any  = root?.querySelector('.cross-bsky-cb')?.checked ||
                   root?.querySelector('.cross-mast-cb')?.checked ||
                   root?.querySelector('.cross-threads-cb')?.checked;
      if (any) { e.preventDefault(); e.stopImmediatePropagation(); execCrosspost(root, bt); }
    }
  };

  // ----------------------------------------------------------------
  //  返信モード判定（ダイアログ内のみ対象・ホーム画面では絶対に誤検知しない）
  // ----------------------------------------------------------------
  const isReplyMode = (toolbarEl) => {
    // ダイアログ内にいない場合は返信モードではない
    const dialog = toolbarEl.closest('div[role="dialog"]');
    if (!dialog) return false;

    const root = dialog;

    // プレースホルダーで判定（日本語・英語）
    const REPLY_PLACEHOLDERS = [
      '返信をポスト',
      '返信をツイート',
      'Tweet your reply',
      'Post your reply',
      'Reply',
      '返信する',
    ];
    const POST_PLACEHOLDERS = [
      'いまどうしてる？',
      '今どうしてる？',
      "What's happening?",
      "What's on your mind?",
    ];
    const textarea = root.querySelector('[data-testid="tweetTextarea_0"]');
    if (textarea) {
      const placeholder = textarea.getAttribute('aria-placeholder') || '';
      if (REPLY_PLACEHOLDERS.some(p => placeholder.includes(p))) return true;
      if (POST_PLACEHOLDERS.some(p => placeholder.includes(p))) return false;
    }

    // 投稿エリアの兄弟・親に返信先ツイートが存在するか
    const tweetBlock = toolbarEl.closest('[data-testid="toolBar"]')?.closest('div');
    if (tweetBlock) {
      const hasReplyTarget = !!tweetBlock.querySelector('[data-testid="tweet"]')
                          || !!tweetBlock.parentElement?.querySelector('[data-testid="tweet"]')
                          || !!root.querySelector('[data-testid="tweet"]');
      if (hasReplyTarget) return true;
    }

    return false;
  };

  // ----------------------------------------------------------------
  //  DOM セットアップ
  // ----------------------------------------------------------------
  const setup = () => {
    document.querySelectorAll('[data-testid*="tweetButton"]:not(.cross-btn-bound)').forEach(bt => {
      bt.classList.add('cross-btn-bound');
      bt.addEventListener('click', handleAction, true);
    });

    document.querySelectorAll(POST_TOOLBAR_SELECTOR).forEach(tb => {
      tb.classList.add('cross-injected');

      // ツールバー直下に独立した行を挿入（案A）
      const bar = document.createElement('div');
      bar.className = 'cross-bar';
      bar.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:4px',
        'padding:5px 12px 6px',
        'border-top:1px solid #2f3336',
        'background:transparent',
        'flex-wrap:wrap',
      ].join(';');

      const platforms = [
        { cls: 'cross-bsky-cb',    checked: settings.bsky_crosspost_checked,     visible: settings.bsky_visible,     emoji: '🦋', label: 'Bluesky'  },
        { cls: 'cross-mast-cb',    checked: settings.mastodon_crosspost_checked,  visible: settings.mastodon_visible,  emoji: '🐘', label: 'Mastodon' },
        { cls: 'cross-threads-cb', checked: settings.threads_crosspost_checked,   visible: settings.threads_visible,   emoji: '🧵', label: 'Threads'  },
      ];

      // 返信モードの場合はチェックを強制OFF（ダイアログ内のみ）
      const replyMode = isReplyMode(tb);

      platforms.forEach(({ cls, checked, visible, emoji, label }) => {
        if (!visible) return;
        const effectiveChecked = replyMode ? false : checked;
        const lbl = document.createElement('label');
        lbl.title = label;
        lbl.style.cssText = [
          'display:inline-flex',
          'align-items:center',
          'gap:5px',
          'padding:3px 10px 3px 7px',
          'border-radius:14px',
          'border:1px solid #2f3336',
          'cursor:pointer',
          'font-size:12px',
          'color:#71767b',
          'user-select:none',
          'transition:background 0.15s,border-color 0.15s,color 0.15s',
        ].join(';');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = cls;
        cb.checked = effectiveChecked;
        cb.style.cssText = 'width:13px;height:13px;cursor:pointer;accent-color:#1d9bf0;';
        const span = document.createElement('span');
        span.textContent = emoji + ' ' + label;
        lbl.appendChild(cb);
        lbl.appendChild(span);

        // チェック状態に応じてスタイルを切り替え
        const updateStyle = () => {
          if (cb.checked) {
            lbl.style.background    = 'rgba(29,155,240,0.12)';
            lbl.style.borderColor   = 'rgba(29,155,240,0.5)';
            lbl.style.color         = '#1d9bf0';
          } else {
            lbl.style.background    = 'transparent';
            lbl.style.borderColor   = '#2f3336';
            lbl.style.color         = '#71767b';
          }
        };
        updateStyle();
        cb.addEventListener('change', updateStyle);
        bar.appendChild(lbl);
      });

      // 全サービスが非表示なら bar 自体を隠す
      if (bar.children.length === 0) return;

      // toolBar div の直後に挿入
      tb.parentNode.insertBefore(bar, tb.nextSibling);
      console.debug('[Crosspost] checkboxes injected ✓');
    });
  };

  window.addEventListener('keydown', handleAction, true);
  const observer = new MutationObserver(setup);
  observer.observe(document.body, { childList: true, subtree: true });
  setup();

  console.log('[Crosspost] v0.24.5 loaded ✓');

})();
