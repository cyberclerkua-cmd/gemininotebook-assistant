/* Render per-URL outcomes without re-selecting acknowledged or uncertain writes. */
const ImportResults = {
  retryable(result) {
    return result.results.filter(item => item.status === 'failed' || item.status === 'pending');
  },

  summary(result, translate) {
    const count = status => result.results.filter(item => item.status === status).length;
    return translate('importBatchSummary', { COUNT: count('added'), FAILED: count('failed'),
      PENDING: count('pending'), UNKNOWN: count('uncertain') });
  },

  render(container, result, translate) {
    container.replaceChildren();
    const unresolved = result.results.filter(item => item.status !== 'added');
    if (!unresolved.length) return;
    if (unresolved.some(item => item.status === 'uncertain')) {
      const hint = document.createElement('p');
      hint.textContent = translate('importUncertainHint');
      container.appendChild(hint);
    }
    const labels = { failed: 'importResultFailed', pending: 'importResultPending', uncertain: 'importResultUncertain' };
    const list = document.createElement('ul');
    for (const item of unresolved) {
      const row = document.createElement('li');
      row.className = 'import-result';
      row.dataset.status = item.status;
      row.textContent = `${translate(labels[item.status])}: ${item.url}`;
      list.appendChild(row);
    }
    container.appendChild(list);
  }
};
