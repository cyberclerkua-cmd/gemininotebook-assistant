/* URL validation is shared by the worker and extension pages. */
const UrlUtils = {
  httpUrl(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Missing or invalid URL');
    let url;
    try { url = new URL(input.trim()); } catch (_) { throw new Error('Invalid URL: ' + input); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are supported');
    return url.href;
  },

  sourceKey(input) {
    const url = new URL(this.httpUrl(input));
    const videoId = this.videoId(url.href);
    if (videoId) return 'youtube:' + videoId;
    url.hash = '';
    return url.href;
  },

  videoId(input) {
    if (typeof input !== 'string') return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
    try {
      const url = new URL(input);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      const host = url.hostname.toLowerCase();
      let id;
      if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0];
      else if (host === 'youtube.com' || host.endsWith('.youtube.com') ||
               host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
        if (url.pathname === '/watch') id = url.searchParams.get('v');
        else id = url.pathname.match(/^\/(?:shorts|embed|v)\/([^/]+)/)?.[1];
      }
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    } catch (_) { return null; }
  },

  // Self-contained because Chrome serializes this function into the page.
  pageYouTubeUrls: function() {
    function normalize(input) {
      try {
        const url = new URL(input, location.href);
        const host = url.hostname.toLowerCase();
        let id;
        if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0];
        else if (host === 'youtube.com' || host.endsWith('.youtube.com') ||
                 host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
          id = url.pathname === '/watch' ? url.searchParams.get('v')
            : url.pathname.match(/^\/(?:shorts|embed|v)\/([^/]+)/)?.[1];
        }
        return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
      } catch (_) { return null; }
    }
    const urls = new Set();
    document.querySelectorAll('a[href], iframe[src]').forEach(element => {
      const url = normalize(element.href || element.src);
      if (url) urls.add(url);
    });
    return [...urls];
  }
};
