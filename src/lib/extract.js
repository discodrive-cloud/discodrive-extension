import browser from 'webextension-polyfill'

const MAX_CONTENT_BYTES = 2 << 20

// Extracts the readable article from the live DOM of a tab (paywalls, logins,
// JS-rendered pages). null means the caller should let the server fetch instead.
export async function extractFromTab(tabId) {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['content/extract.js'] })
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__ddExtract?.() ?? null,
    })
    const article = results?.[0]?.result
    if (!article?.content) return null
    if (new TextEncoder().encode(article.content).length > MAX_CONTENT_BYTES) return null
    return article
  } catch {
    return null
  }
}
