/* Gemini Notebook Assistant v3.3.9 — Background Service Worker
 * Account-scoped RPC clients, PDF capture/upload, YouTube comments,
 * persistent queue with an alarm watchdog, history and feed parsing.
 */

importScripts('lib/extension-client.js', 'lib/url-utils.js', 'lib/youtube-comments-api.js', 'lib/comments-to-md.js');

// ─── Fetch with timeout ───
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function rpcFailure(message, outcome) {
  const error = new Error(message);
  error.rpcOutcome = outcome;
  return error;
}

// ─── Gemini Notebook RPC API (reverse-engineered, no public API) ───
const NotebookLMAPI = {
  tokens: {},
  tokensAuthuser: null,  // tracks which account the cached tokens belong to
  tokensFetchedAt: 0,

  async getTokens(authuser = 0) {
    // Return cached tokens if they belong to the same account and are still valid.
    if (this.tokensAuthuser === authuser && this.tokens && this.tokens.SNlM0e && this.tokens.cfb2h &&
        Date.now() - this.tokensFetchedAt < 5 * 60 * 1000) {
      return this.tokens;
    }

    const url = `https://notebook.google.com/?authuser=${authuser}`;
    const resp = await fetchWithTimeout(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`Could not load NotebookLM: HTTP ${resp.status}`);
    const html = await resp.text();

    const cfb2h = html.match(/"cfb2h":"([^"]+)"/);
    const snlm0e = html.match(/"SNlM0e":"([^"]+)"/);
    if (!cfb2h || !snlm0e) throw new Error('Could not extract NLM tokens. Are you logged in?');

    this.tokens = {
      cfb2h: cfb2h[1],
      SNlM0e: snlm0e[1],
      authuser,
      origin: resp.url && /^https:\/\/notebook(?:lm)?\.google\.com\//.test(resp.url)
        ? new URL(resp.url).origin : 'https://notebook.google.com'
    };
    this.tokensAuthuser = authuser;
    this.tokensFetchedAt = Date.now();
    return this.tokens;
  },

  extractNotebookIdFromUrl(url) {
    const match = url && url.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  },

  // ─── Core RPC method ───
  // Returns the raw response text. Use rpcChecked() for automatic error
  // detection — the batchexecute API returns HTTP 200 even when the RPC
  // itself fails (the error is embedded in the response body as ["er",...]).
  async rpc(rpcId, params, sourcePath = '/') {
    if (!this.tokens.cfb2h) throw new Error('Not authenticated');

    const au = this.tokens.authuser || 0;
    const url = new URL('/_/LabsTailwindUi/data/batchexecute', this.tokens.origin || 'https://notebook.google.com');
    url.searchParams.set('rpcids', rpcId);
    url.searchParams.set('source-path', sourcePath);
    url.searchParams.set('f.sid', this.tokens.cfb2h);
    url.searchParams.set('hl', 'en');
    url.searchParams.set('authuser', au);
    url.searchParams.set('_reqid', Math.floor(Math.random() * 900000 + 100000));

    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcId, JSON.stringify(params), null, 'generic']]]),
      'at': this.tokens.SNlM0e
    });

    let resp;
    try {
      resp = await fetchWithTimeout(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        credentials: 'include',
        body
      });
    } catch (error) {
      // A transport failure does not tell us whether Google committed a write.
      throw rpcFailure(`RPC ${rpcId}: ${error.message}`, 'unknown');
    }

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        this.tokens = {};
        this.tokensFetchedAt = 0;
      }
      throw rpcFailure(`RPC ${rpcId} failed: HTTP ${resp.status}`,
        resp.status >= 500 || resp.status === 408 ? 'unknown' : 'rejected');
    }
    let text;
    try { text = await resp.text(); }
    catch (error) { throw rpcFailure(`RPC ${rpcId}: ${error.message}`, 'unknown'); }
    const parsed = this._parseBatchexecuteResponse(text);
    if (parsed.error) throw rpcFailure(`RPC ${rpcId} error: ${parsed.error}`, parsed.malformed ? 'unknown' : 'rejected');
    return text;
  },

  // ─── RPC with automatic error detection ───
  // Calls rpc() then parses the batchexecute response envelope to detect
  // RPC-level errors. Throws Error with the server's error message if the
  // RPC failed. Returns { text, parsed } where parsed is the decoded JSON
  // payload (or null if parsing failed).
  async rpcChecked(rpcId, params, sourcePath = '/') {
    const text = await this.rpc(rpcId, params, sourcePath);
    const parsed = this._parseBatchexecuteResponse(text);
    if (parsed && parsed.error) {
      throw new Error(`RPC ${rpcId} error: ${parsed.error}`);
    }
    return { text, raw: text, parsed };
  },

  // Parse a batchexecute response envelope.
  // Format: )]}'\n[["wrb.fr","<rpcId>","<json>",...]] or [["er",...]]
  // Returns { error: string|null, data: any|null, raw: string }
  _parseBatchexecuteResponse(text) {
    if (!text) return { error: 'Empty RPC response', data: null, raw: '', malformed: true };
    try {
      const json = text.replace(/^\s*\)\]\}'\s*/, '').trim();
      let frames;
      try { frames = [JSON.parse(json)]; } catch (_) {
        // batchexecute streams byte-count lines followed by JSON envelopes.
        frames = json.split('\n').filter(line => line.trim().startsWith('[')).map(line => JSON.parse(line));
      }
      const arr = frames.flatMap(frame => Array.isArray(frame) && typeof frame[0] === 'string' ? [frame] : frame);
      if (!frames.length || !Array.isArray(arr)) throw new Error('Invalid response envelope');

      // Look for error envelope: ["er", null, null, null, N, [... , "<msg>"]]
      for (const entry of arr) {
        if (Array.isArray(entry) && entry[0] === 'er') {
          // Error structure: ["er", null, null, null, statusCode, ["...","...",...,"<error message>"]]
          const errData = entry[5];
          let msg = 'Unknown RPC error';
          if (Array.isArray(errData)) {
            // The last non-empty string is usually the message
            for (let i = errData.length - 1; i >= 0; i--) {
              if (typeof errData[i] === 'string' && errData[i].trim()) {
                msg = errData[i];
                break;
              }
            }
          }
          return { error: msg, data: null, raw: text };
        }
      }

      // Look for success data: ["wrb.fr", "<rpcId>", "<json-string>", ...]
      let data = null;
      let foundEnvelope = false;
      for (const entry of arr) {
        if (Array.isArray(entry) && entry[0] === 'wrb.fr') {
          foundEnvelope = true;
          if (entry[2] == null && typeof entry[5] === 'number' && entry[5] !== 0) {
            return { error: `RPC status ${entry[5]}`, data: null, raw: text };
          }
          try {
            data = typeof entry[2] === 'string' ? JSON.parse(entry[2]) : entry[2];
          } catch (_) {
            data = entry[2];
          }
          break;
        }
      }
      if (!foundEnvelope) throw new Error('Missing RPC result envelope');
      return { error: null, data, raw: text };
    } catch (e) {
      return { error: 'Invalid RPC response: ' + e.message, data: null, raw: text, malformed: true };
    }
  },

  // ─── List Google accounts ───
  async listAccounts() {
    try {
      const resp = await fetchWithTimeout(
        'https://accounts.google.com/ListAccounts?json=standard&source=ogb&md=1&cc=1&mn=1&mo=1&gpsia=1&fwput=860&listPages=1&origin=https%3A%2F%2Fwww.google.com',
        { credentials: 'include' }
      );
      const text = await resp.text();

      // Response format: postMessage('...' , 'https://...')
      const match = text.match(/postMessage\('([^']*)'\s*,\s*'https:/);
      if (!match) {
        // Fallback: try direct JSON parse (older format)
        try {
          const clean = text.replace(/^[^[]*/, '');
          const data = JSON.parse(clean);
          if (Array.isArray(data) && Array.isArray(data[0])) {
            return data[0]
               .map((acc, idx) => ({ email: acc[3], name: acc[2] || '', photo: acc[4] || '', authuser: idx }))
               .filter(acc => typeof acc.email === 'string' && acc.email.includes('@'));
          }
        } catch (e2) {}
        return [];
      }

      // Decode hex-escaped characters
      const decoded = match[1]
        .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\'/g, "'");

      const parsed = JSON.parse(decoded);
      const accounts = parsed[1] || [];

      return accounts
        .map((acc, idx) => ({
          email: acc[3] || '',
          name: acc[2] || '',
          photo: acc[4] || '',
          authuser: idx
        }))
        .filter(acc => typeof acc.email === 'string' && acc.email.includes('@'));
    } catch (e) {
      console.error('listAccounts error:', e);
      return [];
    }
  },

  // ─── Notebooks ───
  async listNotebooks() {
    const resp = await this.rpc('wXbhsf', [null, 1, null, [2]]);
    return this._parseNotebookList(resp);
  },

  _parseNotebookList(text) {
    try {
      const decoded = this._parseBatchexecuteResponse(text);
      if (decoded.error) throw new Error(decoded.error);
      const inner = decoded.data;
      if (!inner || !inner[0]) return [];
      return inner[0]
        .filter(item => item && item.length >= 3)
        .map(item => ({
          id: item[2],
          title: (item[0] || '').trim() || 'Untitled',
          sources: Array.isArray(item[1]) ? item[1].length : 0,
          emoji: item[3] || ''
        }))
        .filter(nb => nb.id);
    } catch (e) {
      console.error('parseNotebookList error:', e);
      throw new Error('Could not parse notebook list: ' + e.message);
    }
  },

  async createNotebook(title, emoji) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('Notebook title is required');
    title = title.trim();
    const resp = await this.rpc('CCqFvf', [title]);
    const data = this._parseBatchexecuteResponse(resp).data;
    const record = Array.isArray(data?.[0]) ? data[0] : data;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const candidates = JSON.stringify(data).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    const id = typeof record?.[2] === 'string' && uuid.test(record[2]) ? record[2]
      : candidates.find(candidate => candidate.toLowerCase() !== title.toLowerCase());
    if (!id) throw new Error('Failed to create notebook');
    return { id, title, emoji };
  },

  // ─── Sources ───
  async addSource(notebookId, url) {
    return this.addSources(notebookId, [url]);
  },

  // YouTube URL detection — covers watch, shorts, embed, youtu.be,
  // m.youtube.com, music.youtube.com, youtube-nocookie.com.
  isYouTubeUrl(u) {
    return !!UrlUtils.videoId(u);
  },

  async addSources(notebookId, urls, { onAdded } = {}) {
    requireId(notebookId, 'Notebook');
    if (!Array.isArray(urls) || !urls.length) throw new Error('At least one URL is required');
    const items = urls.map(url => ({ url: UrlUtils.httpUrl(url), status: 'pending' }));
    const regular = items.filter(item => !this.isYouTubeUrl(item.url));
    const youtube = items.filter(item => this.isYouTubeUrl(item.url));
    const batches = [...(regular.length ? [regular] : []), ...youtube.map(item => [item])];
    const wrapper = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]];
    const report = message => ({
      success: items.every(item => item.status === 'added'),
      count: items.filter(item => item.status === 'added').length,
      results: items.map(item => ({ ...item })),
      ...(message ? { message } : {})
    });

    for (const batch of batches) {
      const sources = batch.map(item => this.isYouTubeUrl(item.url)
        ? [null, null, null, null, null, null, null, [item.url], null, null, 1]
        : [null, null, [item.url], null, null, null, null, null, null, null, 1]);
      try {
        await this.rpc('izAoDd', [sources, notebookId, wrapper], `/notebook/${notebookId}`);
      } catch (error) {
        for (const item of batch) item.status = error.rpcOutcome === 'unknown' ? 'uncertain' : 'failed';
        error.importResult = report(error.message);
        throw error;
      }
      for (const item of batch) item.status = 'added';
      // Record acknowledgements before starting the next independent RPC.
      if (onAdded) await onAdded(batch.map(item => item.url));
    }
    return report();
  },

  // Add a text/pasted source to a notebook.
  //
  // The izAoDd RPC expects the first param to be a LIST of source descriptors.
  // Each descriptor is an 8-element array (same length as URL descriptors) so
  // that Gemini Notebook recognises it as a valid source:
  //
  //   URL source:  [null, null,  [url], null, null, null, null, null]
  //   Text source: [null, title, [text], null, null, null, null, null]
  //                ^     ^      ^
  //                |     |      text content wrapped in a 1-element array
  //                |     source title (string)
  //                always null
  //
  // The text goes at index 2 (same position as the URL in URL sources),
  // wrapped in a single-element array. The title goes at index 1.
  //
  // Add a pasted-text source to a notebook via the izAoDd RPC.
  //
  // SOURCE FORMAT — verified against notebooklm-py RPC reference
  // (live-captured 2026-06-15 from a real Chrome session):
  //
  //   params = [
  //     [[null, [title, content], null, 2, null, null, null, null, null, null, 1]],
  //     notebookId,
  //     [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]]
  //   ]
  //
  // The source spec is an 11-element array:
  //   [0]:  null
  //   [1]:  [title, content]  — 2-element array with title string and text content
  //   [2]:  null
  //   [3]:  2                 — PASTED_TEXT source-type code (4=PASTED_TEXT in
  //                             the SourceType map, but the RPC uses 2 here)
  //   [4-9]: null
  //   [10]: 1                 — trailing flag
  //
  // The third param is the shared request-options wrapper:
  //   [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]]
  //
  // Previous broken attempts:
  //   v3.0:     [[[null, title, text]]]                          — wrong nesting
  //   fix #1:   [[null, title, text]]                            — 3-elem descriptor
  //   fix #2:   [[null, title, [text], null, null, null, null, null]] — 8-elem, title at [1]
  //   fix #3:   [[null, null, [null, title, text], null, ...]]   — 8-elem, 3-elem at [2]
  //   CORRECT:  [[null, [title, text], null, 2, null, null, null, null, null, null, 1]]
  async addTextSource(notebookId, text, title = 'Imported content', opts = {}) {
    requireId(notebookId, 'Notebook');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Text source must not be empty');
    // 11-element source spec: [title, content] at position 1, type code 2 at position 3.
    const source = [[null, [title, text], null, 2, null, null, null, null, null, null, 1]];
    // Shared request-options wrapper (live-captured format).
    const wrapper = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]];

    // Pre-send source count for verification (enabled by default for text
    // sources because they are prone to silent format failures).
    const verify = opts.verify !== false;
    let beforeSources = null;
    if (verify) {
      try {
        const nbBefore = await this.getNotebook(notebookId);
        beforeSources = nbBefore.sources || [];
      } catch (_) { /* non-fatal */ }
    }

    const { parsed, raw } = await this.rpcChecked(
      'izAoDd',
      [source, notebookId, wrapper],
      `/notebook/${notebookId}`
    );

    // Try to extract a newly-created source ID from the RPC response.
    let newSourceId = null;
    const beforeIds = new Set((beforeSources || []).map(source => source.id));
    if (parsed && parsed.data) {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      function findId(value) {
        if (!Array.isArray(value)) return;
        const id = Array.isArray(value[0]) && value[0].length === 1 ? value[0][0] : null;
        if (!newSourceId && typeof id === 'string' && uuidRe.test(id) && id !== notebookId && !beforeIds.has(id)) newSourceId = id;
        value.forEach(findId);
      }
      findId(parsed.data);
    }

    // A returned source ID is an acknowledgement. Otherwise poll for a new
    // matching ID: total counts can stay unchanged during concurrent deletes.
    if (verify && !newSourceId) {
      if (beforeSources === null) throw new Error('Could not confirm text source creation: notebook details are unavailable');
      for (let attempt = 0; attempt < 3 && !newSourceId; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
        try {
          const notebook = await this.getNotebook(notebookId);
          const created = notebook.sources.find(source => !beforeIds.has(source.id) && source.title === title);
          if (created) newSourceId = created.id;
        } catch (error) { console.debug('Text source verification:', error.message); }
      }
      if (!newSourceId) throw new Error('Source was not created or its creation could not be confirmed');
    }

    return { raw, sourceId: newSourceId };
  },

  // ─── PDF upload (3-step SCOTTY protocol) ───
  async registerPdfSource(notebookId, filename) {
    requireId(notebookId, 'Notebook');
    const resp = await this.rpc(
      'o4cbdc',
      [[[filename]], notebookId, [2], [1,null,null,null,null,null,null,null,null,null,[1]]],
      `/notebook/${notebookId}`
    );
    const inner = this._parseBatchexecuteResponse(resp).data;
    const reference = inner?.[0]?.[0]?.[0];
    // Current Google responses include a full source descriptor, whose first
    // element is [sourceId]. Older responses returned the ID directly here.
    return requireId(Array.isArray(reference) ? reference[0] : reference, 'PDF source');
  },

  async getUploadUrl(notebookId, filename, sourceId, byteLength) {
    const au = this.tokens.authuser || 0;
    const url = `${this.tokens.origin || 'https://notebook.google.com'}/upload/_/?authuser=${au}`;
    const metadata = JSON.stringify({
      PROJECT_ID: notebookId,
      SOURCE_NAME: filename,
      SOURCE_ID: sourceId
    });

    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': byteLength.toString(),
        'x-goog-upload-protocol': 'resumable'
      },
      credentials: 'include',
      body: metadata
    });

    if (!resp.ok) throw new Error(`Failed to get upload URL: ${resp.status}`);
    const uploadUrl = resp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('No upload URL in response');
    return uploadUrl;
  },

  async uploadPdfBytes(uploadUrl, pdfBytes) {
    const resp = await fetchWithTimeout(uploadUrl, {
      method: 'POST',
      headers: {
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': '0',
        'content-type': 'application/pdf'
      },
      credentials: 'include',
      body: pdfBytes
    });
    if (!resp.ok) throw new Error(`PDF upload failed: ${resp.status}`);
    return resp.text();
  },

  async addPdfSource(notebookId, pdfBase64, filename) {
    requireId(notebookId, 'Notebook');
    let binStr;
    try {
      if (typeof pdfBase64 !== 'string') throw new Error();
      binStr = atob(pdfBase64);
      if (!binStr.startsWith('%PDF-')) throw new Error();
    } catch (_) { throw new Error('Invalid PDF base64 data'); }
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    const sourceId = await this.registerPdfSource(notebookId, filename);
    try {
      const uploadUrl = await this.getUploadUrl(notebookId, filename, sourceId, bytes.byteLength);
      await this.uploadPdfBytes(uploadUrl, bytes);
      return { sourceId, filename };
    } catch (error) {
      try { await this.deleteSource(notebookId, sourceId); }
      catch (cleanupError) { console.warn('Incomplete PDF source cleanup:', cleanupError.message); }
      throw error;
    }
  },

  // ─── Get notebook details + sources ───
  async getNotebook(notebookId) {
    requireId(notebookId, 'Notebook');
    const resp = await this.rpc('rLM1Ne', [notebookId, null, [2], null, 0], `/notebook/${notebookId}`);
    return this._parseNotebookDetails(resp);
  },

  _parseNotebookDetails(text) {
    try {
      const decoded = this._parseBatchexecuteResponse(text);
      if (decoded.error) throw new Error(decoded.error);
      const inner = decoded.data;
      if (!inner || !inner[0]) throw new Error('Notebook details are missing');

      const nb = inner[0];
      const sourcesArr = Array.isArray(nb[1]) ? nb[1] : [];
      const typeNames = {
        1:'google_docs',2:'google_other',3:'pdf',4:'pasted_text',5:'web_page',
        8:'generated_text',9:'youtube',11:'uploaded_file',13:'image',14:'word_doc'
      };

      const sources = sourcesArr
        .filter(s => s && Array.isArray(s[0]) && s[0][0])
        .map(s => {
          const id = s[0][0];
          const title = s[1] || 'Untitled';
          const meta = Array.isArray(s[2]) ? s[2] : [];
          const typeCode = meta[4] || 0;
          const driveDocId = Array.isArray(meta[0]) ? meta[0][0] : null;
          const candidates = [meta[7], meta[5]].flat().filter(value => typeof value === 'string');
          const url = candidates.find(value => /^https?:\/\//.test(value)) || null;
          return {
            id, title,
            type: typeNames[typeCode] || 'unknown',
            typeCode, url, driveDocId,
            canSync: driveDocId != null && (typeCode === 1 || typeCode === 2)
          };
        });

      return { id: nb[2] || null, title: nb[0] || '', sources };
    } catch (e) {
      console.error('parseNotebookDetails error:', e);
      throw new Error('Could not parse notebook details: ' + e.message);
    }
  },

  // ─── Delete sources (batch, max 20 per call) ───
  async deleteSource(notebookId, sourceId) {
    requireId(notebookId, 'Notebook');
    requireId(sourceId, 'Source');
    return this.rpc('tGMBJ', [[[sourceId]]], `/notebook/${notebookId}`);
  },

  async deleteSources(notebookId, sourceIds) {
    requireId(notebookId, 'Notebook');
    if (!Array.isArray(sourceIds) || !sourceIds.length) throw new Error('Select at least one source');
    sourceIds = [...new Set(sourceIds.map(id => requireId(id, 'Source')))];
    const batchSize = 20;
    let deleted = 0;
    for (let i = 0; i < sourceIds.length; i += batchSize) {
      const batch = sourceIds.slice(i, i + batchSize).map(id => [id]);
      await this.rpc('tGMBJ', [batch], `/notebook/${notebookId}`);
      deleted += batch.length;
    }
    return { deleted };
  },

  // ─── Drive sync ───
  async checkSourceFreshness(sourceId, notebookId) {
    const resp = await this.rpc('yR9Yof', [null, [sourceId], [2]], `/notebook/${notebookId}`);
    const record = this._parseBatchexecuteResponse(resp).data?.[0];
    // Current Google API: [[null, isFresh, [sourceId]]]. Keep support for
    // the older [[1]] / [[0]] response without treating unknown data as stale.
    if (Array.isArray(record) && typeof record[1] === 'boolean') {
      const returnedId = record[2]?.[0];
      return returnedId && returnedId !== sourceId ? null : record[1];
    }
    const value = record?.[0];
    return value === 1 ? true : value === 0 ? false : null;
  },

  async syncDriveSource(sourceId, notebookId) {
    return this.rpc('FLmJqe', [null, [sourceId], [2]], `/notebook/${notebookId}`);
  },

  getNotebookUrl(notebookId, authuser = 0) {
    return `https://notebook.google.com/notebook/${notebookId}?authuser=${authuser}`;
  }
};

function requireId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} ID is required or invalid`);
  return value;
}

function validateAuthuser(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error('authuser must be a non-negative integer');
  return value;
}

// Each account has its own API object: concurrent calls cannot overwrite tokens.
const accountApis = new Map();
function getAccountApi(authuser) {
  validateAuthuser(authuser);
  if (!accountApis.has(authuser)) {
    const api = Object.create(NotebookLMAPI);
    api.tokens = {};
    api.tokensAuthuser = null;
    api.tokensFetchedAt = 0;
    accountApis.set(authuser, api);
  }
  return accountApis.get(authuser);
}

// ─── PDF generation via Chrome Debugger (with 30s timeout) ───
async function generatePdf(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  let pendingTimer = null;
  try {
    const printPromise = chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4
    });
    const timeoutPromise = new Promise((_, reject) => {
      pendingTimer = setTimeout(
        () => reject(new Error('PDF generation timeout')),
        30000
      );
    });
    const result = await Promise.race([printPromise, timeoutPromise]);
    return result.data;  // base64
  } finally {
    if (pendingTimer) clearTimeout(pendingTimer);
    // Ensure debugger is always detached, even on timeout/error.
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {
      // Already detached or attach failed — ignore.
    }
  }
}

async function addAsPdf(notebookId, tabId, title, api = NotebookLMAPI) {
  requireId(notebookId, 'Notebook');
  const tab = await chrome.tabs.get(tabId);
  UrlUtils.httpUrl(tab.url);
  const pdfBase64 = await generatePdf(tabId);
  const safeBase = (title || 'page').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'page';
  const filename = safeBase.substring(0, 80) + '.pdf';
  await api.addPdfSource(notebookId, pdfBase64, filename);
  return { success: true, filename };
}

// ─── YouTube comments parsing (state machine) ───
let parseState = {
  active: false,
  parseId: null,
  videoId: null,
  progress: { fetched: 0, total: null, phase: 'idle' },
  cancelToken: null,
  error: null,
  result: null
};

// Mirror parseState to session storage so a SW restart is detectable.
// Note: a parse in progress will not resume automatically after SW death —
// the user must re-trigger it. This checkpoint is for observability only
// (get-parse-status can report "interrupted" state immediately after restart).
async function checkpointParseState(state = parseState) {
  try {
    await chrome.storage.session.set({
      parseStateCheckpoint: {
        active: state.active,
        parseId: state.parseId,
        videoId: state.videoId,
        progress: state.progress,
        error: state.error,
        result: state.result,
        ts: Date.now()
      }
    });
  } catch (_) { /* non-fatal */ }
}

async function doParseComments(notebookId, videoId, tabId, authuser, state) {
  const { cancelToken } = state;
  const api = getAccountApi(authuser);
  let videoTitle = videoId;
  try {
    const metadata = await YouTubeCommentsAPI.getVideoMetadataFromDOM(tabId, videoId);
    videoTitle = metadata.title || videoId;
    if (metadata.videoId !== videoId) throw new Error('The YouTube tab changed to a different video. Please retry.');
    state.progress.total = metadata.commentCount;
    await checkpointParseState(state);
    if (cancelToken.cancelled) return;

    const settings = await chrome.storage.local.get(['commentsMode', 'commentsLimit', 'commentsIncludeReplies']);
    const mode = settings.commentsMode === 'new' || settings.commentsMode === 'newest' ? 'newest' : 'top';
    const includeReplies = settings.commentsIncludeReplies !== false;
    const maxComments = Number.isInteger(settings.commentsLimit) && settings.commentsLimit >= 0 ? settings.commentsLimit : 1000;
    const comments = await YouTubeCommentsAPI.fetchAllComments(videoId, {
      progressCallback: ({ fetched, phase }) => {
        state.progress.fetched = fetched;
        if (phase) state.progress.phase = phase;
      },
      cancelToken, tabId, mode, maxComments, includeReplies
    });
    if (cancelToken.cancelled) return;
    if (!comments.length) throw new Error('No comments were fetched. The source was not added to the notebook.');

    state.progress.phase = 'formatting';
    await checkpointParseState(state);
    const { language } = await chrome.storage.sync.get(['language']);
    const parts = CommentsToMd.format(metadata, comments, { lang: language || 'en' });
    if (cancelToken.cancelled) return;

    state.progress.phase = 'sending';
    state.result = { commentCount: comments.length, totalComments: metadata.commentCount,
      partCount: parts.length, sentPartCount: 0, videoTitle: metadata.title, sourceIds: [] };
    await checkpointParseState(state);
    await api.getTokens(authuser);
    for (let i = 0; i < parts.length; i++) {
      if (cancelToken.cancelled) return;
      try {
        const result = await api.addTextSource(notebookId, parts[i].text, parts[i].title, { verify: true });
        if (result.sourceId) state.result.sourceIds.push(result.sourceId);
        state.result.sentPartCount++;
        await checkpointParseState(state);
      } catch (error) {
        throw new Error(`Failed to add part ${i + 1}/${parts.length} (${state.result.sentPartCount} already added): ${error.message}`);
      }
    }
    state.progress.phase = 'done';
    await addHistory({ action: 'add_youtube_comments', title: metadata.title || videoId,
      notebookId, count: comments.length }).catch(console.warn);
  } catch (error) {
    console.error('doParseComments:', error);
    state.progress.phase = 'error';
    state.error = { code: error.code || 'UNKNOWN', message: error.message };
    if (!cancelToken.cancelled) await addHistory({ action: 'error', title: videoTitle,
      notebookId, error: error.message }).catch(console.warn);
  } finally {
    if (cancelToken.cancelled) state.progress.phase = 'cancelled';
    state.active = false;
    await checkpointParseState(state);
  }
}

// ─── State ───
let currentAuthuser = 0;
let startupReady = Promise.resolve();
let accountSwitchVersion = 0;
let accountCommit = Promise.resolve();

// Read active account from chrome.storage.sync (MV3-safe).
// Falls back to in-memory currentAuthuser (which itself defaults to 0).
async function getActiveAuthuser() {
  try {
    const data = await chrome.storage.sync.get(['activeAccount']);
    if (typeof data.activeAccount === 'number') {
      currentAuthuser = data.activeAccount;  // keep in-memory in sync
      return data.activeAccount;
    }
  } catch (_) { /* storage read failure — fall through to in-memory */ }
  return currentAuthuser;
}

// Persist active account to both chrome.storage.sync and in-memory.
async function setActiveAuthuser(authuser) {
  validateAuthuser(authuser);
  await chrome.storage.sync.set({ activeAccount: authuser });
  currentAuthuser = authuser;
}

// Only the newest selection may commit, even if authentication or a storage
// write for an older selection is still in flight.
async function selectActiveAuthuser(authuser) {
  validateAuthuser(authuser);
  const version = ++accountSwitchVersion;
  try {
    await getAccountApi(authuser).getTokens(authuser);
  } catch (error) {
    if (version !== accountSwitchVersion) return { authuser: await getActiveAuthuser(), superseded: true };
    throw error;
  }
  const commit = accountCommit.then(async () => {
    if (version !== accountSwitchVersion) return { authuser: await getActiveAuthuser(), superseded: true };
    await setActiveAuthuser(authuser);
    return { authuser, superseded: version !== accountSwitchVersion };
  });
  accountCommit = commit.catch(() => {});
  return commit;
}

// On SW startup: restore currentAuthuser from chrome.storage.sync.
// (chrome.storage is async, so we kick off the read immediately; downstream
// code that needs the persisted value uses getActiveAuthuser() which always
// re-reads and falls back gracefully.)
chrome.storage.sync.get(['activeAccount'], (result) => {
  currentAuthuser = (typeof result.activeAccount === 'number') ? result.activeAccount : 0;
});

// ─── Notifications helper (respects settingsNotifications) ───
async function notify(id, options) {
  try {
    const data = await chrome.storage.sync.get(['enableNotifications', 'settingsNotifications']);
    // Default to true if unset (preserves existing behavior on first install).
    const enabled = (data.enableNotifications ?? data.settingsNotifications) !== false;
    if (!enabled) return;
    const opts = {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: options.title || 'Gemini Notebook Assistant',
      message: options.message || ''
    };
    // chrome.notifications.create supports (id, options, callback). Use the
    // callback form to surface lastError instead of an unhandled rejection.
    chrome.notifications.create(id, opts, () => {
      if (chrome.runtime.lastError) {
        console.warn('notifications.create error:', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.warn('notify error:', e);
  }
}

// ─── Queue management ───
// Mutations are serialized, but the lock is never held across an API request.
// The run (including its account) lives in local storage to survive browser restarts.
const QUEUE_ALARM_PREFIX = 'process-queue-';
const MAX_QUEUE_RETRIES = 3;
let queueLock = Promise.resolve();
let queueWorker = null;
let queueTimer = null;
let queueTimerRunId = null;

function makeQueueId() { return crypto.randomUUID(); }

function withQueueLock(action) {
  const result = queueLock.then(action);
  queueLock = result.catch(() => {});
  return result;
}

async function readQueueState() {
  const data = await chrome.storage.local.get(['queue', 'queueRun']);
  const queue = Array.isArray(data.queue) ? data.queue : [];
  let changed = false;
  for (const item of queue) {
    if (!item.id) { item.id = makeQueueId(); changed = true; }
    if (!item.status || item.status === 'error') { item.status = 'pending'; changed = true; }
    if (!Number.isInteger(item.errorCount)) { item.errorCount = 0; changed = true; }
  }
  if (changed) await chrome.storage.local.set({ queue });
  return { queue, run: data.queueRun || null };
}

async function writeQueueState(state) {
  await chrome.storage.local.set({ queue: state.queue, queueRun: state.run });
  updateBadge(state.queue.length);
}

async function getQueue() { return withQueueLock(async () => (await readQueueState()).queue); }

async function getQueueStatus() {
  return withQueueLock(async () => {
    const { queue, run } = await readQueueState();
    return { queue, ...(run || { status: 'idle', processed: 0, errors: 0, total: 0 }),
      active: run?.status === 'processing',
      pending: queue.filter(item => item.status === 'pending').length,
      failed: queue.filter(item => item.status === 'failed').length,
      processing: queue.filter(item => item.status === 'processing').length };
  });
}

async function addToQueue(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('At least one URL is required');
  const newItems = items.map(item => ({
    id: makeQueueId(), url: UrlUtils.httpUrl(typeof item === 'string' ? item : item?.url),
    title: typeof item?.title === 'string' ? item.title : '',
    addedAt: Date.now(), status: 'pending', errorCount: 0
  }));
  return withQueueLock(async () => {
    const state = await readQueueState();
    state.queue.push(...newItems);
    if (state.run?.status === 'processing') state.run.total += newItems.length;
    await writeQueueState(state);
    return state.queue;
  });
}

async function stopQueueSchedule(run) {
  if (run && queueTimerRunId === run.id) {
    if (queueTimer !== null) clearTimeout(queueTimer);
    queueTimer = null;
    queueTimerRunId = null;
  }
  if (run) await chrome.alarms.clear(QUEUE_ALARM_PREFIX + run.id);
}

async function clearQueue() {
  const run = await withQueueLock(async () => {
    const state = await readQueueState();
    state.queue = [];
    if (state.run?.status === 'processing') {
      state.run.status = 'cancelled';
      state.run.completedAt = Date.now();
    }
    await writeQueueState(state);
    return state.run;
  });
  await stopQueueSchedule(run);
}

async function scheduleQueue(requestedRun) {
  return withQueueLock(async () => {
    const { run } = await readQueueState();
    if (requestedRun && run?.id !== requestedRun.id) return stopQueueSchedule(requestedRun);
    if (run?.status !== 'processing') return stopQueueSchedule(run || requestedRun);
    if (queueTimer !== null) clearTimeout(queueTimer);
    const alarmName = QUEUE_ALARM_PREFIX + run.id;
    // The alarm is a watchdog; short delays use an in-memory timer.
    await chrome.alarms.create(alarmName, { when: Date.now() + 60000, periodInMinutes: 1 });
    queueTimerRunId = run.id;
    queueTimer = setTimeout(() => {
      if (queueTimerRunId === run.id) { queueTimer = null; queueTimerRunId = null; }
      processOneQueueItem(alarmName).catch(error => console.error('Queue worker:', error));
    }, Math.max(0, (run.nextRunAt || 0) - Date.now()));
  });
}

async function processQueue(notebookId, authuser = 0) {
  requireId(notebookId, 'Notebook');
  validateAuthuser(authuser);
  const run = await withQueueLock(async () => {
    const state = await readQueueState();
    if (state.run?.status === 'processing') throw new Error('Queue processing already in progress');
    const pending = state.queue.filter(item => item.status === 'pending').length;
    if (!pending) return null;
    state.run = { id: makeQueueId(), notebookId, authuser, status: 'processing',
      total: pending, processed: 0, errors: 0, startedAt: Date.now(), nextRunAt: Date.now() };
    await writeQueueState(state);
    return state.run;
  });
  if (!run) return { started: false, processed: 0, errors: 0, pending: 0 };
  await scheduleQueue(run);
  return { started: true, queueLength: run.total, runId: run.id };
}

async function processOneQueueItem(alarmName) {
  if (queueWorker) {
    // A new run may have started while a cancelled run's POST was settling.
    // Retain its wake-up and re-check the authoritative run after that worker.
    await queueWorker.catch(() => {});
    return processOneQueueItem(alarmName);
  }
  queueWorker = (async () => {
    const work = await withQueueLock(async () => {
      const state = await readQueueState();
      const run = state.run;
      if (run?.status !== 'processing' || alarmName !== QUEUE_ALARM_PREFIX + run.id) return null;
      if (run.nextRunAt > Date.now()) return { reschedule: run };
      for (const queued of state.queue) {
        if (queued.status === 'processing') { queued.status = 'pending'; queued.recovered = true; }
      }
      const item = state.queue.find(item => item.status === 'pending' && (item.nextAttemptAt || 0) <= Date.now());
      if (!item) {
        const pending = state.queue.filter(item => item.status === 'pending');
        if (pending.length) {
          run.nextRunAt = Math.min(...pending.map(item => item.nextAttemptAt || Date.now()));
        } else {
          run.status = 'completed';
          run.completedAt = Date.now();
        }
        await writeQueueState(state);
        return { reschedule: run };
      }
      item.status = 'processing';
      run.currentItemId = item.id;
      await writeQueueState(state);
      return { item: { ...item }, run: { ...run } };
    });
    if (!work) return;
    if (work.reschedule) return scheduleQueue(work.reschedule);

    const { item, run } = work;
    const api = getAccountApi(run.authuser);
    let error = null;
    let attempt = item.sourceAttempt || (item.recovered ? {
      notebookId: run.notebookId, authuser: run.authuser, beforeSourceIds: []
    } : null);
    try {
      await api.getTokens(run.authuser);
      if (attempt) {
        // Reconcile an ambiguous write instead of replaying it. The snapshot
        // also survives a restart between the POST and its local commit.
        await verifySourceAttempt(api, item, run, attempt);
      } else {
        const notebook = await api.getNotebook(run.notebookId);
        const snapshot = { notebookId: run.notebookId, authuser: run.authuser,
          beforeSourceIds: notebook.sources.filter(source => sameSourceUrl(source.url, item.url)).map(source => source.id) };
        const canSend = await withQueueLock(async () => {
          const state = await readQueueState();
          const queued = state.queue.find(queued => queued.id === item.id);
          if (state.run?.id !== run.id || state.run.status !== 'processing' || !queued) return false;
          queued.sourceAttempt = snapshot;
          await writeQueueState(state);
          return true;
        });
        if (!canSend) return;
        attempt = snapshot;
        try {
          await api.addSource(run.notebookId, item.url);
        } catch (failure) {
          if (failure.rpcOutcome !== 'unknown') {
            attempt = null;
            throw failure;
          }
          await verifySourceAttempt(api, item, run, attempt);
        }
      }
    } catch (failure) { error = failure; }

    const settings = await chrome.storage.local.get(['addDelay']);
    const delay = Math.min(30000, Math.max(500, Number(settings.addDelay) || 2000));
    const nextRun = await withQueueLock(async () => {
      const state = await readQueueState();
      if (state.run?.id !== run.id || state.run.status !== 'processing') return null;
      const index = state.queue.findIndex(queued => queued.id === item.id);
      if (index !== -1) {
        const queued = state.queue[index];
        if (!error) {
          state.queue.splice(index, 1);
          state.run.processed++;
        } else {
          queued.errorCount++;
          queued.lastError = error.message;
          if (attempt) queued.sourceAttempt = attempt;
          else delete queued.sourceAttempt;
          delete queued.recovered;
          queued.status = queued.errorCount >= MAX_QUEUE_RETRIES ? 'failed' : 'pending';
          queued.nextAttemptAt = Date.now() + delay * Math.pow(2, queued.errorCount - 1);
          if (queued.status === 'failed') state.run.errors++;
        }
      }
      delete state.run.currentItemId;
      state.run.nextRunAt = Date.now() + delay;
      if (!state.queue.some(queued => queued.status === 'pending')) {
        state.run.status = 'completed';
        state.run.completedAt = Date.now();
      }
      await writeQueueState(state);
      return state.run;
    });
    // Logging failures must never cause an already successful RPC to be retried.
    await addHistory({ action: error ? 'error' : 'add_source', url: item.url, title: item.title,
      ...(error ? { error: error.message } : {}), notebookId: run.notebookId }).catch(console.warn);
    if (nextRun) await scheduleQueue(nextRun);
  })();
  try { return await queueWorker; } finally { queueWorker = null; }
}

function sameSourceUrl(sourceUrl, requestedUrl) {
  if (!sourceUrl) return false;
  try { return UrlUtils.sourceKey(sourceUrl) === UrlUtils.sourceKey(requestedUrl); }
  catch (_) { return false; }
}

async function verifySourceAttempt(api, item, run, attempt) {
  if (attempt.notebookId !== run.notebookId || attempt.authuser !== run.authuser) {
    throw new Error('The previous attempt belongs to a different notebook or account. Check that notebook before retrying.');
  }
  let notebook;
  try { notebook = await api.getNotebook(run.notebookId); }
  catch (error) { throw new Error('Could not verify the previous source import: ' + error.message); }
  const beforeIds = new Set(attempt.beforeSourceIds);
  const created = notebook.sources.find(source => !beforeIds.has(source.id) && sameSourceUrl(source.url, item.url));
  if (!created) {
    throw new Error('Source creation is not confirmed. The previous request will not be resent; retry checks the notebook again.');
  }
  return created.id;
}

async function removeFromQueue(params) {
  return withQueueLock(async () => {
    const state = await readQueueState();
    const index = params.id ? state.queue.findIndex(item => item.id === params.id) : params.index;
    if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) throw new Error('Queue item no longer exists');
    if (state.queue[index].status === 'processing') throw new Error('This item is currently being processed');
    if (state.run?.status === 'processing' && state.queue[index].status === 'pending') state.run.total--;
    state.queue.splice(index, 1);
    await writeQueueState(state);
    return { queue: state.queue };
  });
}

async function retryFailed() {
  return withQueueLock(async () => {
    const state = await readQueueState();
    let reset = 0;
    for (const item of state.queue) {
      if (item.status !== 'failed') continue;
      item.status = 'pending';
      item.errorCount = 0;
      delete item.lastError;
      delete item.nextAttemptAt;
      reset++;
    }
    await writeQueueState(state);
    return { reset, queue: state.queue };
  });
}

// ─── History ───
let historyLock = Promise.resolve();
function mutateHistory(action) {
  const result = historyLock.then(action);
  historyLock = result.catch(() => {});
  return result;
}
async function addHistory(entry) {
  return mutateHistory(async () => {
    const data = await chrome.storage.local.get(['history']);
    const history = Array.isArray(data.history) ? data.history : [];
    history.unshift({ ...entry, timestamp: Date.now() });
    if (history.length > 500) history.length = 500;
    await chrome.storage.local.set({ history });
  });
}

async function getHistory() {
  const data = await chrome.storage.local.get(['history']);
  return data.history || [];
}

async function clearHistory() {
  await mutateHistory(() => chrome.storage.local.set({ history: [] }));
}

// ─── Badge ───
function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#4285f4' });
}

// ─── Drive sync orchestrator ───
async function syncDriveSources(notebookId, api = NotebookLMAPI) {
  const nb = await api.getNotebook(notebookId);
  const driveSources = nb.sources.filter(s => s.canSync);
  if (!driveSources.length) return { success: true, results: { total: 0 } };

  const results = { total: driveSources.length, fresh: 0, synced: 0, skipped: 0, errors: 0 };
  for (const source of driveSources) {
    try {
      const isFresh = await api.checkSourceFreshness(source.id, notebookId);
      if (isFresh === null) results.skipped++;
      else if (isFresh) results.fresh++;
      else {
        await api.syncDriveSource(source.id, notebookId);
        results.synced++;
      }
    } catch (e) {
      results.errors++;
    }
  }
  return { success: true, results };
}

// ─── Extract YouTube URLs from tab (covers watch / shorts / embed / m. / music. / youtu.be + iframes) ───
async function extractYouTubeUrls(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: UrlUtils.pageYouTubeUrls
  });
  return results[0]?.result || [];
}

// ─── Extract all links from tab ───
async function extractAllLinks(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        try {
          const u = new URL(a.href);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            links.push({ url: a.href, title: a.textContent.trim().substring(0, 100) || a.href });
          }
        } catch (e) {}
      });
      return [...new Map(links.map(l => [l.url, l])).values()];
    }
  });
  return results[0]?.result || [];
}

// ─── Extract open tabs ───
async function getOpenTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')))
    .map(t => ({ url: t.url, title: t.title || t.url, favIconUrl: t.favIconUrl || '', tabId: t.id }));
}

// ─── RSS/Sitemap detection ───
async function detectRssFeed(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const feeds = [];
      document.querySelectorAll('link[type="application/rss+xml"], link[type="application/atom+xml"]').forEach(l => {
        feeds.push({ url: l.href, title: l.title || 'RSS Feed', type: l.type });
      });
      return feeds;
    }
  });
  return results[0]?.result || [];
}

// ─── RSS / Atom / Sitemap parsing in an offscreen XML DOM ───
let offscreenCreation = null;
async function parseRssXml(xml, url) {
  if (!offscreenCreation) {
    offscreenCreation = (async () => {
      const documentUrl = chrome.runtime.getURL('offscreen/offscreen.html');
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [documentUrl] });
      if (!contexts.length) await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html', reasons: ['DOM_PARSER'], justification: 'Parse RSS, Atom and Sitemap XML documents'
      });
    })().finally(() => { offscreenCreation = null; });
  }
  await offscreenCreation;
  return ExtensionClient.send('parse-xml', { xml, url }, { target: 'offscreen' });
}

async function parseFeedUrl(input) {
  const url = UrlUtils.httpUrl(input);
  const pending = [url];
  const visited = new Set();
  const items = new Map();
  let result = null;
  while (pending.length) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    if (visited.size >= 50) throw new Error('Sitemap index exceeds the limit of 50 XML documents');
    visited.add(current);
    if (!await chrome.permissions.contains({ origins: [new URL(current).origin + '/*'] })) {
      throw new Error('Permission needed to fetch feed: ' + new URL(current).origin);
    }
    const response = await fetchWithTimeout(current);
    if (!response.ok) throw new Error(`Feed fetch failed: HTTP ${response.status}`);
    const feed = await parseRssXml(await response.text(), response.url || current);
    if (!result) result = { ...feed, items: [], sitemaps: [] };
    for (const item of feed.items) items.set(item.url, item);
    pending.push(...feed.sitemaps);
  }
  if (!items.size) throw new Error('No items found in feed');
  return { ...result, items: [...items.values()] };
}

// ─── Context menu (safe re-init pattern) ───
function initContextMenus() {
  chrome.contextMenus.removeAll(async () => {
    if (chrome.runtime.lastError) {
      console.warn('contextMenus.removeAll error:', chrome.runtime.lastError.message);
    }
    try {
      chrome.contextMenus.create({
        id: 'add-to-nlm',
        title: chrome.i18n.getMessage('contextMenuAdd') || 'Add to Gemini Notebook',
        contexts: ['page', 'link']
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('contextMenus.create(add-to-nlm):', chrome.runtime.lastError.message);
        }
      });
      chrome.contextMenus.create({
        id: 'add-as-pdf',
        title: chrome.i18n.getMessage('contextMenuPdf') || 'Save as PDF to Gemini Notebook',
        contexts: ['page']
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('contextMenus.create(add-as-pdf):', chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.error('initContextMenus error:', e);
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  initContextMenus();
});

async function getLastNotebook(authuser) {
  const data = await chrome.storage.local.get(['lastNotebookByAccount', 'lastNotebookId', 'lastNotebookAuthuser']);
  return data.lastNotebookByAccount?.[authuser] ||
    ((data.lastNotebookAuthuser === authuser || (data.lastNotebookAuthuser === undefined && authuser === 0))
      ? data.lastNotebookId : null);
}

async function savePdfForTab(notebookId, tabId, title, authuser) {
  const api = getAccountApi(authuser);
  await api.getTokens(authuser);
  await notify('pdf-start', { message: 'Generating PDF and uploading...' });
  try {
    const result = await addAsPdf(notebookId, tabId, title, api);
    await addHistory({ action: 'add_pdf', title, notebookId }).catch(console.warn);
    await notify('pdf-done', { message: 'PDF added to notebook' });
    return result;
  } catch (error) {
    await notify('pdf-error', { message: 'PDF failed: ' + error.message });
    throw error;
  }
}

async function handlePdfShortcut(tab) {
  UrlUtils.httpUrl(tab.url);
  const authuser = await getActiveAuthuser();
  const notebookId = await getLastNotebook(authuser);
  if (notebookId) return savePdfForTab(notebookId, tab.id, tab.title, authuser);
  await chrome.storage.local.set({ pendingPdf: { tabId: tab.id, title: tab.title, url: tab.url } });
  await notify('pdf-pending', { message: 'Open the extension, select a notebook and click Save PDF' });
  return { pending: true };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    await startupReady;
    const url = info.linkUrl || info.pageUrl;
    if (info.menuItemId === 'add-to-nlm') {
      await addToQueue([{ url, title: tab?.title || '' }]);
      await notify('queue-add', { message: `Added to queue: ${url}` });
    } else if (info.menuItemId === 'add-as-pdf' && tab) {
      await handlePdfShortcut(tab);
    }
  } catch (error) {
    console.error('Context menu:', error);
    await notify('cmd-error', { message: error.message });
  }
});

// ─── Keyboard shortcuts ───
chrome.commands.onCommand.addListener(async (command) => {
  try {
    await startupReady;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (command === 'add-current-page') {
      await addToQueue([{ url: tab.url, title: tab.title }]);
      await notify('queue-add', { message: `Added to queue: ${tab.url}` });
    } else if (command === 'add-as-pdf') {
      await handlePdfShortcut(tab);
    }
  } catch (e) {
    console.error('onCommand error:', e);
    await notify('cmd-error', { message: 'Command failed: ' + e.message });
  }
});

// ─── Alarms listener (drives crash-safe queue processing) ───
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || !alarm.name || !alarm.name.startsWith(QUEUE_ALARM_PREFIX)) return;
  try {
    await startupReady;
    await processOneQueueItem(alarm.name);
  } catch (e) {
    console.error('onAlarm queue processing error:', e);
    await recoverQueue().catch(console.warn);
  }
});

// ─── Message handler ───
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target === 'offscreen') return false;
  handleMessage(request, sender).then(sendResponse).catch(async error => {
    if (['create-notebook', 'add-source', 'add-sources', 'add-text-source', 'add-as-pdf',
      'delete-source', 'delete-sources', 'sync-drive-sources'].includes(request?.cmd)) {
      const params = request.params || {};
      await addHistory({ action: 'error', title: params.title || request.cmd, url: params.url || '',
        notebookId: params.notebookId || '', error: error.message }).catch(console.warn);
    }
    sendResponse({ error: error.message });
  });
  return true;
});

async function handleMessage(request, sender = {}) {
  await startupReady;
  if (!request || typeof request.cmd !== 'string') throw new Error('Invalid extension command');
  const { cmd } = request;
  const params = request.params || {};
  let pageAuthuser = null;
  try {
    const url = new URL(sender.url);
    if (/^notebook(?:lm)?\.google\.com$/.test(url.hostname) && url.searchParams.has('authuser')) {
      pageAuthuser = Number(url.searchParams.get('authuser'));
    } else if (/^notebook(?:lm)?\.google\.com$/.test(url.hostname)) {
      pageAuthuser = Number(url.pathname.match(/^\/u\/(\d+)\//)?.[1] || 0);
    }
  } catch (_) {}
  const au = validateAuthuser(params.authuser ?? pageAuthuser ?? await getActiveAuthuser());
  const api = getAccountApi(au);

  switch (cmd) {
    // ── Auth ──
    case 'list-accounts': {
      const accounts = await api.listAccounts();
      // Cache for get-active-account.
      await chrome.storage.session.set({ lastAccounts: accounts });
      return accounts;
    }

    case 'set-authuser':
      return selectActiveAuthuser(au);

    case 'get-tokens':
      await api.getTokens(au);
      return { success: true };

    // ── Account persistence (new) ──
    case 'get-active-account': {
      // Return authuser immediately (fast — from storage.sync).
      // Accounts are returned from session cache if available; if not cached,
      // we return an empty array rather than blocking on a slow network fetch
      // to accounts.google.com. The content script doesn't need accounts to
      // render the toolbar — only the authuser is needed for messaging.
      // The popup will trigger a fresh list-accounts call when opened.
      const authuser = await getActiveAuthuser();
      let accounts = [];
      try {
        const session = await chrome.storage.session.get(['lastAccounts']);
        accounts = session.lastAccounts || [];
      } catch (_) {}
      return { authuser, accounts };
    }

    case 'set-active-account': {
      return selectActiveAuthuser(params.authuser);
    }

    // ── Notebooks ──
    case 'list-notebooks':
      await api.getTokens(au);
      return await api.listNotebooks();

    case 'create-notebook': {
      await api.getTokens(au);
      const created = await api.createNotebook(params.title, params.emoji);
      await addHistory({ action: 'create_notebook', title: created.title, notebookId: created.id }).catch(console.warn);
      return created;
    }

    case 'set-last-notebook':
      if (params.notebookId) requireId(params.notebookId, 'Notebook');
      await withQueueLock(async () => {
        const data = await chrome.storage.local.get(['lastNotebookByAccount']);
        await chrome.storage.local.set({
          lastNotebookByAccount: { ...(data.lastNotebookByAccount || {}), [au]: params.notebookId || '' },
          lastNotebookId: params.notebookId || '', lastNotebookAuthuser: au
        });
      });
      return { success: true };

    // ── Sources ──
    case 'add-source': {
      await api.getTokens(au);
      await api.addSource(params.notebookId, params.url);
      await addHistory({ action: 'add_source', url: params.url, notebookId: params.notebookId }).catch(console.warn);
      return { success: true };
    }

    case 'add-sources': {
      await api.getTokens(au);
      let result;
      try {
        result = await api.addSources(params.notebookId, params.urls, {
          onAdded: async urls => {
            for (const url of urls) await addHistory({ action: 'add_source', url, notebookId: params.notebookId }).catch(console.warn);
          }
        });
      } catch (error) {
        if (!error.importResult) throw error;
        result = error.importResult;
        for (const item of result.results.filter(item => item.status === 'failed' || item.status === 'uncertain')) {
          await addHistory({ action: 'error', url: item.url, error: result.message,
            notebookId: params.notebookId }).catch(console.warn);
        }
      }
      return result;
    }

    case 'add-text-source': {
      await api.getTokens(au);
      const result = await api.addTextSource(params.notebookId, params.text, params.title, { verify: true });
      await addHistory({ action: 'add_text', title: params.title, notebookId: params.notebookId }).catch(console.warn);
      return { success: true, sourceId: result.sourceId };
    }

    case 'add-as-pdf': {
      return savePdfForTab(params.notebookId, params.tabId, params.title, au);
    }

    // ── Notebook details ──
    case 'get-notebook':
      await api.getTokens(au);
      return await api.getNotebook(params.notebookId);

    case 'get-sources':
      await api.getTokens(au);
      return await api.getNotebook(params.notebookId);

    // ── Delete ──
    case 'delete-source':
      await api.getTokens(au);
      await api.deleteSource(params.notebookId, params.sourceId);
      await addHistory({ action: 'delete_source', sourceId: params.sourceId, notebookId: params.notebookId }).catch(console.warn);
      return { success: true };

    case 'delete-sources':
      await api.getTokens(au);
      const delResult = await api.deleteSources(params.notebookId, params.sourceIds);
      await addHistory({ action: 'delete_sources', count: delResult.deleted, notebookId: params.notebookId }).catch(console.warn);
      return { success: true, ...delResult };

    // ── Drive sync ──
    case 'sync-drive-sources': {
      await api.getTokens(au);
      const result = await syncDriveSources(params.notebookId, api);
      await addHistory({ action: 'sync_drive', count: result.results.synced || 0, notebookId: params.notebookId }).catch(console.warn);
      return result;
    }

    // ── YouTube comments ──
    case 'parse-comments': {
      if (parseState.active) return { error: 'Parse already in progress' };
      requireId(params.notebookId, 'Notebook');
      if (!/^[A-Za-z0-9_-]{11}$/.test(params.videoId || '')) throw new Error('Invalid YouTube video ID');
      const parseId = makeQueueId();
      const state = { active: true, parseId, videoId: params.videoId,
        progress: { fetched: 0, total: null, phase: 'fetching' }, cancelToken: { cancelled: false }, error: null, result: null };
      parseState = state;
      await checkpointParseState(state);
      try {
        const tab = await chrome.tabs.get(params.tabId);
        if (UrlUtils.videoId(tab.url) !== params.videoId) throw new Error('The active tab is not the requested YouTube video');
        await api.getTokens(au);
      } catch (e) {
        state.active = false;
        state.progress.phase = 'error';
        state.error = { code: 'AUTH', message: e.message };
        await checkpointParseState(state);
        return { error: e.message };
      }
      if (state.cancelToken.cancelled) {
        state.active = false;
        state.progress.phase = 'cancelled';
        await checkpointParseState(state);
        return { started: false };
      }
      doParseComments(params.notebookId, params.videoId, params.tabId, au, state);
      return { started: true, parseId };
    }

    case 'get-parse-status':
      return {
        active: parseState.active,
        parseId: parseState.parseId,
        videoId: parseState.videoId,
        progress: parseState.progress,
        error: parseState.error,
        result: parseState.result
      };

    case 'cancel-parse':
      if (params.parseId && params.parseId !== parseState.parseId) return { success: false };
      if (parseState.cancelToken) {
        parseState.cancelToken.cancelled = true;
        if (parseState.active) parseState.progress.phase = 'cancelling';
        await checkpointParseState();
      }
      return { success: true };

    // ── Queue ──
    case 'get-queue':
      return await getQueue();

    case 'get-queue-status':
      return await getQueueStatus();

    case 'add-to-queue':
      return await addToQueue(params.items);

    case 'clear-queue':
      await clearQueue();
      return { success: true };

    case 'remove-from-queue': {
      return removeFromQueue(params);
    }

    case 'process-queue':
      await api.getTokens(au);
      return await processQueue(params.notebookId, au);

    case 'retry-failed':
      return await retryFailed();

    // ── History ──
    case 'get-history':
      return await getHistory();

    case 'clear-history':
      await clearHistory();
      return { success: true };

    // ── Tab helpers ──
    case 'get-open-tabs':
      return await getOpenTabs();

    case 'extract-yt-urls':
      return await extractYouTubeUrls(params.tabId);

    case 'extract-links':
      return await extractAllLinks(params.tabId);

    case 'detect-rss':
      return await detectRssFeed(params.tabId);

    case 'get-current-tab': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab ? { url: tab.url, title: tab.title, id: tab.id, favIconUrl: tab.favIconUrl } : null;
    }

    case 'open-tab':
      await chrome.tabs.create({ url: params.url });
      return { success: true };

    // ── RSS parsing (new) ──
    case 'parse-rss': {
      return parseFeedUrl(params.url);
    }

    default:
      return { error: `Unknown command: ${cmd}` };
  }
}

// ─── SW startup: recover persisted work before accepting commands ───
async function recoverQueue() {
  const run = await withQueueLock(async () => {
    const state = await readQueueState();
    const legacy = await chrome.storage.session.get(['queueProcessing', 'queueNotebookId']);
    if (!state.run && legacy.queueProcessing && legacy.queueNotebookId) {
      state.run = { id: makeQueueId(), notebookId: legacy.queueNotebookId, authuser: await getActiveAuthuser(),
        status: 'processing', total: state.queue.length, processed: 0, errors: 0, nextRunAt: Date.now() };
    }
    if (state.run?.status === 'processing') {
      for (const item of state.queue) {
        if (item.status === 'processing') { item.status = 'pending'; item.recovered = true; }
      }
      delete state.run.currentItemId;
      if (!state.queue.some(item => item.status === 'pending')) state.run.status = 'completed';
    }
    await writeQueueState(state);
    await chrome.storage.session.remove(['queueProcessing', 'queueNotebookId', 'queueAlarmName']);
    return state.run;
  });
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (alarm.name.startsWith(QUEUE_ALARM_PREFIX) && alarm.name !== QUEUE_ALARM_PREFIX + run?.id) {
      await chrome.alarms.clear(alarm.name);
    }
  }
  await scheduleQueue(run);
}

startupReady = (async () => {
  const { parseStateCheckpoint } = await chrome.storage.session.get(['parseStateCheckpoint']);
  if (parseStateCheckpoint?.active) {
    parseState = { active: false, parseId: parseStateCheckpoint.parseId, videoId: parseStateCheckpoint.videoId,
      progress: { ...(parseStateCheckpoint.progress || {}), phase: 'interrupted' }, cancelToken: null,
      error: { code: 'INTERRUPTED', message: 'Parsing was interrupted when the background worker restarted. Please start it again.' },
      result: parseStateCheckpoint.result || null };
    await checkpointParseState();
  }
  await recoverQueue();
})().catch(error => console.error('Startup recovery:', error));
