const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, plain } = require('../helpers/background.cjs');

function renderer(id, text = id) {
  return { commentId: id, authorText: { simpleText: 'Author' }, contentText: { runs: [{ text }] } };
}

test('YouTube sorting accepts the persisted legacy "new" value', () => {
  const api = loadBackground().run('YouTubeCommentsAPI');
  assert.equal(api._findCommentsContinuation({ sortMenuItems: [
    { title: 'Top', token: 'top-token' }, { title: 'Newest', token: 'new-token' }
  ] }, 'new'), 'new-token');
});

test('Like counts handle decimal commas and Cyrillic millions', () => {
  const api = loadBackground().run('YouTubeCommentsAPI');
  for (const [text, expected] of [['1,234', 1234], ['1,5K', 1500], ['3.4M', 3400000], ['1,2 млн', 1200000]]) {
    assert.equal(api._parseLikeCount(text), expected, text);
  }
});

test('Old YouTube responses retain inline replies and parent IDs', () => {
  const api = loadBackground().run('YouTubeCommentsAPI');
  const response = { onResponseReceivedEndpoints: [{ appendContinuationItemsAction: {
    targetId: 'comments-section', continuationItems: [{ commentThreadRenderer: {
      comment: { commentRenderer: renderer('parent') },
      replies: { commentRepliesRenderer: { contents: [{ commentRenderer: renderer('parent.reply', 'Reply') }] } }
    } }]
  } }] };
  const result = api._parseInnerTubeResponse(response, 'top');
  assert.equal(result.comments.length, 2);
  assert.equal(result.comments[1].parentId, 'parent');
});

test('New YouTube view models link commentKey to entity mutations', () => {
  const api = loadBackground().run('YouTubeCommentsAPI');
  const result = api._parseInnerTubeResponse({
    frameworkUpdates: { entityBatchUpdate: { mutations: [{ entityKey: 'entity-1', payload: {
      commentEntityPayload: { properties: { commentId: 'parent', content: { content: 'Hello' } }, author: { displayName: 'A' } }
    } }] } },
    onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { targetId: 'comments-section', continuationItems: [{
      commentThreadRenderer: {
        comment: { commentViewModel: { commentKey: 'entity-1', replyCount: 2 } },
        replies: { commentRepliesRenderer: { contents: [{ continuationItemRenderer: {
          continuationEndpoint: { continuationCommand: { token: 'reply-token' } }
        } }] } }
      }
    }] } }]
  }, 'top');
  assert.equal(result.comments[0].replyCount, 2);
  assert.equal(result.continuations[0].parentId, 'parent');
});

test('Network failures retry instead of failing the first InnerTube request', async () => {
  let attempts = 0;
  const env = loadBackground({ scriptHandler: async () => [{ result: ++attempts < 3
    ? { ok: false, error: 'Failed to fetch' }
    : { ok: true, data: { response: 'ok' } } }] });
  const api = env.run('YouTubeCommentsAPI');
  const result = await env.settle(api._fetchCommentPage('token', { tabId: 7, INNERTUBE_API_KEY: 'key', INNERTUBE_CONTEXT: {} }));
  assert.equal(result.response, 'ok');
  assert.equal(attempts, 3);
});

test('YouTube pagination deduplicates comments and repeated continuation tokens', async () => {
  const env = loadBackground();
  const api = env.run('YouTubeCommentsAPI');
  api._extractYtConfig = async () => ({ INNERTUBE_API_KEY: 'key', INNERTUBE_CONTEXT: {}, continuations: [{ token: 'first' }] });
  api._delay = async () => {};
  const seen = [];
  api._fetchCommentPage = async token => {
    if (seen.includes(token)) throw new Error('A continuation was requested twice');
    seen.push(token);
    return { onResponseReceivedEndpoints: [{ appendContinuationItemsAction: {
      targetId: 'comments-section', continuationItems: [
        { commentThreadRenderer: { comment: { commentRenderer: renderer('same-id') } } },
        { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'second' } } } }
      ]
    } }] };
  };
  const result = await api.fetchAllComments('abcdefghijk', { tabId: 7 });
  assert.equal(result.length, 1);
  assert.deepEqual(seen, ['first', 'second']);
});

test('Paginated replies keep their parent even when reply IDs do not encode it', async () => {
  const api = loadBackground().run('YouTubeCommentsAPI');
  const next = token => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
  api._extractYtConfig = async () => ({ INNERTUBE_API_KEY: 'key', INNERTUBE_CONTEXT: {}, continuations: [{ token: 'top' }] });
  api._delay = async () => {};
  api._fetchCommentPage = async token => token === 'top' ? {
    onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { targetId: 'comments-section', continuationItems: [{
      commentThreadRenderer: { comment: { commentRenderer: renderer('parent') },
        replies: { commentRepliesRenderer: { contents: [next('replies-1')] } } }
    }] } }]
  } : {
    frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: { commentEntityPayload: {
      properties: { commentId: token === 'replies-1' ? 'opaque-one' : 'opaque-two', content: { content: token } }
    } } }] } },
    onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { targetId: 'comment-replies-item',
      continuationItems: token === 'replies-1' ? [next('replies-2')] : [] } }]
  };
  const comments = await api.fetchAllComments('abcdefghijk', { tabId: 7 });
  assert.deepEqual(plain(comments[0].replies.map(reply => reply.id)), ['opaque-one', 'opaque-two']);
});

test('Markdown sanitizes HTML while preserving multiline reply indentation', () => {
  const formatter = loadBackground().run('CommentsToMd');
  const parts = formatter.format({ title: 'Video', videoId: 'abcdefghijk', publishedAt: '2026-07-01' }, [{
    id: 'parent', author: '<img onerror=x>', text: '&lt;script&gt; \u0000safe', likeCount: 1,
    publishedAt: '2 days ago', replies: [{ author: 'Reply', text: 'line 1\nline 2', likeCount: 0 }]
  }], { lang: 'ru' });
  assert.ok(parts[0].text.includes('Комментарии YouTube'));
  assert.ok(!parts[0].text.includes('<img'));
  assert.ok(parts[0].text.includes('  line 1\n  line 2'));
  assert.ok(!parts[0].text.includes('\u0000'));
});

test('ISO dates without a time are formatted consistently', () => {
  const formatter = loadBackground().run('CommentsToMd');
  assert.equal(formatter._formatDateCompact('2026-07-01'), '01.07.2026');
  assert.equal(formatter._formatDateCompact('2 days ago'), '2 days ago');
});

test('Markdown splitting keeps comment threads together', () => {
  const formatter = loadBackground().run('CommentsToMd');
  formatter.MAX_WORDS_PER_PART = 50;
  const comments = Array.from({ length: 8 }, (_, i) => ({
    author: `Author-${i}`, text: 'word '.repeat(20), likeCount: i,
    replies: [{ author: `Reply-${i}`, text: 'reply '.repeat(5), likeCount: 0 }]
  }));
  const parts = formatter.format({ title: 'Video', videoId: 'abcdefghijk' }, comments);
  assert.ok(parts.length > 1);
  for (let i = 0; i < comments.length; i++) {
    const matching = parts.filter(part => part.text.includes(`**Author-${i}**`));
    assert.equal(matching.length, 1);
    assert.ok(matching[0].text.includes(`**Reply-${i}**`));
  }
});
