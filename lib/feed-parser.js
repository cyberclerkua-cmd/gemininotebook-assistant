/* DOMParser runs in the offscreen document, where XML DOM APIs are available. */
const FeedParser = {
  parse(xml, documentUrl) {
    if (typeof xml !== 'string' || !xml.trim()) throw new Error('Empty or invalid XML');
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    if (document.querySelector('parsererror')) throw new Error('Invalid XML feed');
    const root = document.documentElement;
    const children = (element, name) => Array.from(element?.children || []).filter(child => child.localName === name);
    const child = (element, name) => children(element, name)[0];
    const text = (element, name) => (child(element, name)?.textContent || '').trim();

    function baseUrl(element) {
      const parents = [];
      for (let node = element; node; node = node.parentElement) parents.unshift(node);
      let base = documentUrl;
      for (const node of parents) {
        const value = node.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'base');
        if (value) base = new URL(value, base).href;
      }
      return base;
    }
    function url(value, element) {
      if (!value) return '';
      try {
        const parsed = new URL(value.trim(), baseUrl(element));
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
      } catch (_) { return ''; }
    }
    function atomLink(element) {
      const links = children(element, 'link');
      const link = links.find(link => !link.getAttribute('rel') || link.getAttribute('rel') === 'alternate');
      return link ? url(link.getAttribute('href') || link.textContent, link) : '';
    }

    let title = '';
    let description = '';
    let type;
    const items = [];
    const sitemaps = [];
    if (root.localName === 'rss' || root.localName === 'RDF') {
      type = 'rss';
      const channel = child(root, 'channel') || root;
      title = text(channel, 'title');
      description = text(channel, 'description');
      const entries = root.localName === 'RDF' ? children(root, 'item') : children(channel, 'item');
      for (const entry of entries) {
        const guid = child(entry, 'guid');
        const link = url(text(entry, 'link'), entry) || atomLink(entry) ||
          (guid && guid.getAttribute('isPermaLink') !== 'false' ? url(guid.textContent, guid) : '');
        if (link) items.push({ url: link, title: text(entry, 'title'),
          description: text(entry, 'description'), pubDate: text(entry, 'pubDate') || text(entry, 'date') });
      }
    } else if (root.localName === 'feed') {
      type = 'atom';
      title = text(root, 'title');
      description = text(root, 'subtitle');
      for (const entry of children(root, 'entry')) {
        const link = atomLink(entry);
        if (link) items.push({ url: link, title: text(entry, 'title'),
          description: text(entry, 'summary') || text(entry, 'content'),
          pubDate: text(entry, 'published') || text(entry, 'updated') });
      }
    } else if (root.localName === 'urlset') {
      type = 'sitemap';
      for (const entry of children(root, 'url')) {
        const link = url(text(entry, 'loc'), entry);
        if (link) items.push({ url: link, title: link, description: '', pubDate: text(entry, 'lastmod') });
      }
    } else if (root.localName === 'sitemapindex') {
      type = 'sitemapindex';
      for (const entry of children(root, 'sitemap')) {
        const link = url(text(entry, 'loc'), entry);
        if (link) sitemaps.push(link);
      }
    } else {
      throw new Error('Not a recognized RSS, Atom or Sitemap XML document');
    }
    return { title, description, type, items: [...new Map(items.map(item => [item.url, item])).values()], sitemaps };
  }
};
