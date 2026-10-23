<p align="center">
  <img src="docs/img/logo.jpg" alt="DiscoDrive" width="100%">
</p>

# DiscoDrive browser extension

Browser extension for [DiscoDrive](https://github.com/discodrive-cloud/discodrive), a self-hosted personal cloud. It gives you one "save to DiscoDrive" action: send files to your server for download, save pages to Pocket (read later), and keep bookmarks in sync between browsers through your own cloud.

- **Browsers:** Firefox and Chromium-based browsers (Chrome, Edge, Brave, Vivaldi, …). One codebase: WebExtensions, Manifest V3, `webextension-polyfill`.
- **Thin client:** downloads, saved articles and the bookmark tree live on the DiscoDrive server. The extension only extracts the readable text of a page you save (with Mozilla Readability) and sends it, or a link, to your server.
- **Your server only:** the extension talks to the server you configure and nothing else. Host access is requested at runtime, for that server alone. No analytics or tracking — see the [privacy policy](PRIVACY.md).

## Install

You need a running [DiscoDrive server](https://github.com/discodrive-cloud/discodrive).

### From the browser stores

The easiest way:

- **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/discodrive/)
- **Chrome, Edge, Brave, Vivaldi and other Chromium browsers:** Chrome Web Store (coming soon)

### Ready-made package for Chromium browsers

Until the Chrome Web Store listing is live: download `discodrive-<version>-chromium.zip` from [Releases](https://github.com/discodrive-cloud/discodrive-extension/releases/latest), unzip it into a folder you will keep, open `chrome://extensions`, enable "Developer mode" → "Load unpacked" → choose that folder.

### Build it yourself

Requires Node.js and npm.

```sh
git clone https://github.com/discodrive-cloud/discodrive-extension.git
cd discodrive-extension
npm install
npm run build          # → dist/
```

Then load `dist/` into your browser:

- **Firefox:** `about:debugging` → "This Firefox" → "Load Temporary Add-on…" → `dist/manifest.json`. A temporary add-on is removed when Firefox restarts.
- **Chromium:** `chrome://extensions` → enable "Developer mode" → "Load unpacked" → `dist/`. Keep the folder in place: the browser loads the extension from it.

## Setup

In the extension options, enter your server URL → "Save and grant access" → "Pair" (confirm the code in the DiscoDrive web UI) → turn on "Sync bookmarks with DiscoDrive".

A user guide with screenshots is built in: options → "Guide". It is available in all seven interface languages.

## Development

| Command | What it does |
|---|---|
| `npm run build` | build into `dist/` |
| `npm run build:release` | same, without source maps |
| `npm run watch` | rebuild on change |
| `npm run dev:firefox` / `npm run dev:chromium` | run a browser with the extension loaded (`web-ext run`) |
| `npm run lint` | `web-ext lint` |
| `npm test` | sync, auth and task tests (`node:test`, with a fake `browser` and server in `test/`) |
| `npm run package` | zip into `web-ext-artifacts/` |
| `npm run package:chromium` | zip for Chromium stores (no Firefox-only manifest keys) |
| `npm run sign` | signed XPI for Firefox (requires AMO API keys) |

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE), the same license as the DiscoDrive server: free for any non-commercial use, modifications allowed, commercial use not allowed.

For a commercial license, write to [info@discodrive.app](mailto:info@discodrive.app).

## ❤️ Support the project

DiscoDrive is developed independently, with no outside investment. Feedback and suggestions are welcome — open an issue or write to [info@discodrive.app](mailto:info@discodrive.app).

And if you enjoy DiscoDrive and want to see it keep growing — support the project:

- **[Star DiscoDrive on GitHub](https://github.com/discodrive-cloud/discodrive)** ⭐
- **[Ko-fi](https://ko-fi.com/kosmosoid)**
- **[Boosty](https://boosty.to/kosmosoid/donate)**
- **[Cryptocurrency](https://nowpayments.io/donation?api_key=7P893T0-48B4KZH-Q6PXBBT-D79X9TK)** — via NOWPayments

Thank you! Every contribution helps the project move forward.
