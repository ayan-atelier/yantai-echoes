// Pure helper logic for 砚台 · 其他可能 (yantai-echoes)

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  enableHistoricalSwipes: true,
  directRerollOnRightArrow: false,
  skipHiddenOnNativeSwipe: true,
  rescueOnRegenerate: true,
});

/**
 * Compute a lightweight deterministic fingerprint for a swipe text so notes/stars/hidden
 * state stay attached even if a user deletes an earlier swipe via native SillyTavern UI.
 * @param {string} text
 * @returns {string}
 */
export function hashSwipeText(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return 'empty';
  let h1 = 0xdeadbeef ^ normalized.length;
  let h2 = 0x41c6ce57 ^ normalized.length;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + '_' + (h1 >>> 0).toString(36) + '_' + normalized.length.toString(36);
}

/**
 * Strip thinking blocks, style/script tags, and HTML markup to produce a clean
 * human-readable preview and character count for the overview drawer.
 * @param {string} rawText
 * @returns {{ cleanText: string, preview: string, charCount: number }}
 */
export function extractCleanPreview(rawText) {
  let text = String(rawText ?? '');
  if (!text.trim()) {
    return { cleanText: '', preview: '（空白内容）', charCount: 0 };
  }

  // Remove common reasoning / thinking / CoT wrappers and style/script blocks
  const withoutThinking = text
    .replace(/<(thinking|think|cot|thought|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Try removing <details> blocks (often used for status bars / folded thoughts),
  // but fall back if the entire message was inside <details>.
  const withoutDetails = withoutThinking.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '');
  const candidate = withoutDetails.replace(/<[^>]+>/g, '').trim() ? withoutDetails : withoutThinking;

  const plain = candidate
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const compact = plain.replace(/\s+/g, ' ').trim();
  const charCount = plain.replace(/\s+/g, '').length;
  const preview = compact
    ? (compact.length > 180 ? compact.slice(0, 180) + '…' : compact)
    : '（仅包含折叠代码块或特殊标签）';

  return {
    cleanText: plain || text.trim(),
    preview,
    charCount,
  };
}

/**
 * Ensure a message has valid swipe structures for reading.
 * @param {object} message
 * @returns {string[]}
 */
export function getMessageSwipes(message) {
  if (!message || typeof message !== 'object') return [];
  if (Array.isArray(message.swipes) && message.swipes.length > 0) {
    return message.swipes;
  }
  if (typeof message.mes === 'string' && message.mes.length > 0) {
    return [message.mes];
  }
  return [];
}

/**
 * Read metadata (starred, note, hidden) for a specific swipe on a message.
 * Checks index-bound `swipe_info[swipeId].extra.yantaiEchoes` first, then falls back
 * to content-fingerprint map `message.extra.yantai_echoes_map[hash]`.
 * @param {object} message
 * @param {number} swipeId
 * @returns {{ starred: boolean, note: string, hidden: boolean, updatedAt: number }}
 */
export function getSwipeMeta(message, swipeId) {
  const empty = { starred: false, note: '', hidden: false, updatedAt: 0 };
  if (!message || typeof message !== 'object') return empty;
  const swipes = getMessageSwipes(message);
  if (swipeId < 0 || swipeId >= swipes.length) return empty;

  const byIndex = message.swipe_info?.[swipeId]?.extra?.yantaiEchoes;
  const hash = hashSwipeText(swipes[swipeId]);
  const byHash = message.extra?.yantai_echoes_map?.[hash];

  const source = (byIndex && typeof byIndex === 'object')
    ? byIndex
    : (byHash && typeof byHash === 'object' ? byHash : null);

  if (!source) return empty;
  return {
    starred: Boolean(source.starred),
    note: String(source.note ?? '').trim(),
    hidden: Boolean(source.hidden),
    updatedAt: Number(source.updatedAt || 0),
  };
}

/**
 * Write metadata (starred, note, hidden) for a specific swipe on a message.
 * Synchronizes both `swipe_info[swipeId].extra.yantaiEchoes` and `message.extra.yantai_echoes_map[hash]`.
 * @param {object} message
 * @param {number} swipeId
 * @param {Partial<{ starred: boolean, note: string, hidden: boolean }>} patch
 * @returns {{ starred: boolean, note: string, hidden: boolean, updatedAt: number }}
 */
export function setSwipeMeta(message, swipeId, patch = {}) {
  const swipes = getMessageSwipes(message);
  if (!message || swipeId < 0 || swipeId >= swipes.length) {
    return { starred: false, note: '', hidden: false, updatedAt: 0 };
  }

  const current = getSwipeMeta(message, swipeId);
  const next = {
    starred: patch.starred !== undefined ? Boolean(patch.starred) : current.starred,
    note: patch.note !== undefined ? String(patch.note ?? '').trim() : current.note,
    hidden: patch.hidden !== undefined ? Boolean(patch.hidden) : current.hidden,
    updatedAt: Date.now(),
  };

  if (!Array.isArray(message.swipe_info)) {
    message.swipe_info = [];
  }
  for (let i = 0; i <= swipeId; i++) {
    if (!message.swipe_info[i] || typeof message.swipe_info[i] !== 'object') {
      message.swipe_info[i] = {};
    }
  }
  if (!message.swipe_info[swipeId].extra || typeof message.swipe_info[swipeId].extra !== 'object') {
    message.swipe_info[swipeId].extra = {};
  }
  message.swipe_info[swipeId].extra.yantaiEchoes = { ...next };

  if (!message.extra || typeof message.extra !== 'object') {
    message.extra = {};
  }
  if (!message.extra.yantai_echoes_map || typeof message.extra.yantai_echoes_map !== 'object') {
    message.extra.yantai_echoes_map = {};
  }
  const hash = hashSwipeText(swipes[swipeId]);
  if (!next.starred && !next.note && !next.hidden) {
    delete message.extra.yantai_echoes_map[hash];
    delete message.swipe_info[swipeId].extra.yantaiEchoes;
  } else {
    message.extra.yantai_echoes_map[hash] = { ...next };
  }

  return next;
}

/**
 * Summarize all swipes on a message for counter and drawer display.
 * @param {object} message
 */
export function summarizeMessageEchoes(message) {
  const swipes = getMessageSwipes(message);
  const total = swipes.length;
  const canonicalSwipeId = total > 0
    ? Math.max(0, Math.min(total - 1, Number(message?.swipe_id ?? 0) || 0))
    : 0;

  let starredCount = 0;
  let notedCount = 0;
  let hiddenCount = 0;
  const visibleIndices = [];

  const items = swipes.map((text, index) => {
    const meta = getSwipeMeta(message, index);
    if (meta.starred) starredCount++;
    if (meta.note) notedCount++;
    if (meta.hidden) {
      hiddenCount++;
    } else {
      visibleIndices.push(index);
    }
    return {
      index,
      number: index + 1,
      isCanonical: index === canonicalSwipeId,
      text: String(text ?? ''),
      meta,
      sendDate: message?.swipe_info?.[index]?.send_date || '',
      reasoning: message?.swipe_info?.[index]?.extra?.reasoning || '',
    };
  });

  return {
    total,
    canonicalSwipeId,
    starredCount,
    notedCount,
    hiddenCount,
    visibleCount: visibleIndices.length,
    visibleIndices,
    items,
  };
}

/**
 * Find the next or previous visible swipe index when flipping through "其他可能".
 * Always keeps at least one swipe reachable even if the user hid everything.
 * @param {object} message
 * @param {number} currentSwipeId
 * @param {number} step -1 for previous, +1 for next
 * @param {{ wrap?: boolean }} [options]
 * @returns {number}
 */
export function findAdjacentVisibleSwipeId(message, currentSwipeId, step = 1, { wrap = true } = {}) {
  const summary = summarizeMessageEchoes(message);
  if (summary.total <= 1) return 0;

  const pool = summary.visibleIndices.length > 0
    ? summary.visibleIndices
    : summary.items.map(item => item.index);

  const pos = pool.indexOf(currentSwipeId);
  if (pos !== -1) {
    const nextPos = pos + (step >= 0 ? 1 : -1);
    if (nextPos >= 0 && nextPos < pool.length) {
      return pool[nextPos];
    }
    return wrap ? pool[(nextPos + pool.length) % pool.length] : currentSwipeId;
  }

  // If currentSwipeId was just hidden, pick the closest visible swipe in the requested direction
  if (step >= 0) {
    const after = pool.find(idx => idx > currentSwipeId);
    if (after !== undefined) return after;
    return wrap ? pool[0] : (pool[pool.length - 1] ?? 0);
  } else {
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i] < currentSwipeId) return pool[i];
    }
    return wrap ? pool[pool.length - 1] : (pool[0] ?? 0);
  }
}

/**
 * Merge rescued swipes (from before a "Regenerate" action wiped the last message)
 * into the newly regenerated message so no rolls are lost.
 * @param {object} newMessage
 * @param {{ swipes: string[], swipe_info?: object[], echoesMap?: Record<string, object> }} snapshot
 * @returns {boolean} Whether any swipes were merged
 */
export function mergeRescuedSwipesOnRegenerate(newMessage, snapshot) {
  if (!newMessage || typeof newMessage !== 'object' || !snapshot || !Array.isArray(snapshot.swipes) || !snapshot.swipes.length) {
    return false;
  }

  const currentSwipes = getMessageSwipes(newMessage);
  const newText = currentSwipes[currentSwipes.length - 1] ?? newMessage.mes ?? '';
  const newInfo = Array.isArray(newMessage.swipe_info) && newMessage.swipe_info.length
    ? newMessage.swipe_info[newMessage.swipe_info.length - 1]
    : { send_date: newMessage.send_date, gen_started: newMessage.gen_started, gen_finished: newMessage.gen_finished, extra: structuredClone(newMessage.extra || {}) };

  const preservedSwipes = [...snapshot.swipes];
  const preservedInfo = Array.from({ length: preservedSwipes.length }, (_, idx) => {
    const existing = snapshot.swipe_info?.[idx];
    return existing && typeof existing === 'object' ? structuredClone(existing) : {};
  });

  preservedSwipes.push(newText);
  preservedInfo.push(newInfo && typeof newInfo === 'object' ? structuredClone(newInfo) : {});

  newMessage.swipes = preservedSwipes;
  newMessage.swipe_info = preservedInfo;
  newMessage.swipe_id = preservedSwipes.length - 1;
  newMessage.mes = newText;

  if (snapshot.echoesMap && typeof snapshot.echoesMap === 'object') {
    if (!newMessage.extra || typeof newMessage.extra !== 'object') {
      newMessage.extra = {};
    }
    newMessage.extra.yantai_echoes_map = {
      ...snapshot.echoesMap,
      ...(newMessage.extra.yantai_echoes_map || {}),
    };
  }

  return true;
}
