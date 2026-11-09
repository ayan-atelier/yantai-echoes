import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCleanPreview,
  findAdjacentVisibleSwipeId,
  getSwipeMeta,
  hashSwipeText,
  mergeRescuedSwipesOnRegenerate,
  setSwipeMeta,
  summarizeMessageEchoes,
} from '../core.js';

test('extractCleanPreview strips thinking blocks and HTML while keeping clean story text', () => {
  const raw = `<thinking>用户想要温柔一点的回应，先分析情绪</thinking><details><summary>状态栏</summary>好感度+5</details><p>他垂下眼眸，轻轻替你拢好被风吹乱的碎发。</p>`;
  const res = extractCleanPreview(raw);
  assert.equal(res.preview, '他垂下眼眸，轻轻替你拢好被风吹乱的碎发。');
  assert.ok(res.charCount > 10);
});

test('setSwipeMeta and getSwipeMeta persist star, note, and soft-hide with dual index+hash binding', () => {
  const message = {
    mes: '版本2',
    swipe_id: 1,
    swipes: ['版本1：初见', '版本2：重逢', '版本3：擦肩'],
    swipe_info: [{}, {}, {}],
  };

  setSwipeMeta(message, 0, { starred: true, note: '超甜初见' });
  setSwipeMeta(message, 2, { hidden: true });

  assert.deepEqual(
    {
      starred: getSwipeMeta(message, 0).starred,
      note: getSwipeMeta(message, 0).note,
      hidden: getSwipeMeta(message, 0).hidden,
    },
    { starred: true, note: '超甜初见', hidden: false },
  );

  // Even if swipe_info[0] is lost (e.g. after a native swipe array rebuild), hash fallback still recovers it
  delete message.swipe_info[0].extra;
  assert.equal(getSwipeMeta(message, 0).note, '超甜初见');
  assert.equal(getSwipeMeta(message, 0).starred, true);
  assert.equal(getSwipeMeta(message, 2).hidden, true);
});

test('findAdjacentVisibleSwipeId skips soft-hidden swipes when flipping backward and forward', () => {
  const message = {
    mes: '分支1',
    swipe_id: 0,
    swipes: ['分支1', '分支2(隐藏)', '分支3(隐藏)', '分支4', '分支5(隐藏)'],
    swipe_info: [],
  };
  setSwipeMeta(message, 1, { hidden: true });
  setSwipeMeta(message, 2, { hidden: true });
  setSwipeMeta(message, 4, { hidden: true });

  const summary = summarizeMessageEchoes(message);
  assert.equal(summary.total, 5);
  assert.equal(summary.visibleCount, 2);
  assert.deepEqual(summary.visibleIndices, [0, 3]);

  // Forward from 0 skips 1 & 2 and lands on 3
  assert.equal(findAdjacentVisibleSwipeId(message, 0, 1), 3);
  // Forward from 3 wraps around to 0 (skipping 4)
  assert.equal(findAdjacentVisibleSwipeId(message, 3, 1), 0);
  // If swipe 2 was just hidden, stepping backward lands on 0
  assert.equal(findAdjacentVisibleSwipeId(message, 2, -1), 0);
});

test('mergeRescuedSwipesOnRegenerate preserves all previous swipes and metadata when Regenerate is clicked', () => {
  const oldMessage = {
    mes: '第2版',
    swipe_id: 1,
    swipes: ['第1版', '第2版'],
    swipe_info: [{ send_date: 't1' }, { send_date: 't2' }],
    extra: {},
  };
  setSwipeMeta(oldMessage, 0, { starred: true, note: '保留版' });

  const snapshot = {
    swipes: [...oldMessage.swipes],
    swipe_info: structuredClone(oldMessage.swipe_info),
    echoesMap: structuredClone(oldMessage.extra.yantai_echoes_map),
  };

  // Simulate SillyTavern creating a brand new 1-swipe message after Regenerate
  const newMessage = {
    mes: '第3版（重新生成）',
    swipe_id: 0,
    swipes: ['第3版（重新生成）'],
    swipe_info: [{ send_date: 't3' }],
    extra: {},
  };

  const merged = mergeRescuedSwipesOnRegenerate(newMessage, snapshot);
  assert.equal(merged, true);
  assert.deepEqual(newMessage.swipes, ['第1版', '第2版', '第3版（重新生成）']);
  assert.equal(newMessage.swipe_id, 2);
  assert.equal(newMessage.mes, '第3版（重新生成）');
  assert.equal(getSwipeMeta(newMessage, 0).note, '保留版');
  assert.equal(hashSwipeText('第1版').length > 3, true);
});
