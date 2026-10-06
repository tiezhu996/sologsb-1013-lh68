import { module, test } from 'qunit';
import { applyReplan, previewReplan } from 'stage-cue-editor/utils/replanner';
import type { Cue, Scene, ShowData } from 'stage-cue-editor/models/show';

function makeCue(id: string, extra: Partial<Cue> = {}): Cue {
  return {
    id,
    kind: '舞台',
    title: id,
    duration: 60,
    owner: '',
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn: [],
    offset: 0,
    anchor: false,
    ...extra,
  };
}

function makeScene(
  id: string,
  startTime: string,
  cues: Cue[],
  extra: Partial<Scene> = {},
): Scene {
  return {
    id,
    act: '第一幕',
    name: id,
    title: id,
    startTime,
    locked: false,
    cues,
    ...extra,
  };
}

function makeShow(scenes: Scene[]): ShowData {
  return { title: '测试', venue: '', date: '', scenes, updatedAt: '' };
}

/** 与应用内一致的顺序布局：未显式指定的 offset 按顺序累计 */
function layout(scene: Scene): Scene {
  let elapsed = 0;
  scene.cues.forEach((cue) => {
    if (!cue.offset) cue.offset = elapsed;
    elapsed = cue.offset + cue.duration;
  });
  return scene;
}

/** S1: A → B → C（顺序前置），S2: D 依赖 C */
function chainShow(): ShowData {
  return makeShow([
    layout(
      makeScene('s1', '19:30', [
        makeCue('a'),
        makeCue('b', { dependsOn: ['a'] }),
        makeCue('c'),
      ]),
    ),
    layout(makeScene('s2', '19:40', [makeCue('d', { dependsOn: ['c'] })])),
  ]);
}

function cueOf(show: ShowData, id: string): Cue {
  const found = show.scenes
    .flatMap((scene) => scene.cues)
    .find((cue) => cue.id === id);
  if (!found) throw new Error(`missing cue ${id}`);
  return found;
}

module('Unit | replanner', function () {
  test('时长调整后沿前置关系跨场传播', function (assert) {
    const show = chainShow();
    const preview = previewReplan(show, 'a', 760);
    assert.strictEqual(preview.stops.length, 0, '没有停住项');
    const moves = new Map(preview.moves.map((move) => [move.cueId, move]));
    assert.strictEqual(moves.get('b')?.afterOffset, 760, 'b 紧跟 a 结束');
    assert.strictEqual(moves.get('c')?.afterOffset, 820, 'c 紧跟 b 结束');
    assert.strictEqual(
      moves.get('d')?.afterOffset,
      280,
      '跨场依赖 c 的 d 被推迟到 19:44:40',
    );
    assert.strictEqual(moves.get('b')?.beforeOffset, 60, '记录改动前时间');
  });

  test('预演不改动原始数据', function (assert) {
    const show = chainShow();
    const snapshot = JSON.parse(JSON.stringify(show));
    previewReplan(show, 'a', 760);
    assert.deepEqual(show, snapshot, '预演后 show 保持不变');
  });

  test('缩短时长不产生顺延', function (assert) {
    const show = chainShow();
    const preview = previewReplan(show, 'a', 30);
    assert.strictEqual(preview.moves.length, 0, '没有提示需要移动');
    const result = applyReplan(show, 'a', 30, 'shift-section');
    assert.true(result.ok);
    assert.strictEqual(cueOf(result.show!, 'a').duration, 30, '新时长生效');
    assert.strictEqual(
      cueOf(result.show!, 'b').offset,
      60,
      '后续提示保持原时间',
    );
  });

  test('固定锚点停住传播，应用失败并恢复改前状态', function (assert) {
    const show = chainShow();
    cueOf(show, 'c').anchor = true;
    const snapshot = JSON.parse(JSON.stringify(show));

    const preview = previewReplan(show, 'a', 150);
    assert.strictEqual(preview.moves.length, 1, '只有 b 被顺延');
    const stop = preview.stops.find((item) => item.cueId === 'c');
    assert.strictEqual(stop?.kind, 'anchor', 'c 因锚点保留时间');
    assert.ok(stop?.detail.includes('保留'), '给出保留时间的原因');

    const result = applyReplan(show, 'a', 150, 'shift-section');
    assert.false(result.ok, '锚点与前置冲突，应用失败');
    assert.strictEqual(result.show, undefined);
    assert.ok(
      result.stops.some((item) => item.kind === 'anchor'),
      '保留冲突原因',
    );
    assert.deepEqual(show, snapshot, '原始数据未被改动');
  });

  test('循环依赖停住并列出成员', function (assert) {
    const show = chainShow();
    cueOf(show, 'b').dependsOn = ['a', 'c'];
    const preview = previewReplan(show, 'a', 150);
    assert.true(preview.hasCycle);
    const stop = preview.stops.find((item) => item.kind === 'cycle');
    assert.ok(stop, '出现循环停住');
    assert.ok(stop?.detail.includes('b'), '原因列出循环成员 b');
    assert.ok(stop?.detail.includes('c'), '原因列出循环成员 c');

    const result = applyReplan(show, 'a', 150, 'move-conflicts');
    assert.false(result.ok, '循环依赖无法自动消解');
  });

  test('跨场道具撞场：只移动冲突项', function (assert) {
    const show = makeShow([
      makeScene('s1', '19:30', [
        makeCue('p', { duration: 120, props: ['月牙灯'] }),
      ]),
      makeScene('s2', '19:32', [
        makeCue('q', { props: ['月牙灯'] }),
        makeCue('r', { offset: 200 }),
      ]),
    ]);
    const preview = previewReplan(show, 'p', 300);
    const stop = preview.stops.find((item) => item.cueId === 'q');
    assert.strictEqual(stop?.kind, 'resource', 'q 因共用月牙灯停住');
    assert.deepEqual(stop?.resources, ['月牙灯'], '列出撞场资源');

    const result = applyReplan(show, 'p', 300, 'move-conflicts');
    assert.true(result.ok);
    const next = result.show!;
    assert.strictEqual(
      cueOf(next, 'q').offset,
      240,
      'q 挪到 p 结束并留出准备窗口',
    );
    assert.strictEqual(cueOf(next, 'r').offset, 300, 'r 仅被前置约束推动');
  });

  test('跨场道具撞场：顺延整段保持段落内部间隔', function (assert) {
    const show = makeShow([
      makeScene('s1', '19:30', [
        makeCue('p', { duration: 120, props: ['月牙灯'] }),
      ]),
      makeScene('s2', '19:32', [
        makeCue('q', { props: ['月牙灯'] }),
        makeCue('r', { offset: 200 }),
      ]),
    ]);
    const result = applyReplan(show, 'p', 300, 'shift-section');
    assert.true(result.ok);
    const next = result.show!;
    assert.strictEqual(cueOf(next, 'q').offset, 240, 'q 整段顺移');
    assert.strictEqual(
      cueOf(next, 'r').offset,
      440,
      'r 保持与 q 的原有间隔一起顺移',
    );
  });

  test('撞场项被锚点挡住时应用失败并保留原因', function (assert) {
    const show = makeShow([
      makeScene('s1', '19:30', [
        makeCue('p', { duration: 120, props: ['月牙灯'] }),
      ]),
      makeScene('s2', '19:32', [
        makeCue('q', { props: ['月牙灯'], anchor: true }),
      ]),
    ]);
    const snapshot = JSON.parse(JSON.stringify(show));
    const result = applyReplan(show, 'p', 300, 'move-conflicts');
    assert.false(result.ok, 'q 是锚点无法挪动');
    assert.ok(
      result.stops.some((item) => item.cueId === 'q'),
      '保留 q 的冲突原因',
    );
    assert.deepEqual(show, snapshot, '改前状态被保留');
  });

  test('锁定场次中的提示保留原时间', function (assert) {
    const show = chainShow();
    show.scenes[1]!.locked = true;
    const preview = previewReplan(show, 'a', 760);
    const stop = preview.stops.find((item) => item.cueId === 'd');
    assert.strictEqual(stop?.kind, 'locked', 'd 所在场次已锁定');
    const result = applyReplan(show, 'a', 760, 'shift-section');
    assert.false(result.ok, '锁定场次不可写入');
  });

  test('已删除提示的失效引用不影响传播', function (assert) {
    const show = chainShow();
    cueOf(show, 'b').dependsOn = ['a', 'cue-deleted-old'];
    const preview = previewReplan(show, 'a', 760);
    assert.strictEqual(preview.stops.length, 0, '失效引用被跳过');
    const move = preview.moves.find((item) => item.cueId === 'b');
    assert.strictEqual(move?.afterOffset, 760, 'b 正常顺延');
  });
});
