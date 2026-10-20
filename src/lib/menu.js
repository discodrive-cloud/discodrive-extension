
// Media wins over the wrapping link: an image on Wikipedia links to its HTML
// description page. data:/blob: are unreachable for the server, so they fall back.
export function pickDownloadUrl(info) {
  const http = (u) => typeof u === 'string' && /^https?:\/\//i.test(u)
  if (http(info?.srcUrl)) return info.srcUrl
  if (http(info?.linkUrl)) return info.linkUrl
  return ''
}
