import { Readability } from '@mozilla/readability'

globalThis.__ddExtract = function () {
  try {
    const doc = document.cloneNode(true)
    const article = new Readability(doc).parse()
    if (!article || !article.content) return null
    return {
      title: article.title || document.title || '',
      content: article.content,
    }
  } catch {
    return null
  }
}
