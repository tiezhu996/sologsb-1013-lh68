import { module, test } from 'qunit';
import {
  buildReschedulePlan,
  findCycles,
  validateShow,
  PREP_WINDOW_SECONDS,
} from 'stage-cue-editor/utils/reschedule';
import type { Cue, Scene, ShowData } from 'stage-cue-editor/models/show';

function makeCue(id: string, duration: number, extra: Partial<Cue> = {}): Cue {
  return {
    id,
    kind: '舞台',
    title: `提示${id}`,
    duration,
    owner: '测试',
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

function makeScene(id: string, startTime: string, cues: Cue[]): Scene {
  let elapsed = 0;
  cues.forEach((cue) => {
    cue.offset = elapsed;
    elapsed += cue.duration;
  });
  return {
    id,
    act: '第一幕',
    name: id,
    title: id,
    startTime,
    locked: false,
    cues,
  };
}

function makeShow(scenes: Scene[]): ShowData {
  return { title: '测试演出', venue: '', date: '', scenes, updatedAt: '' };
}

module('Unit | Utility | reschedule', function () {
  test('顺延整段：时长增加后同场后续提示整体顺移', function (assert) {
    const show = makeShow([
      makeScene('s1', '19:30', [
        makeCue('a', 60),
        makeCue('b', 60),
        makeCue('c', 60),
      ]),
    ]);
    const plan = buildReschedulePlan(show, 's1', 'a', 120, 'shift-segment');
    assert.true(plan.applicable);
    assert.deepEqual(
      [plan.offsets['a'], plan.offsets['b'], plan.offsets['c']],
      [0, 120, 180],
    );
    assert.strictEqual(plan.moves.length, 2);
    assert.strictEqual(
      show.scenes[0]!.cues[1]!.offset,
      60,
      '原始数据不被预演修改',
    );
  });

  test('只移动冲突项：时长缩短留出空档，整段策略则会贴合收拢', function (assert) {
    const build = () => {
      const scene = makeScene('s1', '19:30', [
        makeCue('a', 60),
        makeCue('b', 60),
        makeCue('c', 60),
      ]);
      scene.cues[2]!.offset = 200;
      return makeShow([scene]);
    };
    const shift = buildReschedulePlan(build(), 's1', 'a', 30, 'shift-segment');
    assert.deepEqual(
      [shift.offsets['a'], shift.offsets['b'], shift.offsets['c']],
      [0, 30, 90],
    );
    const move = buildReschedulePlan(build(), 's1', 'a', 30, 'move-conflicts');
    assert.deepEqual(
      [move.offsets['a'], move.offsets['b'], move.offsets['c']],
      [0, 60, 200],
    );
  });

  test('固定锚点：传播在锚点处停住并列出保留时间的原因', function (assert) {
    const show = makeShow([
      makeScene('s1', '19:30', [
        makeCue('a', 60),
        makeCue('b', 60, { anchor: true }),
        makeCue('c', 60),
      ]),
    ]);
    const plan = buildReschedulePlan(show, 's1', 'a', 120, 'shift-segment');
    assert.false(plan.applicable);
    assert.strictEqual(plan.blocked.length, 1);
    assert.strictEqual(plan.blocked[0]!.cueId, 'b');
    assert.strictEqual(plan.blocked[0]!.keptOffset, 60);
    assert.ok(plan.blocked[0]!.reason.includes('固定锚点'));
    assert.strictEqual(plan.offsets['c'], 120, '锚点之后的提示保留原时间');
    assert.ok(plan.violations.length > 0, '残留重叠被校验记录');
  });

  test('循环依赖：方案直接停住并列出循环链', function (assert) {
    const show = makeShow([
      makeScene('s1', '19:30', [
        makeCue('a', 60, { dependsOn: ['b'] }),
        makeCue('b', 60, { dependsOn: ['a'] }),
      ]),
    ]);
    const plan = buildReschedulePlan(show, 's1', 'a', 120, 'shift-segment');
    assert.false(plan.applicable);
    assert.strictEqual(plan.cycles.length, 1);
    assert.strictEqual(plan.moves.length, 0);
  });

  test('跨场前置：前置所在场时长变化沿依赖传播到下一场', function (assert) {
    const s1 = makeScene('s1', '19:30', [makeCue('a', 60)]);
    const s2 = makeScene('s2', '19:40', [
      makeCue('d', 30, { dependsOn: ['a'] }),
      makeCue('e', 30),
    ]);
    const plan = buildReschedulePlan(
      makeShow([s1, s2]),
      's1',
      'a',
      660,
      'shift-segment',
    );
    assert.true(plan.applicable);
    assert.strictEqual(plan.offsets['d'], 60, '下一场提示跟随前置顺延');
    assert.strictEqual(plan.offsets['e'], 90, '同场后续保持衔接');
  });

  test('跨场道具准备窗口冲突：只移动冲突项把冲突提示推到安全窗口', function (assert) {
    const s1 = makeScene('s1', '19:30', [
      makeCue('x', 60, { props: ['折扇'] }),
    ]);
    const s2 = makeScene('s2', '19:30', [
      makeCue('z', 60),
      makeCue('y', 60, { props: ['折扇'] }),
    ]);
    const plan = buildReschedulePlan(
      makeShow([s1, s2]),
      's1',
      'x',
      300,
      'move-conflicts',
    );
    assert.true(plan.applicable);
    assert.strictEqual(plan.offsets['y'], 300 + PREP_WINDOW_SECONDS);
    assert.strictEqual(plan.offsets['z'], 0, '未冲突的提示保留原时间');
    assert.strictEqual(plan.conflicts.length, 0);
  });

  test('跨场道具冲突遇上锚点：记为未解决冲突且方案不可应用', function (assert) {
    const s1 = makeScene('s1', '19:30', [
      makeCue('x', 60, { props: ['折扇'] }),
    ]);
    const s2 = makeScene('s2', '19:30', [
      makeCue('y', 60, { props: ['折扇'], anchor: true }),
    ]);
    const plan = buildReschedulePlan(
      makeShow([s1, s2]),
      's1',
      'x',
      300,
      'move-conflicts',
    );
    assert.false(plan.applicable);
    assert.strictEqual(plan.conflicts.length, 1);
    assert.strictEqual(plan.offsets['y'], 0, '锚点提示保持原时间');
  });

  test('失效引用不阻塞重排，由检查面板单独标记', function (assert) {
    const show = makeShow([
      makeScene('s1', '19:30', [
        makeCue('a', 60),
        makeCue('b', 60, { dependsOn: ['missing-cue'] }),
      ]),
    ]);
    const plan = buildReschedulePlan(show, 's1', 'a', 120, 'shift-segment');
    assert.true(plan.applicable);
  });

  test('findCycles 检测自引用与互相依赖', function (assert) {
    const selfLoop = makeShow([
      makeScene('s1', '19:30', [makeCue('a', 60, { dependsOn: ['a'] })]),
    ]);
    assert.strictEqual(findCycles(selfLoop).length, 1);
    const clean = makeShow([
      makeScene('s1', '19:30', [
        makeCue('a', 60),
        makeCue('b', 60, { dependsOn: ['a'] }),
      ]),
    ]);
    assert.strictEqual(findCycles(clean).length, 0);
  });

  test('validateShow 报告同场重叠、前置未结束与资源窗口冲突', function (assert) {
    const overlapping = makeScene('s1', '19:30', [
      makeCue('a', 60),
      makeCue('b', 60),
    ]);
    overlapping.cues[1]!.offset = 30;
    assert.strictEqual(validateShow(makeShow([overlapping])).length, 1);

    const s1 = makeScene('s1', '19:30', [makeCue('a', 600)]);
    const s2 = makeScene('s2', '19:35', [
      makeCue('d', 30, { dependsOn: ['a'] }),
    ]);
    assert.ok(
      validateShow(makeShow([s1, s2])).some((problem) =>
        problem.includes('前置提示'),
      ),
    );

    const r1 = makeScene('r1', '19:30', [
      makeCue('x', 60, { props: ['折扇'] }),
    ]);
    const r2 = makeScene('r2', '19:30', [
      makeCue('y', 60, { props: ['折扇'] }),
    ]);
    assert.ok(
      validateShow(makeShow([r1, r2])).some((problem) =>
        problem.includes('准备窗口冲突'),
      ),
    );

    const clean = makeShow([
      makeScene('s1', '19:30', [makeCue('a', 60), makeCue('b', 60)]),
    ]);
    assert.strictEqual(validateShow(clean).length, 0);
  });
});
