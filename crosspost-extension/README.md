# Twitter/X Crosspost Extension

A Chrome Extension (Manifest V3) to crosspost from Twitter/X to **Bluesky**, **Mastodon**, and **Threads** simultaneously.

> Based on the original userscript by [59de44955ebd](https://github.com/59de44955ebd/twitter-to-bsky) — Licensed under MIT.

---

## Features

- ✅ Crosspost to Bluesky, Mastodon, Threads in one click
- 🖼 Image support (up to 4 images) — via [catbox.moe](https://catbox.moe) for Threads (no account required)
- 🎠 Carousel post for 2–4 images on Threads
- 🔗 YouTube card embed for Bluesky (title + channel name via oEmbed)
- ⌨️ Keyboard shortcut: `Ctrl+Enter` / `Alt+Enter`
- 🔑 Threads token expiry management with one-click refresh
- 👁 Per-service visibility toggle (hide services you don't use)
- ⚡ Parallel posting to all platforms simultaneously
- 🔄 Auto-reload Twitter tab after saving settings

---

## Installation

1. Download or clone this repository
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the `chrome-extension` folder
5. Click the extension icon and configure each service

---

## Setup

### 🦋 Bluesky
- Go to [bsky.social](https://bsky.social) → Settings → Privacy and Security → **App passwords**
- Create a new App Password and enter it in the extension settings

### 🐘 Mastodon
- Go to your instance → Settings → Development → **New Application**
- Copy the Access Token and enter it in the extension settings

### 🧵 Threads
1. Create an app at [Meta for Developers](https://developers.facebook.com/)
2. Add the **Threads API** product
3. Get a long-lived access token (valid for 60 days)
4. Get your User ID:
   ```
   GET https://graph.threads.net/v1.0/me?access_token=YOUR_TOKEN
   ```
5. Enter both values in the extension settings
6. Use the **「更新」(Refresh)** button before the token expires

### 📦 Image uploader (for Threads image posts)
No setup required. Threads API requires a public image URL — this extension handles that automatically using one of the following methods:

| Condition | Method |
|-----------|--------|
| Bluesky is configured | **Bluesky CDN** is used as relay — no external service needed |
| Bluesky is not configured | **catbox.moe** or **litterbox** is used as relay |

**Why Bluesky CDN?** When you upload an image to Bluesky, it gets a permanent public URL on `cdn.bsky.app`. This extension reuses that URL to pass to the Threads API, eliminating dependency on third-party uploaders entirely.

> **Note:** If you only use Mastodon or Threads (without Bluesky), catbox.moe / litterbox is still required. This is because the Bluesky CDN relay only works when Bluesky credentials are configured.

Once Threads fetches the image, it's stored on Meta's CDN — the relay URL is only needed at the moment of posting.

---

## How it works

```
Twitter/X post
    ↓ Click tweet button (crosspost checkboxes checked)
    ├── Bluesky  — direct blob upload via API
    ├── Mastodon — direct blob upload via API
    └── Threads  — image relay → Threads API
                   ├── Bluesky configured: blob → Bluesky CDN (cdn.bsky.app) → Threads API
                   └── Bluesky not configured: blob → catbox.moe → Threads API
```

All three platforms are posted in **parallel** for maximum speed.

---

## Checkbox behavior after posting

| Result | Behavior |
|--------|----------|
| All success | Checkboxes reset to default settings |
| Partial failure | Failed platforms stay checked (easy retry), succeeded platforms unchecked |

---

## Version history

| Version | Changes |
|---------|---------|
| Version | Changes |
|---------|---------|\
| v0.24.0 | Use Bluesky CDN (cdn.bsky.app) as Threads image relay when Bluesky is configured — eliminates catbox.moe dependency for Bluesky users; catbox remains as fallback when Bluesky is not configured |
| v0.23.3 | Fix 4-image carousel timeout: extend bgFetch timeout 90s→180s; add extra polling intervals for CAROUSEL container (max 59s vs 29s for others) |
| v0.23.2 | Fix hang: wrap execCrosspost in try/finally to guarantee is_processing reset on any error (e.g. bgFetch port closed during carousel polling) |
| v0.23.1 | Fix image upload CORS error: catbox.moe / litterbox changed CORS policy; route uploads through background.js instead of direct fetch |
| v0.23.0 | Keyboard shortcuts Alt+0〜3 for checkbox toggle (Alt+0=all, Alt+1=Bsky, Alt+2=Threads, Alt+3=Mastodon); option to disable Alt shortcuts for conflicting environments; settings panel reordered (Bluesky→Threads→Mastodon); popup width expanded to 500px |
| v0.22.15 | Fix critical crosspost bug (v0.22.11 regression): restore v0.22.6 dialog-only isReplyMode; home screen false positive was skipping crosspost entirely |
| v0.22.11 | Auto-uncheck checkboxes in reply dialog (dialog-only) |
| v0.22.6 | Upload images to catbox directly from content.js (bypass bgFetch port issue) |
| v0.22 | Service Worker keep-alive port sharing for long crosspost sessions |
| v0.21 | Service Worker keep-alive (PING every 20s to prevent SW sleep during upload) |
| v0.20 | Auto-uncheck crosspost boxes in reply mode (placeholder + DOM detection, JP/EN) |
| v0.19 | Grey light theme for settings popup, add homepage_url to manifest |
| v0.18 | OGP card embed for general URLs on Bluesky (title, description, thumbnail) |
| v0.17 | Progressive image compression for Bluesky (auto-resize until under 976KB) |
| v0.16 | Uploader selector (catbox.moe / litterbox), restrict host_permissions, fix description version |
| v0.15 | Wider popup (420px) and larger font sizes for readability |
| v0.14 | Auto-reload Twitter tab after saving settings |
| v0.13 | Dedicated crosspost bar below Twitter toolbar (Plan A UI) |
| v0.12 | Per-service visibility toggle in settings |
| v0.11 | YouTube oEmbed for Bluesky card description |
| v0.10 | First stable release as Chrome Extension |

> **既知の仕様:** バルーンアイコンから開く返信ダイアログではチェックボックスが自動OFFになります。返信をキャンセルしてホーム画面に戻った場合はOFFのままになります。再度マルチポストする場合は手動でONにしてください。

---

## License

MIT License — see [LICENSE](LICENSE)

Original work: Copyright (c) 59de44955ebd  
Modifications: Copyright (c) 2026 KinaPPP
