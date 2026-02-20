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
    }, (items) => { settings = items; resolve(items); });
  });

  await loadSettings();

  // ----------------------------------------------------------------
  //  background.js との通信（ポート方式）
  // ----------------------------------------------------------------
  let _portIdCounter = 0;

  const bgFetch = (params) => new Promise((resolve, reject) => {
    const id   = ++_portIdCounter;
    const port = chrome.runtime.connect({ name: 'crosspost-fetch' });

    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('bgFetch timeout: ' + params.url));
    }, 60000);

    port.onMessage.addListener((msg) => {
      if (msg.id !== id) return;
      clearTimeout(timer);
      port.disconnect();
      if (msg.ok === false && msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
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
    const b64 = await blobToBase64(blob);

    if (settings.uploader === 'litterbox') {
      // litterbox.catbox.moe: 期限付きアップロード（最大1GB）
      const resp = await bgFetch({
        url:      'https://litterbox.catbox.moe/resources/internals/api.php',
        method:   'POST',
        headers:  {},
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
      // catbox.moe: 永久保存
      const resp = await bgFetch({
        url:      'https://catbox.moe/user/api.php',
        method:   'POST',
        headers:  {},
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
    return Promise.all(
      images.map(img => fetch(img.src).then(r => r.blob()).then(uploadToHost))
    );
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
    // 最初は1秒待機、以降2秒間隔（合計最大 1 + 2×14 = 29秒）
    const intervals = [1000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000];

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

    // 【並列】catbox.moe に全画像を同時アップロード
    const uploaderName = settings.uploader === 'litterbox' ? 'litterbox' : 'catbox.moe';
    showToast(`${uploaderName} に画像をアップロード中… (${targetImages.length}枚)`, 'info');
    const catboxUrls = await uploadAllToHost(targetImages);
    console.log('[Crosspost] catbox URLs:', catboxUrls);

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
    showToast('カルーセルコンテナ作成中…', 'info');
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
    showToast('クロスポスト中…', 'info');

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
    // 全部成功         → デフォルト設定値に戻す（次の新規ツイートはデフォルト通りに）
    // 一部失敗（リトライ想定）→ 成功したものはOFF、失敗したものはチェック維持
    const succeededPlatforms = new Set(success.map(r => r.platform));
    if (failed.length === 0) {
      // 全成功: デフォルト値に戻す
      if (bCb) bCb.checked = settings.bsky_crosspost_checked;
      if (mCb) mCb.checked = settings.mastodon_crosspost_checked;
      if (tCb) tCb.checked = settings.threads_crosspost_checked;
    } else {
      // 一部失敗: 成功したものだけOFF、失敗したものはそのまま
      if (bCb && succeededPlatforms.has('Bluesky'))  bCb.checked = false;
      if (mCb && succeededPlatforms.has('Mastodon')) mCb.checked = false;
      if (tCb && succeededPlatforms.has('Threads'))  tCb.checked = false;
    }

    is_processing = false;
    originalBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 999 }));
  };

  // ----------------------------------------------------------------
  //  トースト通知（error はクリックで閉じる）
  // ----------------------------------------------------------------
  const showToast = (msg, type = 'info') => {
    const existing = document.getElementById('cross-toast');
    if (existing) existing.remove();

    const colors = { info: '#1d9bf0', success: '#00ba7c', error: '#f4212e' };
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
    if (type !== 'error') {
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

      platforms.forEach(({ cls, checked, visible, emoji, label }) => {
        if (!visible) return;
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
        cb.checked = checked;
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
    });
  };

  window.addEventListener('keydown', handleAction, true);
  const observer = new MutationObserver(setup);
  observer.observe(document.body, { childList: true, subtree: true });
  setup();

})();
