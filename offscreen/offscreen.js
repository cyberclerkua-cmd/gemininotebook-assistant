chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.target !== 'offscreen' || request.cmd !== 'parse-xml') return false;
  try {
    sendResponse({ result: FeedParser.parse(request.params.xml, request.params.url) });
  } catch (error) {
    sendResponse({ error: error.message });
  }
  return false;
});
