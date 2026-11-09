/* Shared message contract for popup, tab manager and content scripts. */
const ExtensionClient = {
  async send(cmd, params = {}, { timeoutMs = 30000, target } = {}) {
    let timer;
    try {
      const request = chrome.runtime.sendMessage({ cmd, params, ...(target ? { target } : {}) });
      const response = timeoutMs > 0 ? await Promise.race([
        request,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Request timed out. Please try again.')), timeoutMs);
        })
      ]) : await request;
      if (response === undefined) throw new Error('No response from the extension. Please reload it and try again.');
      if (response && typeof response === 'object' && !Array.isArray(response)) {
        // A status DTO can legitimately contain error:null or error details.
        // Only the single-field {error:...} envelope rejects the command.
        if (Object.keys(response).length === 1 && Object.prototype.hasOwnProperty.call(response, 'error')) {
          throw new Error(typeof response.error === 'string' ? response.error
            : response.error?.message || JSON.stringify(response.error));
        }
        if (Object.keys(response).length === 1 && Object.prototype.hasOwnProperty.call(response, 'result')) {
          return response.result;
        }
      }
      return response;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
};
