/* Validate backups and migrate the storage keys used by older releases. */
const SettingsBackup = {
  normalize(backup) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!object(backup)) throw new Error('Invalid backup: expected an object');
    for (const area of ['sync', 'local']) {
      if (backup[area] != null && !object(backup[area])) throw new Error(`Invalid backup storage area: ${area}`);
    }
    const sourceSync = backup.sync || {};
    const sourceLocal = backup.local || {};
    const sync = {};
    const local = {};
    function value(target, key, input, validate) {
      if (input === undefined) return;
      if (!validate(input)) throw new Error('Invalid backup value: ' + key);
      target[key] = input;
    }
    const boolean = input => typeof input === 'boolean';
    const id = input => typeof input === 'string' && (input === '' || /^[A-Za-z0-9_-]+$/.test(input));
    const integer = input => Number.isInteger(input) && input >= 0;
    value(sync, 'theme', sourceSync.theme, input => ['light', 'dark'].includes(input));
    value(sync, 'language', sourceSync.language, input => ['en', 'ru'].includes(input));
    for (const key of ['enableBulkDelete', 'enableSyncDrive']) value(sync, key, sourceSync[key], boolean);
    value(sync, 'enableNotifications', sourceSync.enableNotifications ?? sourceSync.settingsNotifications, boolean);
    value(sync, 'activeAccount', sourceSync.activeAccount, integer);
    value(local, 'addDelay', sourceLocal.addDelay ?? sourceSync.addDelay,
      input => Number.isInteger(input) && input >= 500 && input <= 30000);
    const mode = sourceLocal.commentsMode === 'new' ? 'newest' : sourceLocal.commentsMode;
    value(local, 'commentsMode', mode, input => ['top', 'newest'].includes(input));
    value(local, 'commentsLimit', sourceLocal.commentsLimit, input => integer(input) && input <= 99999);
    value(local, 'commentsIncludeReplies', sourceLocal.commentsIncludeReplies ?? sourceLocal.commentsReplies, boolean);
    value(local, 'lastNotebookId', sourceLocal.lastNotebookId, id);
    value(local, 'lastNotebookAuthuser', sourceLocal.lastNotebookAuthuser, integer);
    if (sourceLocal.lastNotebookByAccount !== undefined) {
      if (!object(sourceLocal.lastNotebookByAccount)) throw new Error('Invalid notebook preferences');
      local.lastNotebookByAccount = {};
      for (const [account, notebookId] of Object.entries(sourceLocal.lastNotebookByAccount)) {
        if (!/^\d+$/.test(account) || !id(notebookId)) throw new Error('Invalid notebook preference');
        local.lastNotebookByAccount[account] = notebookId;
      }
    }
    for (const [key, legacy] of [
      ['nlm_ext_toolbar_hidden', 'toolbarHidden'], ['nlm_ext_toolbar_collapsed', 'toolbarCollapsed']
    ]) value(local, key, sourceLocal[key] ?? sourceLocal[legacy], boolean);
    const position = sourceLocal.nlm_ext_toolbar_pos ?? sourceLocal.toolbarPosition;
    if (position !== undefined) {
      if (!object(position)) throw new Error('Invalid toolbar position');
      local.nlm_ext_toolbar_pos = {};
      for (const key of ['left', 'top', 'right', 'bottom']) {
        value(local.nlm_ext_toolbar_pos, key, position[key], input =>
          typeof input === 'string' && /^(?:-?\d+(?:\.\d+)?px|auto)?$/.test(input));
      }
    }
    if (sourceLocal.queue !== undefined) {
      if (!Array.isArray(sourceLocal.queue)) throw new Error('Invalid backup queue');
      local.queue = sourceLocal.queue.map(item => {
        if (!object(item) && typeof item !== 'string') throw new Error('Invalid queue item');
        const url = UrlUtils.httpUrl(typeof item === 'string' ? item : item.url);
        let sourceAttempt;
        if (item.sourceAttempt !== undefined) {
          const attempt = item.sourceAttempt;
          if (!object(attempt) || !attempt.notebookId || !id(attempt.notebookId) || !integer(attempt.authuser) ||
              !Array.isArray(attempt.beforeSourceIds) || !attempt.beforeSourceIds.every(value => value && id(value))) {
            throw new Error('Invalid source attempt in backup');
          }
          sourceAttempt = { notebookId: attempt.notebookId, authuser: attempt.authuser,
            beforeSourceIds: [...attempt.beforeSourceIds] };
        }
        return {
          id: id(item.id) && item.id ? item.id : crypto.randomUUID(), url,
          title: typeof item.title === 'string' ? item.title : '',
          addedAt: Number.isFinite(item.addedAt) ? item.addedAt : Date.now(),
          status: item.status === 'failed' ? 'failed' : 'pending',
          errorCount: integer(item.errorCount) ? item.errorCount : 0,
          ...(typeof item.lastError === 'string' ? { lastError: item.lastError } : {}),
          ...(sourceAttempt ? { sourceAttempt } : {}),
          ...(item.status === 'processing' || item.recovered ? { recovered: true } : {})
        };
      });
      if (new Set(local.queue.map(item => item.id)).size !== local.queue.length) throw new Error('Duplicate queue item IDs in backup');
    }
    if (sourceLocal.history !== undefined) {
      if (!Array.isArray(sourceLocal.history)) throw new Error('Invalid backup history');
      local.history = sourceLocal.history.slice(0, 500).map(entry => {
        if (!object(entry) || typeof entry.action !== 'string') throw new Error('Invalid history entry');
        const record = { action: entry.action, timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now() };
        for (const key of ['url', 'title', 'notebookId', 'sourceId', 'error']) {
          value(record, key, entry[key], input => typeof input === 'string');
        }
        value(record, 'count', entry.count, integer);
        return record;
      });
    }
    return { sync, local };
  }
};
