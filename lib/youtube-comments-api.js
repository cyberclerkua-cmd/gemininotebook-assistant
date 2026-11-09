// YouTube Comments API client using InnerTube API for fetching comments
// and DOM scraping for video metadata
// Used by background service worker via importScripts

const YouTubeCommentsAPI = {
  INNERTUBE_URL: 'https://www.youtube.com/youtubei/v1/next',
  // Per-request throttle between paginated InnerTube calls.
  // Raised from 100ms → 500ms (with up to +200ms jitter) to reduce the chance
  // of tripping YouTube's bot detection on long comment threads.
  REQUEST_DELAY: 500,
  REQUEST_JITTER: 200,
  // Max retry attempts for transient fetch failures (1 initial + 2 retries).
  MAX_RETRIES: 2,

  // Error codes
  ERRORS: {
    COMMENTS_DISABLED: 'COMMENTS_DISABLED',
    VIDEO_NOT_FOUND: 'VIDEO_NOT_FOUND',
    INVALID_REQUEST: 'INVALID_REQUEST',
    NETWORK_ERROR: 'NETWORK_ERROR'
  },

  // Extract video ID from various YouTube URL formats
  extractVideoId(url) {
    return UrlUtils.videoId(url);
  },

  // Get video metadata from YouTube page DOM (no API key needed)
  // Uses YouTube's internal data objects for reliable extraction across locales
  // fallbackVideoId: if provided, will be used when DOM extraction fails
  async getVideoMetadataFromDOM(tabId, fallbackVideoId = null) {
    // Retry logic for pages that haven't fully loaded
    const maxRetries = 3;
    const retryDelay = 500;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const watchFlexy = document.querySelector('ytd-watch-flexy');
            const pageData = watchFlexy?.data || watchFlexy?.__data;
            const playerResponse = pageData?.playerResponse || window.ytInitialPlayerResponse || {};
            const videoDetails = playerResponse?.videoDetails || {};

            // Title, author, viewCount, videoId from playerResponse
            let videoId = videoDetails.videoId || '';

            // Fallback: extract videoId from URL if not in playerResponse
            if (!videoId) {
              const urlParams = new URLSearchParams(window.location.search);
              videoId = urlParams.get('v') || '';
            }

            const title = videoDetails.title || document.title.replace(' - YouTube', '');
          const channelTitle = videoDetails.author || '';
          const viewCount = parseInt(videoDetails.viewCount || '0', 10);

          // --- publishedAt: from microformat (locale-independent ISO date) ---
          let publishedAt = '';
          const microformat = playerResponse?.microformat?.playerMicroformatRenderer;
          if (microformat) {
            publishedAt = microformat.publishDate || microformat.uploadDate || '';
          }
          // Fallback: DOM selector
          if (!publishedAt) {
            const dateEl = document.querySelector('#info-strings yt-formatted-string, ytd-watch-metadata #info span');
            if (dateEl) publishedAt = dateEl.textContent?.trim() || '';
          }

          // --- BFS helper to search nested objects for a value ---
          function bfsFind(root, predicate, maxDepth = 15) {
            const stack = [{ obj: root, depth: 0 }];
            while (stack.length > 0) {
              const { obj, depth } = stack.pop();
              if (!obj || typeof obj !== 'object' || depth > maxDepth) continue;
              if (Array.isArray(obj)) {
                for (const item of obj) stack.push({ obj: item, depth: depth + 1 });
                continue;
              }
              const result = predicate(obj);
              if (result !== undefined) return result;
              for (const v of Object.values(obj)) {
                if (v && typeof v === 'object') stack.push({ obj: v, depth: depth + 1 });
              }
            }
            return undefined;
          }

          // Helper: parse abbreviated count string ("1.2K", "15 тыс.", "1.5M", "1,5 млн", "1,234")
          function parseCountStr(str) {
            if (!str) return 0;
            str = String(str).trim();
            if (!str) return 0;
            // Match a leading numeric chunk (digits, dots, commas, spaces) and an
            // optional K/M/тыс/млн suffix. Note: we intentionally accept the comma
            // here so we can decide below whether it is a decimal or thousands sep.
            const match = str.match(/([\d.,\s]+)\s*([KkМмТтMm]|тыс|млн|тис)?/i);
            if (!match) return 0;
            let numStr = match[1].replace(/\s/g, '');
            if (!numStr) return 0;
            const suffix = (match[2] || '').toLowerCase();

            // Heuristic:
            //   - If there is a K/M/тыс/млн suffix AND a comma is present, treat
            //     the comma as a decimal separator ("1,5K" → 1.5 → 1500).
            //   - Otherwise treat commas as thousands separators and strip them
            //     ("1,234" → 1234, "1,234,567" → 1234567).
            let num;
            if (suffix && numStr.includes(',')) {
              num = parseFloat(numStr.replace(',', '.'));
            } else {
              num = parseFloat(numStr.replace(/,/g, ''));
            }
            if (isNaN(num)) return 0;

            if (suffix === 'k' || suffix === 'т' || suffix === 'тыс' || suffix === 'тис') num *= 1000;
            else if (suffix === 'м' || suffix === 'm' || suffix === 'млн') num *= 1000000;
            return Math.round(num);
          }

          // --- likeCount: from pageData internal structures ---
          let likeCount = 0;

          // Strategy 1: BFS for like button view model with toggledText/defaultText
          if (pageData) {
            const likesFromData = bfsFind(pageData, (obj) => {
              // segmentedLikeDislikeButtonViewModel → likeButtonViewModel → likeStatusEntity
              if (obj.segmentedLikeDislikeButtonViewModel) {
                const likeVm = obj.segmentedLikeDislikeButtonViewModel.likeButtonViewModel;
                const likeEntity = likeVm?.likeStatusEntity;
                if (likeEntity?.likeStatus) {
                  // toggleButton has the count
                  const toggleBtn = likeVm?.toggleButtonViewModel?.toggleButtonViewModel;
                  const defaultText = toggleBtn?.defaultButtonViewModel?.buttonViewModel?.title;
                  if (defaultText) return parseCountStr(defaultText);
                }
              }
              // toggledText / defaultText in likeButtonViewModel
              if (obj.toggledText?.content && obj.defaultText?.content &&
                  (obj.toggledText.content.match(/[\d]/) || obj.defaultText.content.match(/[\d]/))) {
                return parseCountStr(obj.defaultText.content || obj.toggledText.content);
              }
              // factoid / topLevelButtons approach
              if (obj.factoid?.factoidRenderer?.value?.simpleText && obj.topLevelButtons) {
                // This is videoPrimaryInfoRenderer — likes are in topLevelButtons
                for (const btn of obj.topLevelButtons) {
                  const tbr = btn.segmentedLikeDislikeButtonRenderer || btn.segmentedLikeDislikeButtonViewModel;
                  if (tbr) {
                    const likeBtn = tbr.likeButton;
                    const toggleBtnR = likeBtn?.toggleButtonRenderer;
                    if (toggleBtnR) {
                      const txt = toggleBtnR.defaultText?.accessibility?.accessibilityData?.label
                        || toggleBtnR.accessibilityData?.accessibilityData?.label || '';
                      if (txt) return parseCountStr(txt);
                    }
                  }
                }
              }
              return undefined;
            }, 20);
            if (likesFromData) likeCount = likesFromData;
          }

          // Strategy 2: DOM fallback — multiple selectors for different layouts
          if (!likeCount) {
            const selectors = [
              'like-button-view-model button[aria-label]',
              'ytd-toggle-button-renderer.ytd-menu-renderer button[aria-label]',
              '#segmented-like-button button[aria-label]',
              'ytd-segmented-like-dislike-button-renderer button[aria-label]'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) {
                const ariaLabel = el.getAttribute('aria-label') || '';
                const m = ariaLabel.match(/([\d.,\s]+)/);
                if (m) {
                   const parsed = parseCountStr(ariaLabel);
                  if (parsed > 0) { likeCount = parsed; break; }
                }
              }
            }
          }

          // --- commentCount: from engagementPanels (available before comments lazy-load) ---
          let commentCount = 0;

          if (pageData) {
            // Strategy 1: commentsEntryPointHeaderRenderer in engagementPanels
            const commentsFromData = bfsFind(pageData, (obj) => {
              if (obj.commentsEntryPointHeaderRenderer) {
                const header = obj.commentsEntryPointHeaderRenderer;
                const countText = header.commentCount?.simpleText
                  || header.headerText?.runs?.map(r => r.text).join('') || '';
                if (countText) {
                   return parseCountStr(countText);
                }
              }
              // Also check commentsCountText in section header
              if (obj.commentsCount?.simpleText) {
                 return parseCountStr(obj.commentsCount.simpleText);
              }
              return undefined;
            }, 15);
            if (commentsFromData) commentCount = commentsFromData;
          }

          // Strategy 2: ytd-comments component data (if comments section has loaded)
          if (!commentCount) {
            const commentsEl = document.querySelector('ytd-comments');
            const commentsData = commentsEl?.data || commentsEl?.__data;
            if (commentsData) {
              const countFromComments = bfsFind(commentsData, (obj) => {
                if (obj.countText?.runs) {
                  const text = obj.countText.runs.map(r => r.text).join('');
                   return parseCountStr(text);
                }
                return undefined;
              }, 10);
              if (countFromComments) commentCount = countFromComments;
            }
          }

          return { videoId, title, channelTitle, publishedAt, viewCount, likeCount, commentCount };
        }
      });
      const result = results?.[0]?.result;

      // Use fallbackVideoId if DOM extraction failed
      if (result && !result.videoId && fallbackVideoId) {
        result.videoId = fallbackVideoId;
        console.log('[YT-Comments] Using fallback videoId from URL:', fallbackVideoId);
      }

      if (result && result.videoId) {
        return result;
      }

      // If no videoId found, retry (page may not be fully loaded)
      if (attempt < maxRetries - 1) {
        console.log(`[YT-Comments] Retry ${attempt + 1}/${maxRetries} - waiting for page to load...`);
        await this._delay(retryDelay);
        continue;
      }

      // Last attempt: use fallbackVideoId with minimal metadata
      if (fallbackVideoId) {
        console.log('[YT-Comments] Using fallback videoId with minimal metadata');
        return {
          videoId: fallbackVideoId,
          title: result?.title || 'YouTube Video',
          channelTitle: result?.channelTitle || '',
          publishedAt: result?.publishedAt || '',
          viewCount: result?.viewCount || 0,
          likeCount: result?.likeCount || 0,
          commentCount: result?.commentCount || 0
        };
      }

      throw this._makeError(this.ERRORS.VIDEO_NOT_FOUND, 'Could not extract video metadata from page');
    } catch (e) {
      if (e.code) throw e;
      console.error('getVideoMetadataFromDOM error:', e);

      // On last attempt with fallbackVideoId, return minimal metadata instead of throwing
      if (attempt >= maxRetries - 1 && fallbackVideoId) {
        console.log('[YT-Comments] Script error, using fallback videoId with minimal metadata');
        return {
          videoId: fallbackVideoId,
          title: 'YouTube Video',
          channelTitle: '',
          publishedAt: '',
          viewCount: 0,
          likeCount: 0,
          commentCount: 0
        };
      }

      if (attempt < maxRetries - 1) {
        console.log(`[YT-Comments] Error on attempt ${attempt + 1}, retrying...`);
        await this._delay(retryDelay);
        continue;
      }

      throw this._makeError(this.ERRORS.VIDEO_NOT_FOUND, 'Could not extract video metadata from page');
    }
    }
    // Should not reach here, but just in case
    throw this._makeError(this.ERRORS.VIDEO_NOT_FOUND, 'Could not extract video metadata from page');
  },

  // Fetch ALL comments via InnerTube API
  // tabId is required to extract ytcfg from the YouTube tab
  // Options: mode ('top'|'newest'), maxComments (0=unlimited), includeReplies (boolean)
  async fetchAllComments(videoId, { progressCallback, cancelToken, tabId, mode = 'top', maxComments = 0, includeReplies = true } = {}) {
    if (!tabId) {
      throw this._makeError(this.ERRORS.INVALID_REQUEST, 'tabId is required for InnerTube API');
    }

    // Step 1: Extract ytcfg and initial data from the YouTube tab
    const ytConfig = await this._extractYtConfig(tabId);
    if (!ytConfig || !ytConfig.INNERTUBE_API_KEY || !ytConfig.INNERTUBE_CONTEXT) {
      throw this._makeError(this.ERRORS.COMMENTS_DISABLED, 'Could not extract YouTube page config. Make sure you are on a YouTube video page.');
    }
    ytConfig.tabId = tabId;

    // Step 2: Find initial continuation token for comments section
    console.log('[YT-Comments] sortMenuItems:', ytConfig.sortMenuItems?.map(s => s.title));
    console.log('[YT-Comments] continuations count:', ytConfig.continuations?.length);
    console.log('[YT-Comments] mode:', mode, 'maxComments:', maxComments, 'includeReplies:', includeReplies);
    const initialToken = this._findCommentsContinuation(ytConfig, mode);
    if (!initialToken) {
      throw this._makeError(this.ERRORS.COMMENTS_DISABLED, 'Comments section not found. Comments may be disabled for this video.');
    }

    // Step 3: Fetch all comments via InnerTube pagination
    // Use two queues: top-level comments first, then replies
    const comments = [];
    const commentMap = new Map(); // id -> comment object (for attaching replies)
    const topQueue = [{ token: initialToken, type: 'top' }];
    const replyQueue = [];
    const seenTokens = new Set();
    const seenReplies = new Set();
    let pageCount = 0;
    let inRepliesPhase = false;

    // Phase 1 & 2: Process top-level pages first, then reply pages
    while (topQueue.length > 0 || replyQueue.length > 0) {
      if (cancelToken?.cancelled) return comments;

      // Check maxComments limit for top-level comments
      if (maxComments > 0 && comments.length >= maxComments && topQueue.length > 0) {
        // Clear remaining top-level pages, keep reply queue if includeReplies
        topQueue.length = 0;
        if (!includeReplies) {
          replyQueue.length = 0;
          break;
        }
        if (replyQueue.length === 0) break;
      }

      // Prioritize top-level comments over replies
      const isNowReplies = topQueue.length === 0;
      const { token, type, parentId: pageParentId } = !isNowReplies
        ? topQueue.shift()
        : replyQueue.shift();
      if (seenTokens.has(token)) continue;
      seenTokens.add(token);

      // Signal transition to replies phase
      if (isNowReplies && !inRepliesPhase) {
        inRepliesPhase = true;
        if (progressCallback) {
          progressCallback({ fetched: comments.length, total: null, phase: 'fetching_replies' });
        }
      }

      const response = await this._fetchCommentPage(token, ytConfig);
      if (!response) continue;

      if (cancelToken?.cancelled) return comments;

      // Parse comments and continuations from response
      const parsed = this._parseInnerTubeResponse(response, type);
      pageCount++;

      if (pageCount <= 5 || pageCount % 50 === 0 || parsed.continuations.filter(c => c.type === 'top').length === 0) {
        console.log(`[YT-Comments] page=${pageCount} type=${type} newComments=${parsed.comments.length} topConts=${parsed.continuations.filter(c=>c.type==='top').length} replyConts=${parsed.continuations.filter(c=>c.type==='replies').length} topQ=${topQueue.length} replyQ=${replyQueue.length} total=${comments.length}`);
      }

      // Process parsed comments
      // Entity mutations are not ordered; attach inline replies after parents.
      const ordered = [...parsed.comments.filter(comment => !comment.isReply),
        ...parsed.comments.filter(comment => comment.isReply)];
      for (const comment of ordered) {
        if (cancelToken?.cancelled) return comments;

        if (comment.isReply) {
          if (!includeReplies || seenReplies.has(comment.id)) continue;
          // Attach reply to parent comment
          const parentId = comment.parentId || pageParentId || comment.id.split('.')[0];
          const parent = commentMap.get(parentId);
          if (parent) {
            seenReplies.add(comment.id);
            parent.replies.push({
              id: comment.id,
              author: comment.author,
              text: comment.text,
              likeCount: comment.likeCount,
              publishedAt: comment.publishedAt,
              isPinned: !!comment.isPinned,
              isHearted: !!comment.isHearted,
              isMember: !!comment.isMember
            });
          }
        } else {
          if (commentMap.has(comment.id)) continue;
          if (maxComments > 0 && comments.length >= maxComments) continue;
          // Top-level comment
          const commentObj = {
            id: comment.id,
            author: comment.author,
            text: comment.text,
            likeCount: comment.likeCount,
            publishedAt: comment.publishedAt,
            totalReplyCount: comment.replyCount || 0,
            isPinned: !!comment.isPinned,
            isHearted: !!comment.isHearted,
            isMember: !!comment.isMember,
            replies: []
          };
          comments.push(commentObj);
          commentMap.set(comment.id, commentObj);

          if (progressCallback) {
            progressCallback({ fetched: comments.length, total: null });
          }

          // Check limit after adding
          if (maxComments > 0 && comments.length >= maxComments) {
            topQueue.length = 0;
            if (!includeReplies) {
              replyQueue.length = 0;
            }
          }
        }
      }

      // Route continuations to appropriate queues
      for (const cont of parsed.continuations) {
        if (cont.type === 'top') {
          // Only add if we haven't hit the limit
          if (maxComments === 0 || comments.length < maxComments) {
            topQueue.push(cont);
          }
        } else if (includeReplies && (!cont.parentId || commentMap.has(cont.parentId))) {
          replyQueue.push({ ...cont, parentId: cont.parentId || pageParentId });
        }
      }

      // Delay between requests (with jitter to reduce bot-detection risk).
      await this._delay(this.REQUEST_DELAY + Math.random() * this.REQUEST_JITTER);
    }

    return comments;
  },

  // Extract ytcfg from YouTube tab via chrome.scripting.executeScript
  // Uses DOM component data instead of window.ytInitialData which goes stale on SPA navigation
  async _extractYtConfig(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const ytcfg = window.ytcfg?.data_ || {};

          // YouTube is an SPA — window.ytInitialData goes stale on navigation.
          // Read current page data from DOM components instead.
          const commentsEl = document.querySelector('ytd-comments');
          const commentsData = commentsEl?.data || commentsEl?.__data;
          const watchFlexy = document.querySelector('ytd-watch-flexy');
          const pageData = watchFlexy?.data || watchFlexy?.__data;

          // BFS helper to find sort menu and continuation tokens
          const continuations = [];
          let sortMenuItems = null;
          const stack = [];
          const MAX_DEPTH = 20;

          // Primary source: comments section data (most reliable for sort menu + continuations)
          if (commentsData) stack.push({ obj: commentsData, depth: 0 });

          // Secondary source: page data (for initial load / fallback)
          if (pageData?.contents?.twoColumnWatchNextResults) {
            const wr = pageData.contents.twoColumnWatchNextResults;
            if (wr.results) stack.push({ obj: wr.results, depth: 0 });
          }
          if (pageData?.engagementPanels) {
            stack.push({ obj: pageData.engagementPanels, depth: 0 });
          }

          // Last resort: window.ytInitialData (stale on SPA nav, but works on fresh page load)
          if (stack.length === 0) {
            const ytInitialData = window.ytInitialData || {};
            const wr = ytInitialData?.contents?.twoColumnWatchNextResults;
            if (wr?.results) stack.push({ obj: wr.results, depth: 0 });
            if (ytInitialData?.engagementPanels) stack.push({ obj: ytInitialData.engagementPanels, depth: 0 });
          }

          while (stack.length > 0) {
            const { obj, depth } = stack.pop();
            if (!obj || typeof obj !== 'object' || depth > MAX_DEPTH) continue;

            if (Array.isArray(obj)) {
              for (const item of obj) {
                stack.push({ obj: item, depth: depth + 1 });
              }
              continue;
            }

            // Check for sort menu (sortFilterSubMenuRenderer)
            if (obj.sortFilterSubMenuRenderer?.subMenuItems && !sortMenuItems) {
              sortMenuItems = obj.sortFilterSubMenuRenderer.subMenuItems.map(item => {
                const token = item.serviceEndpoint?.continuationCommand?.token
                  || item.continuation?.reloadContinuationData?.continuation
                  || null;
                return { title: item.title, token, selected: item.selected || false };
              });
            }

            // Check for continuation tokens
            const cc = obj.continuationCommand;
            if (cc?.token) {
              continuations.push({ token: cc.token, targetId: cc.targetId || null });
            }
            const ec = obj.continuationEndpoint?.continuationCommand;
            if (ec?.token) {
              continuations.push({ token: ec.token, targetId: ec.targetId || null });
            }

            for (const v of Object.values(obj)) {
              if (v && typeof v === 'object') {
                stack.push({ obj: v, depth: depth + 1 });
              }
            }
          }

          return {
            INNERTUBE_API_KEY: ytcfg.INNERTUBE_API_KEY || null,
            INNERTUBE_CONTEXT: ytcfg.INNERTUBE_CONTEXT || null,
            continuations,
            sortMenuItems
          };
        }
      });
      return results?.[0]?.result || null;
    } catch (e) {
      console.error('_extractYtConfig error:', e);
      return null;
    }
  },

  // Find the comments section continuation token from extracted data
  // mode: 'top' = Top comments (index 0), 'newest' = Newest first (index 1)
  _findCommentsContinuation(ytConfig, mode = 'top') {
    // Strategy 1: Use sort menu to pick the desired sort order
    if (ytConfig?.sortMenuItems && ytConfig.sortMenuItems.length >= 2) {
      const sortIndex = mode === 'newest' || mode === 'new' ? 1 : 0;
      const sortItem = ytConfig.sortMenuItems[sortIndex];
      if (sortItem?.token) {
        console.log(`[YT-Comments] Using sort "${sortItem.title}" (mode=${mode})`);
        return sortItem.token;
      }
    }

    // Strategy 2: Fallback to comments-section continuation
    if (ytConfig?.continuations) {
      const commentsToken = ytConfig.continuations.find(
        c => c.targetId === 'comments-section'
      );
      if (commentsToken) return commentsToken.token;

      // Last resort: first continuation token
      if (ytConfig.continuations.length > 0) {
        return ytConfig.continuations[0].token;
      }
    }

    return null;
  },

  // Fetch a page of comments via InnerTube API.
  // Executes fetch in the YouTube tab context to send proper cookies/origin.
  // Retry policy: 1 initial attempt + up to `MAX_RETRIES` (2) retries on
  // transient failures (HTTP 429/500/503, network errors, script exec errors)
  // with exponential backoff (1s, 2s) — per task spec bug #8.
  async _fetchCommentPage(continuation, ytConfig) {
    const apiKey = ytConfig.INNERTUBE_API_KEY;
    const context = ytConfig.INNERTUBE_CONTEXT;
    const tabId = ytConfig.tabId;
    const maxAttempts = 1 + (this.MAX_RETRIES || 2);

    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async (apiKey, context, continuation) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            try {
              const response = await fetch(
                `https://www.youtube.com/youtubei/v1/next?key=${apiKey}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  signal: controller.signal,
                  body: JSON.stringify({ context, continuation })
                }
              );
              if (response.ok) {
                return { ok: true, data: await response.json() };
              }
              return { ok: false, status: response.status };
            } catch (e) {
              return { ok: false, error: e.message };
            } finally {
              clearTimeout(timer);
            }
          },
          args: [apiKey, context, continuation]
        });

        const result = results?.[0]?.result;
        if (!result) {
          throw new Error('Script execution failed');
        }

        if (result.ok) {
          return result.data;
        }

        // Transient HTTP errors: retry with exponential backoff (1s, 2s).
        if ((result.error || [429, 500, 502, 503, 504].includes(result.status)) && attempt < maxAttempts - 1) {
          lastErr = this._makeError(
            this.ERRORS.NETWORK_ERROR,
            result.error || `InnerTube API error: HTTP ${result.status}`
          );
          await this._delay(Math.pow(2, attempt) * 1000);
          continue;
        }

        // Non-retryable HTTP error (e.g., 400, 403, 404) — bail immediately.
        throw this._makeError(
          this.ERRORS.NETWORK_ERROR,
          result.error || `InnerTube API error: HTTP ${result.status}`
        );
      } catch (e) {
        if (e.code) throw e; // Already a typed error from above.
        lastErr = e;
        if (attempt >= maxAttempts - 1) {
          throw this._makeError(this.ERRORS.NETWORK_ERROR, e.message);
        }
        // Exponential backoff: 1s on first retry, 2s on second.
        await this._delay(Math.pow(2, attempt) * 1000);
      }
    }
    // Should not reach here, but throw a typed error just in case.
    throw lastErr || this._makeError(this.ERRORS.NETWORK_ERROR, 'Unknown fetch error');
  },

  // Parse InnerTube response to extract comments and continuations.
  //
  // Handles BOTH comment formats YouTube serves (2024-2025):
  //   - OLD: commentThreadRenderer.comment.commentRenderer (with replies in
  //          commentThreadRenderer.replies.commentRepliesRenderer.contents)
  //   - NEW: commentThreadRenderer.comment.commentViewModel (entity payload in
  //          frameworkUpdates.entityBatchUpdate.mutations[].payload.commentEntityPayload,
  //          linked via commentViewModel.commentKey). Reply continuation tokens
  //          can live in commentRepliesRenderer.contents[] (continuationItemRenderer),
  //          commentRepliesRenderer.continuations[].nextContinuationData.continuation,
  //          OR commentRepliesRenderer.continuations[].button.nextcontinuationToken.
  //
  // Also extracts pinned / hearted / member badges from multiple known field paths.
  _parseInnerTubeResponse(response, continuationType) {
    const comments = [];
    const continuations = [];
    const seenCommentIds = new Set();
    // Map: commentId -> comment object (so commentViewModel metadata can be
    // merged back onto the entity-payload-derived comment object).
    const commentById = new Map();
    const commentByEntityKey = new Map();

    // Step 1: Extract comments from entity payloads (new format).
    // These are in frameworkUpdates.entityBatchUpdate.mutations.
    const mutations = response?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
    for (const mutation of mutations) {
      const payload = mutation?.payload?.commentEntityPayload;
      if (!payload) continue;

      const props = payload.properties || {};
      const author = payload.author || {};
      const toolbar = payload.toolbar || {};

      const commentId = props.commentId || '';
      if (!commentId || seenCommentIds.has(commentId)) continue;
      seenCommentIds.add(commentId);

      let likeCount = 0;
      const likeStr = toolbar.likeCountNotliked || toolbar.likeCountLiked || '';
      if (likeStr) likeCount = this._parseLikeCount(likeStr);

      // Extract badges from the entity payload itself (defensive — multiple paths).
      const badges = this._extractBadges(payload, /*viewModel=*/ null);

      const comment = {
        id: commentId,
        author: author.displayName || '',
        text: props.content?.content || '',
        likeCount,
        publishedAt: props.publishedTime || '',
        isReply: continuationType === 'replies' || commentId.includes('.'),
        parentId: props.parentCommentId || null,
        replyCount: 0,
        isPinned: badges.isPinned,
        isHearted: badges.isHearted,
        isMember: badges.isMember
      };
      comments.push(comment);
      commentById.set(commentId, comment);
      if (mutation.entityKey) commentByEntityKey.set(mutation.entityKey, comment);
    }

    // Step 2: Process onResponseReceivedEndpoints — the main structure that
    // contains both commentThreadRenderer (top-level) and standalone
    // commentViewModel / commentRenderer items (reply pages).
    const endpoints = response?.onResponseReceivedEndpoints || [];
    for (const endpoint of endpoints) {
      // Get the action object and its target
      const action = endpoint.reloadContinuationItemsCommand
        || endpoint.appendContinuationItemsAction;
      if (!action) continue;

      const targetId = action.targetId || '';
      const isRepliesSection = continuationType === 'replies' || targetId.startsWith('comment-replies-item');
      const items = action.continuationItems || [];

      for (const item of items) {
        // 2a: Comment thread (top-level comment + reply info)
        const thread = item.commentThreadRenderer;
        if (thread) {
          let topLevelComment = null;

          // 2a-i: NEW format — commentViewModel at thread.comment.commentViewModel.
          // The viewModel carries the commentId, replyCount and badges; the
          // actual text/author/likes live in the entity payload (already parsed
          // in step 1 and stored in `commentById`).
          const rawViewModel = thread.comment?.commentViewModel || thread.commentViewModel;
          const viewModel = rawViewModel?.commentViewModel || rawViewModel;
          if (viewModel) {
            const vmCommentId = viewModel.commentId
              || viewModel.comment?.commentId
              || commentByEntityKey.get(viewModel.commentKey)?.id
              || '';
            if (vmCommentId) {
              // Link the viewModel metadata to the entity-payload comment.
              topLevelComment = commentById.get(vmCommentId) || null;

              // If we somehow didn't see this commentId in the entity payloads
              // (e.g., malformed response), create a stub so downstream code can
              // still attach replies. Log a warning for resilience.
              if (!topLevelComment) {
                console.warn('[YT-Comments] commentViewModel commentId not found in entity payloads:', vmCommentId);
                topLevelComment = {
                  id: vmCommentId,
                  author: '',
                  text: '',
                  likeCount: 0,
                  publishedAt: '',
                  isReply: false,
                  replyCount: 0,
                  isPinned: false,
                  isHearted: false,
                  isMember: false
                };
                comments.push(topLevelComment);
                commentById.set(vmCommentId, topLevelComment);
                seenCommentIds.add(vmCommentId);
              }

              // Merge badges + replyCount from the viewModel.
              const vmBadges = this._extractBadges(null, viewModel);
              if (vmBadges.isPinned) topLevelComment.isPinned = true;
              if (vmBadges.isHearted) topLevelComment.isHearted = true;
              if (vmBadges.isMember) topLevelComment.isMember = true;

              const vmReplyCount = viewModel.comment?.replyCount
                ?? viewModel.replyCount
                ?? null;
              if (typeof vmReplyCount === 'number' && vmReplyCount > topLevelComment.replyCount) {
                topLevelComment.replyCount = vmReplyCount;
              }
            }
          }

          // 2a-ii: OLD format — commentRenderer at thread.comment.commentRenderer.
          // (Some responses serve BOTH a viewModel and a renderer for the same
          // thread — prefer viewModel for badges/replyCount, but fall back to
          // renderer if no viewModel was present.)
          if (!topLevelComment || !topLevelComment.text) {
            const renderer = thread.comment?.commentRenderer;
            if (renderer) {
              const parsed = this._parseCommentRenderer(renderer);
              if (parsed && !seenCommentIds.has(parsed.id)) {
                seenCommentIds.add(parsed.id);
                parsed.isReply = false;
                comments.push(parsed);
                commentById.set(parsed.id, parsed);
                topLevelComment = parsed;
              } else if (parsed) {
                topLevelComment = commentById.get(parsed.id) || null;
              }
            }
          }

          // 2a-iii: Extract reply metadata + continuation tokens from
          // thread.replies.commentRepliesRenderer — works for BOTH formats.
          const repliesRenderer = thread.replies?.commentRepliesRenderer;
          if (repliesRenderer) {
            // Update reply count on the matching top-level comment using the
            // "View N replies" button text (when present).
            const viewRepliesText = repliesRenderer.viewReplies?.buttonRenderer?.text;
            if (viewRepliesText) {
              const text = this._extractText(viewRepliesText);
              const countMatch = text.match(/(\d[\d\s,.]*)/);
              if (countMatch) {
                const replyCount = parseInt(countMatch[1].replace(/[\s,.]/g, ''), 10) || 0;
                if (topLevelComment && replyCount > topLevelComment.replyCount) {
                  topLevelComment.replyCount = replyCount;
                }
              }
            }

            // Reply continuation tokens. YouTube has used several locations:
            //   1. repliesRenderer.contents[] / subThreads[] → continuationItemRenderer
            //      (with continuationEndpoint.continuationCommand.token or
            //      button.buttonRenderer.command.continuationCommand.token)
            //   2. repliesRenderer.continuations[].nextContinuationData.continuation
            //   3. repliesRenderer.continuations[].button.buttonRenderer.command
            //      .continuationCommand.token (note: lowercase "nextcontinuationToken"
            //      has also been observed in the wild)
            //   4. repliesRenderer.viewReplies.buttonRenderer.command.continuationCommand.token
            const replyCont = repliesRenderer.contents || repliesRenderer.subThreads;
            if (Array.isArray(replyCont)) {
              for (const rc of replyCont) {
                const inlineRenderer = rc.commentRenderer;
                const inlineViewModel = rc.commentViewModel?.commentViewModel || rc.commentViewModel;
                const reply = inlineRenderer ? this._parseCommentRenderer(inlineRenderer)
                  : commentById.get(inlineViewModel?.commentId) || commentByEntityKey.get(inlineViewModel?.commentKey);
                if (reply) {
                  reply.isReply = true;
                  reply.parentId = topLevelComment?.id || null;
                  if (!seenCommentIds.has(reply.id)) {
                    seenCommentIds.add(reply.id);
                    comments.push(reply);
                    commentById.set(reply.id, reply);
                  }
                }
                const cir = rc?.continuationItemRenderer;
                if (!cir) continue;
                const contToken = cir.continuationEndpoint?.continuationCommand?.token
                  || cir.button?.buttonRenderer?.command?.continuationCommand?.token;
                if (contToken) {
                  continuations.push({ token: contToken, type: 'replies', parentId: topLevelComment?.id });
                }
              }
            }

            if (Array.isArray(repliesRenderer.continuations)) {
              for (const c of repliesRenderer.continuations) {
                const token = c?.nextContinuationData?.continuation
                  || c?.button?.buttonRenderer?.command?.continuationCommand?.token
                  || c?.button?.buttonRenderer?.command?.continuationCommand?.continuation
                  || c?.nextcontinuationToken
                  || null;
                if (token) {
                  continuations.push({ token, type: 'replies', parentId: topLevelComment?.id });
                }
              }
            }

            // Some responses put the reply continuation token directly on the
            // "View N replies" button itself (separate from the text).
            const viewRepliesCmd = repliesRenderer.viewReplies?.buttonRenderer?.command;
            if (viewRepliesCmd) {
              const token = viewRepliesCmd.continuationCommand?.token
                || viewRepliesCmd.continuationCommand?.continuation
                || null;
              if (token) {
                continuations.push({ token, type: 'replies', parentId: topLevelComment?.id });
              }
            }
          }
        }

        // 2b: Standalone commentViewModel (reply pages in new format).
        // The entity payload was already added in step 1 — just look it up
        // (no-op if already present) and merge viewModel badges.
        const standaloneViewModel = item.commentViewModel?.commentViewModel || item.commentViewModel;
        if (standaloneViewModel) {
          const vmCommentId = standaloneViewModel.commentId
            || standaloneViewModel.comment?.commentId
            || commentByEntityKey.get(standaloneViewModel.commentKey)?.id
            || '';
          if (vmCommentId && !seenCommentIds.has(vmCommentId)) {
            // Entity payload was missing — create a stub. (Resilience: log it.)
            console.warn('[YT-Comments] Standalone commentViewModel without matching entity payload:', vmCommentId);
            seenCommentIds.add(vmCommentId);
            const stub = {
              id: vmCommentId,
              author: '',
              text: '',
              likeCount: 0,
              publishedAt: '',
              isReply: isRepliesSection || vmCommentId.includes('.'),
              replyCount: 0,
              isPinned: false,
              isHearted: false,
              isMember: false
            };
            comments.push(stub);
            commentById.set(vmCommentId, stub);
          }
          // Merge badges onto the existing comment object if it exists.
          if (vmCommentId) {
            const existing = commentById.get(vmCommentId);
            if (existing) {
              const vmBadges = this._extractBadges(null, standaloneViewModel);
              if (vmBadges.isPinned) existing.isPinned = true;
              if (vmBadges.isHearted) existing.isHearted = true;
              if (vmBadges.isMember) existing.isMember = true;
            }
          }
        }

        // 2c: Standalone commentRenderer (for reply pages in old format)
        const commentRenderer = item.commentRenderer;
        if (commentRenderer) {
          const comment = this._parseCommentRenderer(commentRenderer);
          if (comment && !seenCommentIds.has(comment.id)) {
            seenCommentIds.add(comment.id);
            comment.isReply = isRepliesSection || comment.id.includes('.');
            comments.push(comment);
            commentById.set(comment.id, comment);
          }
        }

        // 2d: Continuation token for NEXT PAGE (always last item)
        const contRenderer = item.continuationItemRenderer;
        if (contRenderer) {
          const contCmd = contRenderer.continuationEndpoint?.continuationCommand;
          if (contCmd?.token) {
            const type = isRepliesSection ? 'replies' : 'top';
            continuations.push({ token: contCmd.token, type });
          }
          // Also check button-based continuation
          const btnCont = contRenderer.button?.buttonRenderer?.command?.continuationCommand;
          if (btnCont?.token) {
            const type = isRepliesSection ? 'replies' : 'top';
            continuations.push({ token: btnCont.token, type });
          }
        }
      }
    }

    // Deduplicate continuation tokens
    const uniqueContinuations = [];
    const seenTokens = new Set();
    for (const cont of continuations) {
      if (!seenTokens.has(cont.token)) {
        seenTokens.add(cont.token);
        uniqueContinuations.push(cont);
      }
    }

    return { comments: comments.filter(comment => typeof comment.text === 'string' && comment.text.trim()),
      continuations: uniqueContinuations };
  },

  // Extract pinned / hearted / member badges from a comment source.
  // `payload` is a commentEntityPayload (new format); `viewModel` is a
  // commentViewModel. Either may be null. Returns {isPinned, isHearted, isMember}.
  // Checks multiple known field paths for resilience across YouTube variants.
  _extractBadges(payload, viewModel) {
    const result = { isPinned: false, isHearted: false, isMember: false };

    // --- Pinned ---
    // Paths observed:
    //   payload.pinnedCommentText (entity payload, new format)
    //   payload.pinnedCommentBadge (entity payload, alt)
    //   viewModel.comment.pinnedCommentText
    //   viewModel.comment.pinnedCommentBadge
    //   viewModel.pinnedCommentText
    //   commentRenderer.pinnedCommentText (handled in _parseCommentRenderer)
    if (payload) {
      if (payload.pinnedCommentText || payload.pinnedCommentBadge) {
        result.isPinned = true;
      }
    }
    if (viewModel) {
      const vmComment = viewModel.comment || viewModel;
      if (vmComment.pinnedCommentText || vmComment.pinnedCommentBadge || viewModel.pinnedCommentText) {
        result.isPinned = true;
      }
    }

    // --- Hearted ---
    // Paths observed:
    //   payload.hearted
    //   viewModel.comment.hearted
    //   viewModel.hearted
    //   commentRenderer.actionButtons.commentActionButtonsRenderer.likeButton
    //     .likeButtonRenderer.isHearted (handled in _parseCommentRenderer)
    if (payload && payload.hearted === true) {
      result.isHearted = true;
    }
    if (viewModel) {
      const vmComment = viewModel.comment || viewModel;
      if (vmComment.hearted === true || viewModel.hearted === true) {
        result.isHearted = true;
      }
    }

    // --- Member (sponsor) ---
    // Paths observed:
    //   payload.sponsorCommentBadgeRenderer
    //   payload.avatar?.sponsorCommentBadgeRenderer
    //   viewModel.comment.sponsorCommentBadge
    //   viewModel.sponsorCommentBadge
    //   commentRenderer.sponsorCommentBadgeRenderer (handled in _parseCommentRenderer)
    if (payload) {
      if (payload.sponsorCommentBadgeRenderer
          || payload.avatar?.sponsorCommentBadgeRenderer
          || payload.sponsorCommentBadge) {
        result.isMember = true;
      }
    }
    if (viewModel) {
      const vmComment = viewModel.comment || viewModel;
      if (vmComment.sponsorCommentBadge
          || vmComment.sponsorCommentBadgeRenderer
          || viewModel.sponsorCommentBadge) {
        result.isMember = true;
      }
    }

    return result;
  },

  // Parse a commentRenderer into a comment object (old format).
  // Also extracts pinned / hearted / member badges from the renderer's known
  // field paths.
  _parseCommentRenderer(renderer) {
    if (!renderer) return null;
    const commentId = renderer.commentId || '';
    if (!commentId) return null;

    // Pinned: pinnedCommentText is present on the renderer for pinned comments.
    const isPinned = !!(renderer.pinnedCommentText || renderer.pinnedCommentBadge);

    // Member (sponsor): sponsorCommentBadgeRenderer is present.
    const isMember = !!(renderer.sponsorCommentBadgeRenderer
      || renderer.comment?.sponsorCommentBadgeRenderer);

    // Hearted: actionButtons.commentActionButtonsRenderer.likeButton
    //          .likeButtonRenderer.isHearted
    let isHearted = false;
    const likeButton = renderer.actionButtons?.commentActionButtonsRenderer?.likeButton;
    if (likeButton) {
      const likeButtonRenderer = likeButton.likeButtonRenderer
        || likeButton.toggleButtonRenderer?.likeButtonRenderer
        || null;
      if (likeButtonRenderer?.isHearted === true
          || likeButton.isHearted === true
          || likeButton.heartedAtIndex !== undefined) {
        isHearted = true;
      }
    }
    // Some renderers expose `hearted` directly.
    if (renderer.hearted === true) isHearted = true;

    return {
      id: commentId,
      author: renderer.authorText?.simpleText || '',
      text: this._extractText(renderer.contentText),
      likeCount: renderer.voteCount?.simpleText
        ? this._parseLikeCount(renderer.voteCount.simpleText)
        : 0,
      publishedAt: renderer.publishedTimeText?.runs?.[0]?.text || '',
      isReply: commentId.includes('.'),
      replyCount: renderer.replyCount || 0,
      isPinned,
      isHearted,
      isMember
    };
  },

  // Public helper: fetch all replies for a single top-level comment via a
  // reply-continuation token (the token found in
  // commentRepliesRenderer.contents/subThreads/continuations during top-level
  // parsing). Returns an array of reply objects:
  //   [{ id, author, text, likeCount, publishedAt, isPinned, isHearted, isMember }]
  // Useful when a caller wants to lazily load replies for one comment without
  // paginating through the whole comment section.
  //
  // videoId is required for context (it is included in the InnerTube context
  // when present); the actual reply contents come from the continuation token.
  async fetchReplies(videoId, replyContinuationToken, { tabId, ytConfig, maxPages = 0 } = {}) {
    if (!replyContinuationToken) {
      throw this._makeError(this.ERRORS.INVALID_REQUEST, 'replyContinuationToken is required');
    }
    if (!tabId) {
      throw this._makeError(this.ERRORS.INVALID_REQUEST, 'tabId is required for fetchReplies');
    }

    // If a ytConfig wasn't supplied, extract it from the tab.
    let cfg = ytConfig;
    if (!cfg) {
      cfg = await this._extractYtConfig(tabId);
    }
    if (!cfg || !cfg.INNERTUBE_API_KEY || !cfg.INNERTUBE_CONTEXT) {
      throw this._makeError(this.ERRORS.COMMENTS_DISABLED, 'Could not extract YouTube page config for fetchReplies.');
    }
    cfg.tabId = tabId;

    const replies = [];
    let token = replyContinuationToken;
    let pages = 0;
    const seenTokens = new Set();
    const seenIds = new Set();

    while (token) {
      if (maxPages > 0 && pages >= maxPages) break;
      if (seenTokens.has(token)) break;
      seenTokens.add(token);

      const response = await this._fetchCommentPage(token, cfg);
      if (!response) break;

      const parsed = this._parseInnerTubeResponse(response, 'replies');
      pages++;

      for (const c of parsed.comments) {
        if (!c.isReply || seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        replies.push({
          id: c.id,
          author: c.author,
          text: c.text,
          likeCount: c.likeCount,
          publishedAt: c.publishedAt,
          isPinned: !!c.isPinned,
          isHearted: !!c.isHearted,
          isMember: !!c.isMember
        });
      }

      // Find the next-page reply continuation (if any).
      const next = parsed.continuations.find(c => c.type === 'replies')
        || parsed.continuations[0]
        || null;
      token = next ? next.token : null;

      // Throttle between pages.
      await this._delay(this.REQUEST_DELAY + Math.random() * this.REQUEST_JITTER);
    }

    return replies;
  },

  // Extract text from YouTube's text object (runs or simpleText)
  _extractText(textObj) {
    if (!textObj) return '';
    if (textObj.simpleText) return textObj.simpleText;
    if (textObj.runs) {
      return textObj.runs.map(r => r.text || '').join('');
    }
    return '';
  },

  // Parse a like-count string into a number.
  // Handles: "1234", "1,234" (thousands sep), "1.2K", "3.4M", "1,5K" (Cyrillic
  // decimal comma). Returns 0 for unparseable values.
  //
  // Previous bug: `parseFloat("1,234".replace(',', '.'))` produced 1.234 which
  // Math.round() truncated to 1. Now commas are treated as thousands separators
  // unless a K/M suffix is present (in which case the comma is a decimal sep).
  _parseLikeCount(str) {
    if (!str) return 0;
    str = String(str).trim();
    if (!str) return 0;

    // Strip whitespace, then capture leading numeric chunk + optional suffix.
    str = str.replace(/\s+/g, '');
    const match = str.match(/^([\d.,]+)\s*(тыс\.?|тис\.?|млн\.?|[KkМмMmТт])?/i);
    if (!match) return 0;

    let numStr = match[1];
    if (!numStr) return 0;
    const suffix = (match[2] || '').toLowerCase().replace('.', '');

    let num;
    if (suffix && numStr.includes(',')) {
      // Has K/M suffix and a comma → comma is decimal separator ("1,5K" → 1.5).
      num = parseFloat(numStr.replace(',', '.'));
    } else {
      // No suffix OR no comma → treat commas as thousands separators ("1,234" → 1234).
      num = parseFloat(numStr.replace(/,/g, ''));
    }
    if (isNaN(num)) return 0;

    if (['k', 'т', 'тыс', 'тис'].includes(suffix)) num *= 1000;
    else if (['m', 'м', 'млн'].includes(suffix)) num *= 1000000;

    return Math.round(num);
  },

  // Create error with code
  _makeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  },

  // Delay helper
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};
