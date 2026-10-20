# Privacy Policy — DiscoDrive browser extension

_Last updated: October 20, 2026_

The DiscoDrive browser extension connects your browser to **a DiscoDrive server that you choose and run yourself** (or that someone you trust runs for you). This policy explains what the extension handles and where that data goes.

## The short version

- The extension sends data **only to the DiscoDrive server whose address you enter** in its settings. It contacts no other server.
- The developer of the extension **does not receive, collect or have access to** any of your data.
- There is **no analytics, tracking, advertising or telemetry** of any kind.
- Your data is never sold or shared with third parties.

## What the extension sends to your server, and when

| Data | When | Why |
|---|---|---|
| Your bookmarks (titles, URLs, folder structure) | Only if you turn on "Sync bookmarks with DiscoDrive" | To keep the same bookmarks in every browser connected to your server |
| The address and title of a page | When you save a page to Pocket or send a link for download | To create the saved item on your server |
| The readable text of a page (extracted in your browser) | When you save a page to Pocket | So your server can store the article for reading later |
| Cookies of the website you download a file from | Only when you send a download link **and** have allowed access for that website | So your server can download files that require you to be signed in to that site |

Website cookies are optional. The extension asks for permission for a specific website the first time you send a download from it. If you decline, downloads still work for files that don't need a login. You can revoke the permission at any time in your browser's extension settings.

## What the extension stores in your browser

- The address of your server and your settings (language, sync on/off).
- A device token and a short-lived access token issued by your server when you pair the extension. They are used only to talk to that server and are deleted when you click "Unpair".
- Bookmark sync state: which local bookmark corresponds to which bookmark on the server, and changes not yet sent.
- A short list of recent saves and downloads shown in the popup.

This data stays in the extension's local storage on your device.

## Permissions

| Permission | Used for |
|---|---|
| Access to your server's address | Talking to the DiscoDrive server you configured. Requested when you save the server address. |
| Access to a specific website (optional) and cookies (optional) | Passing your session on that site to your server for login-protected downloads. Requested per site, only when you send a download. |
| `bookmarks` | Two-way bookmark sync, only when you turn it on. |
| `activeTab`, `scripting` | Extracting the readable text of the current page when you click "Pocket it". |
| `contextMenus` | The "Save to DiscoDrive Pocket" and "Download to DiscoDrive" items in the right-click menu. |
| `notifications` | Telling you when a save or download finishes or fails. |
| `storage` | Keeping the settings and sync state listed above. |
| `alarms` | Periodic bookmark sync and checking the progress of downloads. |

## Your server

What happens to data on the server is under the control of whoever runs it. If you run DiscoDrive yourself, the data stays on your own hardware. The DiscoDrive server is [open for inspection](https://github.com/discodrive-cloud/discodrive).

## Changes to this policy

Changes are published in this file in the [extension's repository](https://github.com/discodrive-cloud/discodrive-extension); its history shows every revision.

## Contact

Questions: [info@discodrive.app](mailto:info@discodrive.app).
