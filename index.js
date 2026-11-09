import {
  DEFAULT_SETTINGS,
  extractCleanPreview,
  findAdjacentVisibleSwipeId,
  getMessageSwipes,
  getSwipeMeta,
  mergeRescuedSwipesOnRegenerate,
  setSwipeMeta,
  summarizeMessageEchoes,
} from './core.js';

const EXTENSION_KEY = 'yantai_echoes';
const MODAL_ID = 'yte-overview-modal';

/**
 * In-memory state per messageId:
 * mesId (number) -> {
 *   expanded: boolean,          // Whether the inline action bar is currently open on this floor
 *   previewSwipeId: number,     // Currently displayed swipe index on this floor
 *   editingNote: boolean,       // Whether inline note input is open on this floor
 *   originalHtml: string | null,
 *   originalReasoningHtml: string | null,
 *   originalReasoningHasContent: string | null,
 *   originalReasoningOpen: boolean,
 * }
 */
const previewMap = new Map();

/**
 * Snapshot taken right before SillyTavern's "Regenerate" deletes the last message,
 * so we can rescue all previous swipes into the newly generated message.
 */
let pendingRegenerateRescue = null;

/**
 * Track last observed swipe_id on the latest message so we know swipe direction
 * when skipping hidden swipes during native `< / >` swiping.
 */
let lastObservedLatestSwipe = { mesId: -1, swipeId: -1 };
let isAutoSkippingHiddenSwipe = false;
let isInternalRenderEmit = false;
let rollingMesId = -1;

function getCtx() {
  return globalThis.SillyTavern?.getContext?.() || null;
}

function getSettings() {
  const ctx = getCtx();
  const root = ctx?.extensionSettings;
  if (!root) return { ...DEFAULT_SETTINGS };
  if (!root[EXTENSION_KEY] || typeof root[EXTENSION_KEY] !== 'object') {
    root[EXTENSION_KEY] = { ...DEFAULT_SETTINGS, ...(root[EXTENSION_KEY] || {}) };
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (root[EXTENSION_KEY][k] === undefined) {
      root[EXTENSION_KEY][k] = v;
    }
  }
  return root[EXTENSION_KEY];
}

function saveSettings() {
  const ctx = getCtx();
  ctx?.saveSettingsDebounced?.();
}

async function persistChatNow() {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    await ctx.saveChat?.();
    ctx.saveMetadataDebounced?.();
  } catch (err) {
    console.warn('[重Roll助手] 保存聊天数据失败:', err);
  }
}

function persistChatQuietly() {
  void persistChatNow();
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function notify(message, type = 'info') {
  if (globalThis.toastr && typeof globalThis.toastr[type] === 'function') {
    globalThis.toastr[type](message, '重Roll助手', { timeOut: 2600 });
  }
}

function formatSwipeTextToHtml(mesId, message, rawText, isReasoning = false) {
  const ctx = getCtx();
  if (typeof ctx?.messageFormatting === 'function') {
    try {
      return ctx.messageFormatting(
        String(rawText ?? ''),
        message?.name || '',
        Boolean(message?.is_system),
        Boolean(message?.is_user),
        Number(mesId),
        {},
        Boolean(isReasoning),
      );
    } catch (err) {
      console.warn('[重Roll助手] messageFormatting 渲染回退:', err);
    }
  }
  return esc(rawText).replace(/\r?\n/g, '<br>');
}

/**
 * Notify SillyTavern and third-party frontend renderers (such as JS-Slash-Runner / 酒馆助手)
 * that `.mes_text` on `mesId` has been updated, so regex/frontend `<iframe>` blocks and
 * code-block folding run immediately without needing a page refresh.
 * @param {number} mesId
 */
function notifyMessageDomUpdated(mesId) {
  const ctx = getCtx();
  const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
  if (!ctx || !mesEl) return;

  try {
    if (typeof ctx.addCopyToCodeBlocks === 'function') {
      ctx.addCopyToCodeBlocks(globalThis.$ ? globalThis.$(mesEl) : mesEl);
    }
  } catch (_) {
    // ignore
  }

  const eventSource = ctx.eventSource;
  const eventTypes = ctx.eventTypes || ctx.event_types;
  const message = ctx.chat?.[mesId];
  const renderEvent = message?.is_user
    ? eventTypes?.USER_MESSAGE_RENDERED
    : eventTypes?.CHARACTER_MESSAGE_RENDERED;

  if (eventSource && typeof eventSource.emit === 'function' && renderEvent) {
    isInternalRenderEmit = true;
    try {
      void Promise.resolve(eventSource.emit(renderEvent, Number(mesId), EXTENSION_KEY)).finally(() => {
        isInternalRenderEmit = false;
      });
    } catch (err) {
      isInternalRenderEmit = false;
      console.warn('[重Roll助手] 触发消息渲染事件异常:', err);
    }
  }
}

function ensureFloorState(mesId, message) {
  const summary = summarizeMessageEchoes(message);
  let state = previewMap.get(mesId);
  if (!state) {
    state = {
      expanded: false,
      previewSwipeId: summary.canonicalSwipeId,
      editingNote: false,
      originalHtml: null,
      originalReasoningHtml: null,
      originalReasoningHasContent: null,
      originalReasoningOpen: false,
    };
    previewMap.set(mesId, state);
  }
  return state;
}

/**
 * Restore a single message's DOM back to its canonical swipe without touching chat data.
 * @param {number} mesId
 * @param {{ keepExpanded?: boolean }} [options]
 */
function restoreMessageToCanonicalDom(mesId, { keepExpanded = false } = {}) {
  const state = previewMap.get(mesId);
  const ctx = getCtx();
  const message = ctx?.chat?.[mesId];
  const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
  const wasPreviewing = Boolean(
    mesEl?.hasAttribute('data-yte-previewing') ||
    (state && state.originalHtml !== null),
  );

  if (mesEl && message && wasPreviewing) {
    const swipes = getMessageSwipes(message);
    const canonicalSwipeId = Math.max(0, Math.min(swipes.length - 1, Number(message.swipe_id ?? 0) || 0));
    const textEl = mesEl.querySelector('.mes_text');
    if (textEl) {
      if (swipes[canonicalSwipeId] !== undefined) {
        textEl.innerHTML = formatSwipeTextToHtml(mesId, message, swipes[canonicalSwipeId], false);
      } else if (state?.originalHtml != null) {
        textEl.innerHTML = state.originalHtml;
      }
    }

    const detailsEl = mesEl.querySelector('details.mes_reasoning_details');
    const reasoningEl = mesEl.querySelector('.mes_reasoning');
    if (detailsEl && reasoningEl && state?.originalReasoningHtml != null) {
      reasoningEl.innerHTML = state.originalReasoningHtml;
      if (state.originalReasoningHasContent != null) {
        detailsEl.setAttribute('data-has-content', state.originalReasoningHasContent);
      } else {
        detailsEl.removeAttribute('data-has-content');
      }
      detailsEl.open = Boolean(state.originalReasoningOpen);
    }

    mesEl.removeAttribute('data-yte-previewing');
  } else if (mesEl) {
    mesEl.removeAttribute('data-yte-previewing');
  }

  if (!keepExpanded) {
    previewMap.delete(mesId);
  } else if (state && message) {
    const swipes = getMessageSwipes(message);
    const canonicalSwipeId = Math.max(0, Math.min(swipes.length - 1, Number(message.swipe_id ?? 0) || 0));
    state.previewSwipeId = canonicalSwipeId;
    state.editingNote = false;
    state.originalHtml = null;
    state.originalReasoningHtml = null;
  }

  if (wasPreviewing) {
    notifyMessageDomUpdated(mesId);
  }
}

/**
 * Restore all currently previewed messages back to their canonical plot state.
 * @param {number} [exceptMesId=-1]
 */
function restoreAllPreviews(exceptMesId = -1) {
  for (const mesId of [...previewMap.keys()]) {
    if (mesId === exceptMesId) continue;
    restoreMessageToCanonicalDom(mesId, { keepExpanded: false });
    decorateMessageElement(mesId);
  }
}

/**
 * Render a non-destructive preview of `targetSwipeId` inside historical floor `mesId`
 * and open the floor's inline action bar so the user has all controls right there.
 * Does NOT modify `chat[mesId].mes` or `chat[mesId].swipe_id`.
 * @param {number} mesId
 * @param {number} targetSwipeId
 * @param {{ expandBar?: boolean }} [options]
 */
function applyInPlacePreview(mesId, targetSwipeId, { expandBar = true } = {}) {
  const ctx = getCtx();
  const message = ctx?.chat?.[mesId];
  const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
  if (!message || !mesEl) return;

  const summary = summarizeMessageEchoes(message);
  if (summary.total < 1) return;

  const clampedSwipeId = Math.max(0, Math.min(summary.total - 1, Number(targetSwipeId) || 0));
  const state = ensureFloorState(mesId, message);
  state.expanded = Boolean(expandBar);
  state.editingNote = false;

  if (clampedSwipeId === summary.canonicalSwipeId) {
    restoreMessageToCanonicalDom(mesId, { keepExpanded: Boolean(expandBar) });
    decorateMessageElement(mesId);
    return;
  }

  const textEl = mesEl.querySelector('.mes_text');
  const detailsEl = mesEl.querySelector('details.mes_reasoning_details');
  const reasoningEl = mesEl.querySelector('.mes_reasoning');

  // Snapshot canonical DOM before leaving canonical swipe for the first time
  if (state.originalHtml === null && textEl) {
    state.originalHtml = textEl.innerHTML;
    if (detailsEl && reasoningEl) {
      state.originalReasoningHtml = reasoningEl.innerHTML;
      state.originalReasoningHasContent = detailsEl.getAttribute('data-has-content');
      state.originalReasoningOpen = Boolean(detailsEl.open);
    }
  }

  state.previewSwipeId = clampedSwipeId;

  const targetItem = summary.items[clampedSwipeId];
  if (textEl && targetItem) {
    textEl.innerHTML = formatSwipeTextToHtml(mesId, message, targetItem.text, false);
  }
  if (detailsEl && reasoningEl && targetItem) {
    if (targetItem.reasoning) {
      reasoningEl.innerHTML = formatSwipeTextToHtml(mesId, message, targetItem.reasoning, true);
      detailsEl.setAttribute('data-has-content', 'true');
    } else {
      reasoningEl.innerHTML = '';
      detailsEl.removeAttribute('data-has-content');
      detailsEl.open = false;
    }
  }
  mesEl.setAttribute('data-yte-previewing', 'true');
  decorateMessageElement(mesId);
  notifyMessageDomUpdated(mesId);
}

/**
 * Decorate a single `.mes[mesid]` element:
 * - Default (untouched): 100% invisible native `< 2/3 >` footer!
 * - Active (after clicking `<`, `2/3`, or `>`): shows the sleek inline action bar right above the footer!
 * @param {number} mesId
 */
function isOpeningGreetingFloor(mesId) {
  return Number(mesId) === 0;
}

function decorateMessageElement(mesId) {
  const settings = getSettings();
  const ctx = getCtx();
  const chat = ctx?.chat;
  const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
  if (!mesEl) return;

  mesEl.querySelector('.yte-header-pill')?.remove();
  const existingDock = mesEl.querySelector('.yte-dock');

  if (!settings.enabled || !Array.isArray(chat) || !chat[mesId]) {
    existingDock?.remove();
    mesEl.removeAttribute('data-yte-historical');
    mesEl.removeAttribute('data-yte-multi');
    mesEl.removeAttribute('data-yte-can-left');
    mesEl.removeAttribute('data-yte-previewing');
    return;
  }

  const message = chat[mesId];
  if (isOpeningGreetingFloor(mesId) || message.is_user || message.is_system || message.extra?.isSmallSys || message.extra?.swipeable === false) {
    existingDock?.remove();
    mesEl.removeAttribute('data-yte-historical');
    mesEl.removeAttribute('data-yte-multi');
    mesEl.removeAttribute('data-yte-can-left');
    mesEl.removeAttribute('data-yte-previewing');
    return;
  }

  const summary = summarizeMessageEchoes(message);
  const isLatestMessage = mesId === chat.length - 1;
  const state = previewMap.get(mesId);
  const activeSwipeId = (!isLatestMessage && state) ? state.previewSwipeId : summary.canonicalSwipeId;
  const isPreviewingOther = !isLatestMessage && activeSwipeId !== summary.canonicalSwipeId;
  const activeMeta = getSwipeMeta(message, activeSwipeId);
  const isRollingThisFloor = rollingMesId === mesId;

  const counterEl = mesEl.querySelector('.swipes-counter');
  const leftEl = mesEl.querySelector('.swipe_left');
  const rightEl = mesEl.querySelector('.swipe_right');

  const visiblePool = summary.visibleIndices.length > 0
    ? summary.visibleIndices
    : summary.items.map(i => i.index);
  const posInPool = visiblePool.indexOf(activeSwipeId);
  const canSwipeLeft = summary.total > 1 && (posInPool > 0 || (posInPool === -1 && activeSwipeId > (visiblePool[0] ?? 0)));
  const isAtLastSwipe = posInPool === -1
    ? activeSwipeId >= (visiblePool[visiblePool.length - 1] ?? summary.total - 1)
    : posInPool >= visiblePool.length - 1;

  if (!isLatestMessage && settings.enableHistoricalSwipes) {
    mesEl.setAttribute('data-yte-historical', 'true');
    mesEl.setAttribute('data-yte-multi', summary.total > 1 ? 'true' : 'false');
    mesEl.setAttribute('data-yte-can-left', canSwipeLeft ? 'true' : 'false');
  } else {
    mesEl.removeAttribute('data-yte-historical');
    mesEl.removeAttribute('data-yte-multi');
    mesEl.removeAttribute('data-yte-can-left');
  }

  if (counterEl) {
    counterEl.hidden = false;
    counterEl.classList.add('swipe-picker-enabled', 'interactable');
    counterEl.setAttribute('role', 'button');

    if (isRollingThisFloor) {
      counterEl.textContent = '…';
    } else {
      const starMark = activeMeta.starred ? '★' : '';
      const previewMark = isPreviewingOther ? '*' : '';
      counterEl.textContent = `${starMark}${activeSwipeId + 1}/${summary.total}${previewMark}`;
    }

    const noteHint = activeMeta.note ? ` · 备注：${activeMeta.note}` : '';
    const previewHint = isPreviewingOther ? `（正在回看 #${activeSwipeId + 1}，AI 仍读原路线 #${summary.canonicalSwipeId + 1}）` : '';
    counterEl.title = `点击展开/收起本楼「重Roll助手」工具栏${previewHint}${noteHint}`;
  }

  if (!isLatestMessage && leftEl) {
    leftEl.title = canSwipeLeft ? '查看上一条重 roll（不影响当前主线进度）' : '';
  }
  if (!isLatestMessage && rightEl) {
    rightEl.title = isAtLastSwipe
      ? '已到最后一页，点击展开「重Roll助手」工具栏（可重 roll 或管理分支）'
      : '查看下一条重 roll（不影响当前主线进度）';
  }

  // Only render the inline action dock when the user has actively clicked `<`, `2/3`, or `>` on this floor
  // (or when currently previewing a non-canonical swipe / rolling on this floor)!
  const shouldShowDock = Boolean(state?.expanded || isPreviewingOther || isRollingThisFloor);
  if (!shouldShowDock) {
    existingDock?.remove();
    return;
  }

  const host = mesEl.querySelector('.mes_bias') || mesEl.querySelector('.mes_block');
  if (!host) return;

  let dock = existingDock;
  if (!dock) {
    dock = document.createElement('div');
    dock.className = 'yte-dock';
    host.appendChild(dock);
  }
  dock.dataset.mesid = String(mesId);

  const statusHtml = isPreviewingOther
    ? `<span class="yte-status is-preview">当前 <b>#${activeSwipeId + 1}/${summary.total}</b> <small>（仅预览）</small></span>`
    : `<span class="yte-status">当前 <b>#${activeSwipeId + 1}/${summary.total}</b>${summary.hiddenCount ? ` <small>（已藏 ${summary.hiddenCount}）</small>` : ''}</span>`;

  const noteBadgeHtml = activeMeta.note && !state?.editingNote
    ? `<button type="button" class="yte-note-tag" data-action="edit-note" data-mesid="${mesId}" data-swipeid="${activeSwipeId}" title="点击修改备注"><i class="fa-solid fa-tag"></i> ${esc(activeMeta.note)}</button>`
    : '';

  const noteEditorHtml = state?.editingNote
    ? `<div class="yte-note-inline">
         <input type="text" class="yte-note-input" data-mesid="${mesId}" data-swipeid="${activeSwipeId}" value="${esc(activeMeta.note)}" placeholder="给 #${activeSwipeId + 1} 加备注（如：超甜/修罗场/备选路线B）…" maxlength="80">
         <button type="button" class="yte-btn yte-btn-primary" data-action="save-note" data-mesid="${mesId}" data-swipeid="${activeSwipeId}">保存</button>
         <button type="button" class="yte-btn" data-action="cancel-note" data-mesid="${mesId}">取消</button>
       </div>`
    : '';

  dock.innerHTML = `
    <div class="yte-bar ${isPreviewingOther ? 'is-previewing' : ''}">
      <div class="yte-bar-top">
        <div class="yte-bar-info">
          ${statusHtml}
          ${noteBadgeHtml}
        </div>
        <button type="button" class="yte-close-bar" data-action="collapse-bar" data-mesid="${mesId}" title="${isPreviewingOther ? `恢复显示原路 #${summary.canonicalSwipeId + 1} 并收起` : '收起工具栏'}">
          ${isPreviewingOther ? `<i class="fa-solid fa-rotate-left"></i> 回到原路 #${summary.canonicalSwipeId + 1}` : `<i class="fa-solid fa-xmark"></i> 收起`}
        </button>
      </div>
      <div class="yte-bar-mid">
        <button type="button" class="yte-btn" data-action="open-modal" data-mesid="${mesId}" title="查看本楼全部 ${summary.total} 条可能、搜索或恢复隐藏条目">
          <i class="fa-solid fa-layer-group"></i> 全部 (${summary.total})
        </button>
        ${!isLatestMessage ? `
          <button type="button" class="yte-btn yte-btn-primary" data-action="branch-from-current" data-mesid="${mesId}" data-swipeid="${activeSwipeId}" title="保留原路线存档，并以当前 #${activeSwipeId + 1} 为起点开启新分支继续玩">
            <i class="fa-solid fa-code-branch"></i> 保存并开启新分支
          </button>
        ` : ''}
      </div>
      <div class="yte-bar-bottom">
        <button type="button" class="yte-btn ${activeMeta.starred ? 'is-starred' : ''}" data-action="toggle-star" data-mesid="${mesId}" data-swipeid="${activeSwipeId}" title="${activeMeta.starred ? '取消收藏' : '标星收藏'}">
          <i class="fa-${activeMeta.starred ? 'solid' : 'regular'} fa-star"></i> 收藏
        </button>
        <button type="button" class="yte-btn" data-action="edit-note" data-mesid="${mesId}" data-swipeid="${activeSwipeId}" title="添加或修改备注">
          <i class="fa-regular fa-pen-to-square"></i> 备注
        </button>
        <button type="button" class="yte-btn" data-action="soft-hide-current" data-mesid="${mesId}" data-swipeid="${activeSwipeId}" title="隐藏本条（假删除，翻页自动跳过，可在「全部 -> 已隐藏」恢复）">
          <i class="fa-regular ${activeMeta.hidden ? 'fa-eye' : 'fa-eye-slash'}"></i> ${activeMeta.hidden ? '恢复显示' : '隐藏本条'}
        </button>
        <button type="button" class="yte-btn yte-btn-primary" data-action="reroll-floor" data-mesid="${mesId}" ${isRollingThisFloor ? 'disabled' : ''} title="在本楼重 roll 一条新可能">
          <i class="fa-solid ${isRollingThisFloor ? 'fa-spinner fa-spin' : 'fa-dice'}"></i> ${isRollingThisFloor ? '生成中…' : '重 roll'}
        </button>
      </div>
      ${noteEditorHtml}
    </div>
  `;
}

function decorateAllMessages() {
  const settings = getSettings();
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('swipeAllMessages', Boolean(settings.enabled && settings.enableHistoricalSwipes));
    document.body.classList.toggle('yte-enabled', Boolean(settings.enabled));
  }
  const mesElements = document.querySelectorAll('#chat .mes[mesid]');
  mesElements.forEach(el => {
    const mesId = Number(el.getAttribute('mesid'));
    if (Number.isInteger(mesId) && mesId >= 0) {
      decorateMessageElement(mesId);
    }
  });
}

// ============================================================================
// Historical Floor Re-rolling ("过去的楼层看爽了还想重 roll")
// ============================================================================
async function rollHistoricalMessage(mesId) {
  const ctx = getCtx();
  const chat = ctx?.chat;
  if (!ctx || !Array.isArray(chat) || !chat[mesId]) return;

  if (mesId === chat.length - 1) {
    if (typeof ctx.swipe?.right === 'function') {
      await ctx.swipe.right();
    } else {
      document.querySelector('#chat .mes.last_mes .swipe_right')?.click();
    }
    return;
  }

  if (rollingMesId !== -1) {
    notify('正在生成另一条可能，请稍候…', 'warning');
    return;
  }

  const message = chat[mesId];
  if (message.is_user || message.is_system) return;

  // Restore any previews on earlier floors so prompt context up to mesId - 1 is canonical
  restoreAllPreviews(mesId);

  rollingMesId = mesId;
  const state = ensureFloorState(mesId, message);
  state.expanded = true;

  const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
  mesEl?.setAttribute('data-yte-rolling', 'true');
  decorateMessageElement(mesId);
  if (modalState.open && modalState.mesId === mesId) {
    renderOverviewModal();
  }

  const genStartedIso = new Date().toISOString();
  try {
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.eventTypes || ctx.event_types;
    let capturedData = null;
    const onAfterData = (data) => {
      capturedData = data;
    };

    const tailMessages = chat.splice(mesId + 1);
    const origSaveChat = ctx.saveChat;
    if (typeof origSaveChat === 'function') {
      ctx.saveChat = async () => {};
    }
    eventSource?.on?.(eventTypes.GENERATE_AFTER_DATA, onAfterData);
    try {
      await ctx.generate('swipe', {}, true);
    } finally {
      eventSource?.removeListener?.(eventTypes.GENERATE_AFTER_DATA, onAfterData);
      chat.push(...tailMessages);
      if (typeof origSaveChat === 'function') {
        ctx.saveChat = origSaveChat;
      }
    }

    if (!capturedData) {
      throw new Error('未能组装该楼层的上下文提示词');
    }

    const responseOrStream = await ctx.sendGenerationRequest('swipe', capturedData);
    let finalText = '';
    let finalReasoning = '';

    if (typeof responseOrStream === 'function') {
      for await (const chunk of responseOrStream()) {
        if (typeof chunk?.text === 'string') {
          finalText = chunk.text;
          finalReasoning = chunk?.state?.reasoning || finalReasoning;
          const textEl = mesEl?.querySelector('.mes_text');
          if (textEl) {
            if (state.originalHtml === null) {
              state.originalHtml = textEl.innerHTML;
              state.originalReasoningHtml = mesEl?.querySelector('.mes_reasoning')?.innerHTML ?? null;
              state.originalReasoningHasContent = mesEl?.querySelector('details.mes_reasoning_details')?.getAttribute('data-has-content') ?? null;
              state.originalReasoningOpen = Boolean(mesEl?.querySelector('details.mes_reasoning_details')?.open);
            }
            mesEl?.setAttribute('data-yte-previewing', 'true');
            textEl.innerHTML = formatSwipeTextToHtml(mesId, message, finalText, false);
          }
        }
      }
    } else if (responseOrStream && typeof responseOrStream === 'object') {
      const scriptMod = await import('../../../../script.js').catch(() => null);
      const reasoningMod = await import('../../../reasoning.js').catch(() => null);
      if (typeof scriptMod?.extractMessageFromData === 'function') {
        finalText = scriptMod.extractMessageFromData(responseOrStream);
      } else if (typeof ctx.extractMessageFromData === 'function') {
        finalText = ctx.extractMessageFromData(responseOrStream);
      } else {
        finalText = responseOrStream?.choices?.[0]?.message?.content
          || responseOrStream?.choices?.[0]?.text
          || responseOrStream?.results?.[0]?.text
          || '';
      }
      if (typeof reasoningMod?.extractReasoningFromData === 'function') {
        finalReasoning = reasoningMod.extractReasoningFromData(responseOrStream) || '';
      }
    }

    const scriptMod = await import('../../../../script.js').catch(() => null);
    if (typeof scriptMod?.cleanUpMessage === 'function') {
      finalText = scriptMod.cleanUpMessage({
        getMessage: finalText,
        isImpersonate: false,
        isContinue: false,
        displayIncompleteSentences: false,
      });
    }

    const reasoningMod = await import('../../../reasoning.js').catch(() => null);
    if (!finalReasoning && typeof reasoningMod?.parseReasoningFromString === 'function') {
      const parsed = reasoningMod.parseReasoningFromString(finalText);
      if (parsed && parsed.reasoning) {
        finalReasoning = parsed.reasoning;
        finalText = parsed.content;
      }
    }

    finalText = String(finalText ?? '').trim();
    if (!finalText) {
      throw new Error('未收到有效生成内容');
    }

    if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
      message.swipes = [String(message.mes ?? '')];
    }
    if (!Array.isArray(message.swipe_info)) {
      message.swipe_info = message.swipes.map(() => ({}));
    }
    while (message.swipe_info.length < message.swipes.length) {
      message.swipe_info.push({});
    }

    const genFinishedIso = new Date().toISOString();
    message.swipes.push(finalText);
    message.swipe_info.push({
      send_date: genFinishedIso,
      gen_started: genStartedIso,
      gen_finished: genFinishedIso,
      extra: {
        api: ctx.mainApi || '',
        reasoning: finalReasoning || '',
      },
    });

    const newSwipeId = message.swipes.length - 1;
    await persistChatNow();

    applyInPlacePreview(mesId, newSwipeId, { expandBar: true });
    notify(`已在第 #${mesId} 楼重 roll 出第 #${newSwipeId + 1} 条（仅预览，原路线与后续楼层均未改动）`, 'success');
  } catch (err) {
    console.error('[重Roll助手] 历史楼层重 roll 失败:', err);
    notify(`重 roll 失败：${err?.message || String(err)}`, 'error');
  } finally {
    rollingMesId = -1;
    mesEl?.removeAttribute('data-yte-rolling');
    decorateMessageElement(mesId);
    if (modalState.open && modalState.mesId === mesId) {
      renderOverviewModal();
    }
  }
}

/**
 * Save the current chat (Route A, with all its later floors and canonical swipe intact),
 * then create and open a new branch chat starting from `mesId` with `targetSwipeId` (Route B)!
 * @param {number} mesId
 * @param {number} targetSwipeId
 */
async function saveRouteAAndBranchRouteB(mesId, targetSwipeId) {
  const ctx = getCtx();
  const chat = ctx?.chat;
  const message = chat?.[mesId];
  if (!ctx || !message) return;

  const swipes = getMessageSwipes(message);
  if (targetSwipeId < 0 || targetSwipeId >= swipes.length) return;

  if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
    message.swipes = [...swipes];
    message.swipe_id = Number(message.swipe_id ?? 0) || 0;
  }
  if (!Array.isArray(message.swipe_info)) {
    message.swipe_info = message.swipes.map(() => ({}));
  }
  while (message.swipe_info.length < message.swipes.length) {
    message.swipe_info.push({});
  }

  restoreAllPreviews();
  await persistChatNow();

  try {
    const bookmarksMod = await import('../../../bookmarks.js');
    if (typeof bookmarksMod.createBranch === 'function') {
      const branchFileName = await bookmarksMod.createBranch(mesId, { swipeId: targetSwipeId });
      if (!branchFileName) return;

      await persistChatNow();

      if (ctx.groupId && typeof ctx.openGroupChat === 'function') {
        await ctx.openGroupChat(ctx.groupId, branchFileName);
      } else if (typeof ctx.openCharacterChat === 'function') {
        await ctx.openCharacterChat(branchFileName);
      }
      notify(`已保存原路线，并从第 #${mesId} 楼的第 #${targetSwipeId + 1} 条开启新分支：「${branchFileName}」`, 'success');
      return;
    }
    if (typeof bookmarksMod.branchChat === 'function') {
      const branchFileName = await bookmarksMod.branchChat(mesId, { swipeId: targetSwipeId });
      if (branchFileName) {
        notify(`已保存原路线，并开启新分支：「${branchFileName}」`, 'success');
      }
      return;
    }
  } catch (err) {
    console.error('[重Roll助手] 创建分支存档失败:', err);
    notify(`创建分支失败：${err?.message || String(err)}`, 'error');
  }
}

// ============================================================================
// Overview Modal ("全部列表" 弹窗)
// ============================================================================
const modalState = {
  open: false,
  mesId: -1,
  filter: 'visible', // 'visible' | 'starred' | 'hidden'
  query: '',
  expandedSwipeIds: new Set(),
  editingNoteSwipeId: -1,
  confirmMakeCanonicalSwipeId: -1,
};

function closeOverviewModal() {
  modalState.open = false;
  modalState.editingNoteSwipeId = -1;
  modalState.confirmMakeCanonicalSwipeId = -1;
  const modal = document.getElementById(MODAL_ID);
  if (modal) {
    try {
      if (typeof modal.close === 'function' && modal.open) {
        modal.close();
      }
    } catch (_) {
      // ignore
    }
    modal.remove();
  }
}

function openOverviewModal(mesId) {
  const ctx = getCtx();
  const message = ctx?.chat?.[mesId];
  if (!message) return;

  modalState.open = true;
  modalState.mesId = mesId;
  modalState.filter = 'visible';
  modalState.query = '';
  modalState.expandedSwipeIds = new Set();
  modalState.editingNoteSwipeId = -1;
  modalState.confirmMakeCanonicalSwipeId = -1;

  renderOverviewModal();
}

function renderOverviewModal() {
  if (!modalState.open) return;
  const ctx = getCtx();
  const mesId = modalState.mesId;
  const message = ctx?.chat?.[mesId];
  if (!message) {
    closeOverviewModal();
    return;
  }

  const summary = summarizeMessageEchoes(message);
  const isLatestMessage = mesId === (ctx.chat.length - 1);
  const previewState = previewMap.get(mesId);
  const activeSwipeId = (!isLatestMessage && previewState) ? previewState.previewSwipeId : summary.canonicalSwipeId;
  const isRollingThisFloor = rollingMesId === mesId;

  let modal = document.getElementById(MODAL_ID);
  if (!modal) {
    modal = document.createElement('dialog');
    modal.id = MODAL_ID;
    modal.className = 'yte-modal-dialog';
    modal.addEventListener('click', onModalClick);
    modal.addEventListener('input', onModalInput);
    modal.addEventListener('keydown', onModalKeyDown);
    modal.addEventListener('close', () => {
      modalState.open = false;
      modalState.editingNoteSwipeId = -1;
      modalState.confirmMakeCanonicalSwipeId = -1;
      modal.remove();
    });
    document.body.appendChild(modal);
  }
  if (!modal.open) {
    try {
      modal.showModal?.();
    } catch (_) {
      modal.setAttribute('open', '');
    }
  }

  const q = modalState.query.trim().toLowerCase();
  const filteredItems = summary.items.filter(item => {
    if (modalState.filter === 'visible' && item.meta.hidden) return false;
    if (modalState.filter === 'starred' && !item.meta.starred && !item.meta.note) return false;
    if (modalState.filter === 'hidden' && !item.meta.hidden) return false;
    if (q) {
      const hay = `${item.number} #${item.number} ${item.meta.note} ${item.text}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const starredOrNotedCount = summary.items.filter(i => i.meta.starred || i.meta.note).length;

  const cardsHtml = filteredItems.length
    ? filteredItems.map(item => {
      const { preview, charCount } = extractCleanPreview(item.text);
      const isExpanded = modalState.expandedSwipeIds.has(item.index);
      const isEditingNote = modalState.editingNoteSwipeId === item.index;
      const isConfirmingCanonical = modalState.confirmMakeCanonicalSwipeId === item.index;

      const badges = [
        `<span class="yte-card-num">#${item.number}</span>`,
        item.isCanonical ? `<span class="yte-badge yte-badge-canonical">当前页</span>` : '',
        (!item.isCanonical && item.index === activeSwipeId) ? `<span class="yte-badge yte-badge-preview">仅预览</span>` : '',
        item.meta.starred ? `<span class="yte-badge yte-badge-star"><i class="fa-solid fa-star"></i></span>` : '',
        item.meta.hidden ? `<span class="yte-badge yte-badge-hidden">已隐藏</span>` : '',
        `<span class="yte-card-chars">${charCount} 字</span>`,
      ].filter(Boolean).join('');

      const noteBanner = item.meta.note && !isEditingNote
        ? `<div class="yte-card-note" data-modal-action="start-edit-note" data-swipeid="${item.index}" title="点击修改备注"><i class="fa-solid fa-tag"></i> <span>${esc(item.meta.note)}</span></div>`
        : '';

      const noteInputRow = isEditingNote
        ? `<div class="yte-note-inline yte-card-note-editor">
             <input type="text" class="yte-modal-note-input" data-swipeid="${item.index}" value="${esc(item.meta.note)}" placeholder="给 #${item.number} 加备注（如：超甜/修罗场/备选路线B）…" maxlength="80">
             <button type="button" class="yte-btn yte-btn-primary" data-modal-action="save-note" data-swipeid="${item.index}">保存</button>
             <button type="button" class="yte-btn" data-modal-action="cancel-note">取消</button>
           </div>`
        : '';

      const bodyHtml = isExpanded
        ? `<div class="yte-card-full mes_text">${formatSwipeTextToHtml(mesId, message, item.text, false)}</div>`
        : `<p class="yte-card-excerpt">${esc(preview)}</p>`;

      const confirmRow = isConfirmingCanonical
        ? `<div class="yte-confirm-strip">
             <span>将 <b>#${item.number}</b> 替为本楼当前页？（原 #${summary.canonicalSwipeId + 1} 仍会保留）</span>
             <div class="yte-confirm-btns">
               <button type="button" class="yte-btn yte-btn-primary" data-modal-action="confirm-make-canonical" data-swipeid="${item.index}">确认</button>
               <button type="button" class="yte-btn" data-modal-action="cancel-make-canonical">取消</button>
             </div>
           </div>`
        : '';

      return `
        <article class="yte-card ${item.isCanonical ? 'is-canonical' : ''} ${item.meta.hidden ? 'is-hidden' : ''}" data-swipeid="${item.index}">
          <header class="yte-card-head">
            <div class="yte-card-badges">${badges}</div>
            <div class="yte-card-tools">
              <button type="button" class="yte-btn ${item.meta.starred ? 'is-starred' : ''}" data-modal-action="toggle-star" data-swipeid="${item.index}" title="${item.meta.starred ? '取消收藏' : '收藏'}">
                <i class="fa-${item.meta.starred ? 'solid' : 'regular'} fa-star"></i>
              </button>
              <button type="button" class="yte-btn" data-modal-action="start-edit-note" data-swipeid="${item.index}" title="备注">
                <i class="fa-regular fa-pen-to-square"></i> 备注
              </button>
              <button type="button" class="yte-btn" data-modal-action="toggle-hide" data-swipeid="${item.index}" title="${item.meta.hidden ? '恢复显示' : '隐藏本条'}">
                <i class="fa-regular ${item.meta.hidden ? 'fa-eye' : 'fa-eye-slash'}"></i> ${item.meta.hidden ? '恢复' : '隐藏'}
              </button>
              <button type="button" class="yte-btn" data-modal-action="copy-text" data-swipeid="${item.index}" title="复制全文">
                <i class="fa-regular fa-copy"></i> 复制
              </button>
            </div>
          </header>
          ${noteBanner}
          ${noteInputRow}
          <div class="yte-card-body">${bodyHtml}</div>
          ${confirmRow}
          <footer class="yte-card-foot">
            <button type="button" class="yte-btn" data-modal-action="toggle-expand" data-swipeid="${item.index}">
              <i class="fa-solid fa-chevron-${isExpanded ? 'up' : 'down'}"></i> ${isExpanded ? '收起' : '展开'}
            </button>
            <button type="button" class="yte-btn yte-btn-primary" data-modal-action="preview-in-floor" data-swipeid="${item.index}">
              <i class="fa-regular fa-eye"></i> 查看
            </button>
            ${!isLatestMessage ? `
              <button type="button" class="yte-btn" data-modal-action="branch-from-echo" data-swipeid="${item.index}" title="保留原路线存档，并以 #${item.number} 为起点开启新分支">
                <i class="fa-solid fa-code-branch"></i> 保存并开启新分支
              </button>
            ` : ''}
            ${!isLatestMessage && !item.isCanonical ? `
              <button type="button" class="yte-btn" data-modal-action="ask-make-canonical" data-swipeid="${item.index}" title="将 #${item.number} 替为本楼当前页">
                <i class="fa-solid fa-thumbtack"></i> 替为当前页
              </button>
            ` : ''}
          </footer>
        </article>
      `;
    }).join('')
    : `<div class="yte-empty">
         <i class="fa-regular fa-folder-open"></i>
         <p>${modalState.filter === 'hidden' ? '暂无已隐藏条目' : modalState.filter === 'starred' ? '暂无收藏或备注条目' : '没有匹配的条目'}</p>
       </div>`;

  modal.innerHTML = `
    <section class="yte-modal" aria-label="重Roll助手管理面板">
      <header class="yte-modal-head">
        <h3><i class="fa-solid fa-layer-group"></i> 第 #${mesId} 楼 · 全部 (${summary.total})</h3>
        <div class="yte-modal-head-actions">
          <button type="button" class="yte-btn yte-btn-primary" data-modal-action="reroll-floor" ${isRollingThisFloor ? 'disabled' : ''}>
            <i class="fa-solid ${isRollingThisFloor ? 'fa-spinner fa-spin' : 'fa-dice'}"></i> ${isRollingThisFloor ? '生成中…' : '重 roll'}
          </button>
          <button type="button" class="yte-modal-close" data-modal-action="close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </header>
      <div class="yte-modal-toolbar">
        <div class="yte-filter-tabs" role="tablist">
          <button type="button" class="yte-filter-tab ${modalState.filter === 'visible' ? 'is-active' : ''}" data-modal-action="filter" data-filter="visible">
            全部 (${summary.visibleCount})
          </button>
          <button type="button" class="yte-filter-tab ${modalState.filter === 'starred' ? 'is-active' : ''}" data-modal-action="filter" data-filter="starred">
            ★ 收藏/备注 (${starredOrNotedCount})
          </button>
          <button type="button" class="yte-filter-tab ${modalState.filter === 'hidden' ? 'is-active' : ''}" data-modal-action="filter" data-filter="hidden">
            已隐藏 (${summary.hiddenCount})
          </button>
        </div>
        <input type="search" class="yte-search-input" value="${esc(modalState.query)}" placeholder="搜索内容、序号或备注…">
      </div>
      <div class="yte-modal-list">
        ${cardsHtml}
      </div>
    </section>
  `;
}

/**
 * Switch the canonical swipe on a message (only when explicitly requested by user).
 * @param {number} mesId
 * @param {number} targetSwipeId
 * @param {{ keepExpanded?: boolean }} [options]
 */
async function setCanonicalSwipeOnMessage(mesId, targetSwipeId, { keepExpanded = false } = {}) {
  const ctx = getCtx();
  const message = ctx?.chat?.[mesId];
  if (!message) return;
  const swipes = getMessageSwipes(message);
  if (targetSwipeId < 0 || targetSwipeId >= swipes.length) return;

  const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
  mesEl?.removeAttribute('data-yte-previewing');
  if (!keepExpanded) {
    previewMap.delete(mesId);
  }

  message.swipe_id = targetSwipeId;
  message.mes = swipes[targetSwipeId];
  const info = message.swipe_info?.[targetSwipeId];
  if (info && typeof info === 'object') {
    if (info.send_date) message.send_date = info.send_date;
    if (info.gen_started) message.gen_started = info.gen_started;
    if (info.gen_finished) message.gen_finished = info.gen_finished;
    if (info.extra && typeof info.extra === 'object') {
      const echoesMap = message.extra?.yantai_echoes_map;
      message.extra = structuredClone(info.extra);
      if (echoesMap) message.extra.yantai_echoes_map = echoesMap;
    }
  }

  if (typeof ctx.updateMessageBlock === 'function') {
    ctx.updateMessageBlock(mesId, message, { rerenderMessage: true });
  } else {
    const textEl = mesEl?.querySelector('.mes_text');
    if (textEl) {
      textEl.innerHTML = formatSwipeTextToHtml(mesId, message, message.mes, false);
    }
  }

  if (keepExpanded) {
    const st = ensureFloorState(mesId, message);
    st.expanded = true;
    st.previewSwipeId = targetSwipeId;
    st.editingNote = false;
    st.originalHtml = null;
    st.originalReasoningHtml = null;
  }

  await persistChatNow();
  decorateMessageElement(mesId);
  notifyMessageDomUpdated(mesId);
}

function onModalInput(event) {
  const search = event.target.closest('.yte-search-input');
  if (!search) return;
  modalState.query = search.value || '';
  const cursor = search.selectionStart;
  renderOverviewModal();
  const nextInput = document.querySelector(`#${MODAL_ID} .yte-search-input`);
  if (nextInput) {
    nextInput.focus();
    try { nextInput.setSelectionRange(cursor, cursor); } catch (_) { /* ignore */ }
  }
}

function onModalKeyDown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeOverviewModal();
    return;
  }
  const noteInput = event.target.closest('.yte-modal-note-input');
  if (noteInput && event.key === 'Enter') {
    event.preventDefault();
    const swipeId = Number(noteInput.dataset.swipeid);
    const ctx = getCtx();
    const message = ctx?.chat?.[modalState.mesId];
    if (message && Number.isInteger(swipeId)) {
      setSwipeMeta(message, swipeId, { note: noteInput.value });
      persistChatQuietly();
      modalState.editingNoteSwipeId = -1;
      decorateMessageElement(modalState.mesId);
      renderOverviewModal();
    }
  }
}

async function onModalClick(event) {
  if (event.target.id === MODAL_ID) {
    closeOverviewModal();
    return;
  }
  const btn = event.target.closest('[data-modal-action]');
  if (!btn) return;
  event.preventDefault();
  event.stopPropagation();

  const action = btn.dataset.modalAction;
  const swipeId = Number(btn.dataset.swipeid);
  const mesId = modalState.mesId;
  const ctx = getCtx();
  const message = ctx?.chat?.[mesId];
  if (!message) return;

  if (action === 'close') {
    closeOverviewModal();
    return;
  }
  if (action === 'filter') {
    modalState.filter = btn.dataset.filter || 'visible';
    renderOverviewModal();
    return;
  }
  if (action === 'reroll-floor') {
    await rollHistoricalMessage(mesId);
    return;
  }
  if (action === 'restore-canonical') {
    restoreMessageToCanonicalDom(mesId, { keepExpanded: false });
    decorateMessageElement(mesId);
    renderOverviewModal();
    return;
  }
  if (action === 'toggle-expand') {
    if (modalState.expandedSwipeIds.has(swipeId)) {
      modalState.expandedSwipeIds.delete(swipeId);
    } else {
      modalState.expandedSwipeIds.add(swipeId);
    }
    renderOverviewModal();
    return;
  }
  if (action === 'toggle-star') {
    const current = getSwipeMeta(message, swipeId);
    setSwipeMeta(message, swipeId, { starred: !current.starred });
    persistChatQuietly();
    decorateMessageElement(mesId);
    renderOverviewModal();
    return;
  }
  if (action === 'start-edit-note') {
    modalState.editingNoteSwipeId = modalState.editingNoteSwipeId === swipeId ? -1 : swipeId;
    renderOverviewModal();
    const input = document.querySelector(`#${MODAL_ID} .yte-modal-note-input[data-swipeid="${swipeId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
    return;
  }
  if (action === 'save-note') {
    const input = document.querySelector(`#${MODAL_ID} .yte-modal-note-input[data-swipeid="${swipeId}"]`);
    setSwipeMeta(message, swipeId, { note: input ? input.value : '' });
    persistChatQuietly();
    modalState.editingNoteSwipeId = -1;
    decorateMessageElement(mesId);
    renderOverviewModal();
    return;
  }
  if (action === 'cancel-note') {
    modalState.editingNoteSwipeId = -1;
    renderOverviewModal();
    return;
  }
  if (action === 'toggle-hide') {
    const current = getSwipeMeta(message, swipeId);
    const nextHidden = !current.hidden;
    setSwipeMeta(message, swipeId, { hidden: nextHidden });
    persistChatQuietly();
    decorateMessageElement(mesId);
    renderOverviewModal();
    notify(nextHidden ? `已隐藏第 #${swipeId + 1} 条可能（可在「已隐藏」标签随时恢复）` : `已恢复显示第 #${swipeId + 1} 条可能`);
    return;
  }
  if (action === 'soft-hide-active') {
    const current = getSwipeMeta(message, swipeId);
    const isLatestMessage = mesId === (ctx.chat.length - 1);
    if (current.hidden) {
      setSwipeMeta(message, swipeId, { hidden: false });
      persistChatQuietly();
      decorateMessageElement(mesId);
      renderOverviewModal();
      notify(`已恢复显示第 #${swipeId + 1} 条可能`);
      return;
    }
    setSwipeMeta(message, swipeId, { hidden: true });
    persistChatQuietly();
    const updatedSummary = summarizeMessageEchoes(message);
    if (updatedSummary.visibleCount > 0) {
      const nextVisible = findAdjacentVisibleSwipeId(message, swipeId, -1, { wrap: true });
      if (isLatestMessage) {
        await setCanonicalSwipeOnMessage(mesId, nextVisible, { keepExpanded: true });
      } else {
        applyInPlacePreview(mesId, nextVisible, { expandBar: true });
      }
      renderOverviewModal();
      notify(`已隐藏第 #${swipeId + 1} 条可能，已自动切至第 #${nextVisible + 1} 条`);
    } else {
      decorateMessageElement(mesId);
      renderOverviewModal();
      notify(`已隐藏第 #${swipeId + 1} 条可能`);
    }
    return;
  }
  if (action === 'copy-text') {
    const swipes = getMessageSwipes(message);
    const text = String(swipes[swipeId] ?? '');
    try {
      await navigator.clipboard.writeText(text);
      notify(`已复制第 #${swipeId + 1} 条正文`, 'success');
    } catch (_) {
      notify('复制失败，请手动选中复制', 'warning');
    }
    return;
  }
  if (action === 'preview-in-floor') {
    const isLatestMessage = mesId === (ctx.chat.length - 1);
    closeOverviewModal();
    if (isLatestMessage) {
      await setCanonicalSwipeOnMessage(mesId, swipeId, { keepExpanded: true });
    } else {
      applyInPlacePreview(mesId, swipeId, { expandBar: true });
    }
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    mesEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  if (action === 'branch-from-echo') {
    closeOverviewModal();
    await saveRouteAAndBranchRouteB(mesId, swipeId);
    return;
  }
  if (action === 'ask-make-canonical') {
    modalState.confirmMakeCanonicalSwipeId = swipeId;
    renderOverviewModal();
    return;
  }
  if (action === 'cancel-make-canonical') {
    modalState.confirmMakeCanonicalSwipeId = -1;
    renderOverviewModal();
    return;
  }
  if (action === 'confirm-make-canonical') {
    modalState.confirmMakeCanonicalSwipeId = -1;
    await setCanonicalSwipeOnMessage(mesId, swipeId, { keepExpanded: true });
    renderOverviewModal();
    notify(`已将第 #${swipeId + 1} 条设为第 #${mesId} 楼的当前生效路线（AI 将读取此段）`, 'success');
  }
}

// ============================================================================
// Inline Action Bar Click & Keyboard Handlers + Native `< 2/3 >` Interception
// ============================================================================
async function onDocumentClickCapture(event) {
  const settings = getSettings();
  if (!settings.enabled) return;

  const target = event.target;
  if (!(target instanceof Element)) return;

  // 1. Handle clicks inside our inline `.yte-dock` bar first
  const actionBtn = target.closest('.yte-dock [data-action]');
  if (actionBtn) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const action = actionBtn.dataset.action;
    const mesId = Number(actionBtn.dataset.mesid ?? actionBtn.closest('.yte-dock')?.dataset.mesid);
    const ctx = getCtx();
    const message = ctx?.chat?.[mesId];
    if (!message || !Number.isInteger(mesId)) return;

    const summary = summarizeMessageEchoes(message);
    const isLatestMessage = mesId === (ctx.chat.length - 1);
    const state = ensureFloorState(mesId, message);
    const activeSwipeId = Number(actionBtn.dataset.swipeid ?? (!isLatestMessage ? state.previewSwipeId : summary.canonicalSwipeId));

    if (action === 'collapse-bar') {
      restoreMessageToCanonicalDom(mesId, { keepExpanded: false });
      decorateMessageElement(mesId);
      return;
    }
    if (action === 'toggle-star') {
      const current = getSwipeMeta(message, activeSwipeId);
      setSwipeMeta(message, activeSwipeId, { starred: !current.starred });
      persistChatQuietly();
      decorateMessageElement(mesId);
      return;
    }
    if (action === 'edit-note') {
      state.expanded = true;
      state.editingNote = !state.editingNote;
      decorateMessageElement(mesId);
      if (state.editingNote) {
        const input = document.querySelector(`#chat .mes[mesid="${mesId}"] .yte-note-input`);
        if (input) {
          input.focus();
          input.select();
        }
      }
      return;
    }
    if (action === 'save-note') {
      const input = document.querySelector(`#chat .mes[mesid="${mesId}"] .yte-note-input`);
      setSwipeMeta(message, activeSwipeId, { note: input ? input.value : '' });
      state.editingNote = false;
      persistChatQuietly();
      decorateMessageElement(mesId);
      return;
    }
    if (action === 'cancel-note') {
      state.editingNote = false;
      decorateMessageElement(mesId);
      return;
    }
    if (action === 'soft-hide-current') {
      const current = getSwipeMeta(message, activeSwipeId);
      if (current.hidden) {
        setSwipeMeta(message, activeSwipeId, { hidden: false });
        persistChatQuietly();
        decorateMessageElement(mesId);
        notify(`已恢复显示第 #${activeSwipeId + 1} 条可能`);
        return;
      }
      setSwipeMeta(message, activeSwipeId, { hidden: true });
      persistChatQuietly();
      const updatedSummary = summarizeMessageEchoes(message);
      if (updatedSummary.visibleCount > 0) {
        const nextVisible = findAdjacentVisibleSwipeId(message, activeSwipeId, -1, { wrap: true });
        if (isLatestMessage) {
          await setCanonicalSwipeOnMessage(mesId, nextVisible, { keepExpanded: true });
        } else {
          applyInPlacePreview(mesId, nextVisible, { expandBar: true });
        }
        notify(`已隐藏第 #${activeSwipeId + 1} 条可能，已自动切至第 #${nextVisible + 1} 条（可在「全部列表 -> 已隐藏」恢复）`);
      } else {
        decorateMessageElement(mesId);
        notify(`已隐藏第 #${activeSwipeId + 1} 条可能`);
      }
      return;
    }
    if (action === 'reroll-floor') {
      await rollHistoricalMessage(mesId);
      return;
    }
    if (action === 'branch-from-current') {
      await saveRouteAAndBranchRouteB(mesId, activeSwipeId);
      return;
    }
    if (action === 'make-current-canonical') {
      await setCanonicalSwipeOnMessage(mesId, activeSwipeId, { keepExpanded: true });
      notify(`已将第 #${activeSwipeId + 1} 条设为第 #${mesId} 楼的当前生效路线（预设与 AI 将读取此段）`, 'success');
      return;
    }
    if (action === 'open-modal') {
      openOverviewModal(mesId);
    }
    return;
  }

  const mesEl = target.closest('#chat .mes[mesid]');
  if (!mesEl) return;

  const mesId = Number(mesEl.getAttribute('mesid'));
  const ctx = getCtx();
  const chat = ctx?.chat;
  const message = chat?.[mesId];
  if (!message || isOpeningGreetingFloor(mesId) || message.is_user || message.is_system || !Number.isInteger(mesId)) return;

  const isLatestMessage = mesId === chat.length - 1;

  // 2. Clicking `.swipes-counter` (`2/3`) toggles the inline action bar right on this floor!
  if (target.closest('.swipes-counter')) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const state = ensureFloorState(mesId, message);
    state.expanded = !state.expanded;
    if (!state.expanded && !isLatestMessage) {
      restoreMessageToCanonicalDom(mesId, { keepExpanded: false });
    }
    decorateMessageElement(mesId);
    return;
  }

  // Clicking `.mes_swipe_picker` (in the `...` menu) opens the full overview modal
  if (target.closest('.mes_swipe_picker')) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openOverviewModal(mesId);
    return;
  }

  if (isLatestMessage) {
    if (target.closest('.swipe_left')) {
      const state = ensureFloorState(mesId, message);
      state.expanded = true;
    }
    return;
  }
  if (!settings.enableHistoricalSwipes) return;

  // 3. Historical floor `.swipe_left` (`<`): flip to previous & automatically open inline action bar!
  if (target.closest('.swipe_left')) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const summary = summarizeMessageEchoes(message);
    const state = ensureFloorState(mesId, message);
    state.expanded = true;

    if (summary.total > 1) {
      const currentId = state.previewSwipeId;
      const prevId = findAdjacentVisibleSwipeId(message, currentId, -1, { wrap: false });
      applyInPlacePreview(mesId, prevId, { expandBar: true });
    } else {
      decorateMessageElement(mesId);
    }
    return;
  }

  // 4. Historical floor `.swipe_right` (`>`):
  //    - If there is a next visible swipe, flip to it & open the inline action bar!
  //    - If already at the last swipe, DO NOT accidentally fire an API reroll; instead,
  //      expand the inline action bar so the user can intentionally click `[🎲 在本楼重 roll]`!
  if (target.closest('.swipe_right')) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const state = ensureFloorState(mesId, message);
    const currentId = state.previewSwipeId;
    const nextId = findAdjacentVisibleSwipeId(message, currentId, 1, { wrap: false });

    if (nextId !== currentId) {
      applyInPlacePreview(mesId, nextId, { expandBar: true });
      return;
    }

    // Already at the last visible swipe on this historical floor:
    // Open the inline bar (or if user explicitly enabled direct arrow reroll in settings, reroll)
    if (settings.directRerollOnRightArrow) {
      await rollHistoricalMessage(mesId);
    } else {
      state.expanded = true;
      decorateMessageElement(mesId);
      const rerollBtn = mesEl.querySelector('[data-action="reroll-floor"]');
      rerollBtn?.classList.add('yte-pulse-highlight');
      setTimeout(() => rerollBtn?.classList.remove('yte-pulse-highlight'), 1200);
    }
  }
}

function onDocumentKeyDown(event) {
  const input = event.target.closest?.('.yte-note-input');
  if (!input) return;
  const mesId = Number(input.dataset.mesid);
  const swipeId = Number(input.dataset.swipeid);
  const ctx = getCtx();
  const message = ctx?.chat?.[mesId];
  if (!message || !Number.isInteger(mesId)) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    setSwipeMeta(message, swipeId, { note: input.value });
    const state = previewMap.get(mesId);
    if (state) state.editingNote = false;
    persistChatQuietly();
    decorateMessageElement(mesId);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    const state = previewMap.get(mesId);
    if (state) state.editingNote = false;
    decorateMessageElement(mesId);
  }
}

// ============================================================================
// Settings Panel in Extensions Drawer
// ============================================================================
function mountSettingsPanel() {
  const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (!container || document.getElementById('yte-settings-panel')) return;

  const settings = getSettings();
  const wrapper = document.createElement('div');
  wrapper.id = 'yte-settings-panel';
  wrapper.className = 'extension_container';
  wrapper.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>砚台 · 重Roll助手</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <p class="yte-settings-desc">平时 100% 原生无痕（仅显示 <code>&lt; 2/3 &gt;</code>）；当你点击某楼的页码或左右箭头回看时，自动浮现该楼专属的收藏、备注、隐藏、重 roll 与分支工具栏。</p>
        <label class="checkbox_label">
          <input type="checkbox" data-yte-setting="enabled" ${settings.enabled ? 'checked' : ''}>
          <span>启用「砚台 · 重Roll助手」</span>
        </label>
        <label class="checkbox_label">
          <input type="checkbox" data-yte-setting="enableHistoricalSwipes" ${settings.enableHistoricalSwipes ? 'checked' : ''}>
          <span>在历史楼层右下角保留原生样式的 <code>&lt; 页码 &gt;</code> 切换器</span>
        </label>
        <label class="checkbox_label">
          <input type="checkbox" data-yte-setting="directRerollOnRightArrow" ${settings.directRerollOnRightArrow ? 'checked' : ''}>
          <span>在历史楼层最后一页点右箭头 <code>&gt;</code> 时直接触发重 roll（默认关闭：点右箭头先展开工具栏防误触）</span>
        </label>
        <label class="checkbox_label">
          <input type="checkbox" data-yte-setting="skipHiddenOnNativeSwipe" ${settings.skipHiddenOnNativeSwipe ? 'checked' : ''}>
          <span>用左右箭头翻页时自动跳过已隐藏的条目</span>
        </label>
        <label class="checkbox_label">
          <input type="checkbox" data-yte-setting="rescueOnRegenerate" ${settings.rescueOnRegenerate ? 'checked' : ''}>
          <span>防误删保护：点击菜单「重新生成 (Regenerate)」时自动保留本楼之前的重 roll</span>
        </label>
      </div>
    </div>
  `;

  wrapper.addEventListener('change', event => {
    const checkbox = event.target.closest('[data-yte-setting]');
    if (!checkbox) return;
    const key = checkbox.dataset.yteSetting;
    const current = getSettings();
    current[key] = Boolean(checkbox.checked);
    saveSettings();
    if (!current.enabled) {
      restoreAllPreviews();
    }
    decorateAllMessages();
  });

  container.appendChild(wrapper);
}

// ============================================================================
// SillyTavern Event Hooks
// ============================================================================
function bindEvents() {
  const ctx = getCtx();
  const eventSource = ctx?.eventSource;
  const eventTypes = ctx?.eventTypes || ctx?.event_types;
  if (!eventSource || !eventTypes) return false;

  const refreshAll = () => {
    requestAnimationFrame(() => {
      decorateAllMessages();
      if (modalState.open) renderOverviewModal();
    });
  };

  if (eventTypes.CHAT_CHANGED) {
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
      previewMap.clear();
      pendingRegenerateRescue = null;
      lastObservedLatestSwipe = { mesId: -1, swipeId: -1 };
      closeOverviewModal();
      refreshAll();
    });
  }

  if (eventTypes.GENERATION_AFTER_COMMANDS) {
    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, (type, _params, dryRun) => {
      if (dryRun) return;
      restoreAllPreviews();

      const settings = getSettings();
      if (settings.enabled && settings.rescueOnRegenerate && type === 'regenerate') {
        const chat = ctx.chat;
        if (Array.isArray(chat) && chat.length > 1) {
          const lastIdx = chat.length - 1;
          const lastMes = chat[lastIdx];
          if (!isOpeningGreetingFloor(lastIdx) && lastMes && !lastMes.is_user && !lastMes.is_system) {
            const swipes = getMessageSwipes(lastMes);
            if (swipes.length > 0) {
              pendingRegenerateRescue = {
                chatId: ctx.getCurrentChatId?.() || '',
                mesId: lastIdx,
                swipes: [...swipes],
                swipe_info: Array.isArray(lastMes.swipe_info) ? structuredClone(lastMes.swipe_info) : [],
                echoesMap: lastMes.extra?.yantai_echoes_map ? structuredClone(lastMes.extra.yantai_echoes_map) : {},
              };
            }
          }
        }
      }
    });
  }

  if (eventTypes.CHARACTER_MESSAGE_RENDERED) {
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (mesId) => {
      if (isInternalRenderEmit) return;
      const targetId = Number(mesId);
      const chat = ctx.chat;
      if (
        pendingRegenerateRescue &&
        Array.isArray(chat) &&
        targetId === pendingRegenerateRescue.mesId &&
        (ctx.getCurrentChatId?.() || '') === pendingRegenerateRescue.chatId
      ) {
        const newMes = chat[targetId];
        if (newMes && mergeRescuedSwipesOnRegenerate(newMes, pendingRegenerateRescue)) {
          pendingRegenerateRescue = null;
          persistChatQuietly();
        }
      }
      if (Number.isInteger(targetId)) {
        lastObservedLatestSwipe = {
          mesId: targetId,
          swipeId: Number(chat?.[targetId]?.swipe_id ?? 0),
        };
      }
      refreshAll();
    });
  }

  if (eventTypes.MESSAGE_SWIPED) {
    eventSource.on(eventTypes.MESSAGE_SWIPED, async (mesId) => {
      const targetId = Number(mesId);
      const chat = ctx.chat;
      const message = chat?.[targetId];
      if (!message || isOpeningGreetingFloor(targetId)) return;

      const currentSwipeId = Number(message.swipe_id ?? 0);
      const prevSwipeId = lastObservedLatestSwipe.mesId === targetId ? lastObservedLatestSwipe.swipeId : -1;
      lastObservedLatestSwipe = { mesId: targetId, swipeId: currentSwipeId };

      const settings = getSettings();
      if (
        settings.enabled &&
        settings.skipHiddenOnNativeSwipe &&
        !isAutoSkippingHiddenSwipe &&
        targetId === chat.length - 1
      ) {
        const meta = getSwipeMeta(message, currentSwipeId);
        const summary = summarizeMessageEchoes(message);
        if (meta.hidden && summary.visibleCount > 0) {
          const step = (prevSwipeId !== -1 && currentSwipeId < prevSwipeId) ? -1 : 1;
          const nextVisible = findAdjacentVisibleSwipeId(message, currentSwipeId, step, { wrap: false });
          if (nextVisible !== currentSwipeId) {
            isAutoSkippingHiddenSwipe = true;
            try {
              await setCanonicalSwipeOnMessage(targetId, nextVisible);
              lastObservedLatestSwipe = { mesId: targetId, swipeId: nextVisible };
            } finally {
              isAutoSkippingHiddenSwipe = false;
            }
            return;
          }
        }
      }

      decorateMessageElement(targetId);
      if (modalState.open && modalState.mesId === targetId) {
        renderOverviewModal();
      }
    });
  }

  for (const evt of [
    eventTypes.MESSAGE_RECEIVED,
    eventTypes.MESSAGE_UPDATED,
    eventTypes.MESSAGE_DELETED,
    eventTypes.USER_MESSAGE_RENDERED,
    eventTypes.MORE_MESSAGES_LOADED,
    eventTypes.GENERATION_ENDED,
  ]) {
    if (evt) eventSource.on(evt, refreshAll);
  }

  return true;
}

function init() {
  document.addEventListener('click', onDocumentClickCapture, true);
  document.addEventListener('keydown', onDocumentKeyDown, true);

  const tryBoot = () => {
    mountSettingsPanel();
    if (bindEvents()) {
      decorateAllMessages();
      return true;
    }
    return false;
  };

  if (!tryBoot()) {
    const timer = setInterval(() => {
      if (tryBoot()) clearInterval(timer);
    }, 500);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
