import type {
  Cue,
  RescheduleStrategy,
  Scene,
  ShowData,
} from 'stage-cue-editor/models/show';

/**
 * 重排引擎：导演临时改动一条提示的时长后，沿前置关系与场序传播，
 * 遇到循环依赖、固定锚点或跨场资源（演员 / 道具）准备窗口冲突就停住，
 * 并把受影响提示与保留时间的原因交回给舞台监督决策。
 */

export const PREP_WINDOW_SECONDS = 120;

const EPSILON = 0.0001;
const MAX_PASSES = 200;

export interface PlanMove {
  cueId: string;
  sceneId: string;
  sceneLabel: string;
  title: string;
  beforeOffset: number;
  afterOffset: number;
  reasons: string[];
}

export interface PlanBlock {
  cueId: string;
  sceneId: string;
  sceneLabel: string;
  title: string;
  keptOffset: number;
  reason: string;
}

export interface PlanConflict {
  id: string;
  cueId: string;
  otherCueId: string;
  title: string;
  otherTitle: string;
  kind: '道具' | '演员';
  shared: string[];
  detail: string;
}

export interface ReschedulePlan {
  strategy: RescheduleStrategy;
  sceneId: string;
  cueId: string;
  title: string;
  durationBefore: number;
  durationAfter: number;
  moves: PlanMove[];
  blocked: PlanBlock[];
  conflicts: PlanConflict[];
  cycles: string[][];
  violations: string[];
  applicable: boolean;
  offsets: Record<string, number>;
}

export interface ResourceWindow {
  cueId: string;
  sceneId: string;
  title: string;
  start: number;
  end: number;
  props: string[];
  cast: string[];
}

export interface ResourceConflict {
  a: ResourceWindow;
  b: ResourceWindow;
  kind: '道具' | '演员';
  shared: string[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function startSeconds(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 3600 + Number(minute) * 60;
}

export function timeLabel(scene: Scene, offset: number): string {
  const total =
    (((startSeconds(scene.startTime) + offset) % 86400) + 86400) % 86400;
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = Math.floor(total % 60);
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function overlaps(
  aStart: number,
  aDuration: number,
  bStart: number,
  bDuration: number,
): boolean {
  return (
    aStart < bStart + bDuration - EPSILON &&
    bStart < aStart + aDuration - EPSILON
  );
}

export function sceneLabel(scene: Scene): string {
  return `${scene.act} ${scene.name}`;
}

/** 检测前置提示关系中的循环依赖，返回循环链（提示 ID）。 */
export function findCycles(show: ShowData): string[][] {
  const ids = new Set(
    show.scenes.flatMap((scene) => scene.cues.map((cue) => cue.id)),
  );
  const graph = new Map<string, string[]>();
  show.scenes.forEach((scene) =>
    scene.cues.forEach((cue) =>
      graph.set(
        cue.id,
        cue.dependsOn.filter((id) => ids.has(id)),
      ),
    ),
  );
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    state.set(node, 'visiting');
    stack.push(node);
    (graph.get(node) ?? []).forEach((next) => {
      if (state.get(next) === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!state.get(next)) {
        visit(next);
      }
    });
    stack.pop();
    state.set(node, 'done');
  };

  graph.forEach((_, id) => {
    if (!state.get(id)) visit(id);
  });
  return cycles;
}

/** 收集跨场演员 / 道具准备窗口冲突（窗口 = 开始前预留准备时间至结束）。 */
export function collectResourceConflicts(
  windows: ResourceWindow[],
): ResourceConflict[] {
  const conflicts: ResourceConflict[] = [];
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i]!;
      const b = windows[j]!;
      if (a.sceneId === b.sceneId || a.cueId === b.cueId) continue;
      if (!overlaps(a.start, a.end - a.start, b.start, b.end - b.start))
        continue;
      const sharedProps = a.props.filter((value) => b.props.includes(value));
      const sharedCast = a.cast.filter((value) => b.cast.includes(value));
      if (sharedProps.length)
        conflicts.push({ a, b, kind: '道具', shared: sharedProps });
      if (sharedCast.length)
        conflicts.push({ a, b, kind: '演员', shared: sharedCast });
    }
  }
  return conflicts;
}

export function resourceWindows(show: ShowData): ResourceWindow[] {
  return show.scenes.flatMap((scene) =>
    scene.cues.map((cue) => {
      const start = startSeconds(scene.startTime) + cue.offset;
      return {
        cueId: cue.id,
        sceneId: scene.id,
        title: cue.title,
        start: start - PREP_WINDOW_SECONDS,
        end: start + cue.duration,
        props: cue.props,
        cast: cue.cast,
      };
    }),
  );
}

/** 校验整份提示表：同场重叠、前置未结束、跨场资源准备窗口冲突。返回问题描述列表。 */
export function validateShow(
  show: ShowData,
  options: { includeResources?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const index = new Map<string, { cue: Cue; scene: Scene }>();
  show.scenes.forEach((scene) =>
    scene.cues.forEach((cue) => index.set(cue.id, { cue, scene })),
  );

  show.scenes.forEach((scene) => {
    scene.cues.forEach((cue, position) => {
      const previous = scene.cues[position - 1];
      if (
        previous &&
        cue.offset < previous.offset + previous.duration - EPSILON
      ) {
        problems.push(
          `${sceneLabel(scene)}「${cue.title}」与同场上一条「${previous.title}」时间重叠`,
        );
      }
    });
  });

  index.forEach(({ cue, scene }) => {
    cue.dependsOn.forEach((depId) => {
      const dep = index.get(depId);
      if (!dep) return;
      const cueStart = startSeconds(scene.startTime) + cue.offset;
      const depEnd =
        startSeconds(dep.scene.startTime) + dep.cue.offset + dep.cue.duration;
      if (cueStart < depEnd - EPSILON) {
        problems.push(
          `「${cue.title}」在前置提示「${dep.cue.title}」结束前开始`,
        );
      }
    });
  });

  if (options.includeResources !== false) {
    collectResourceConflicts(resourceWindows(show)).forEach((conflict) => {
      problems.push(
        `「${conflict.a.title}」与「${conflict.b.title}」${conflict.kind}准备窗口冲突（${conflict.shared.join('、')}）`,
      );
    });
  }
  return problems;
}

interface WorkCue {
  cue: Cue;
  scene: Scene;
  offset: number;
}

/**
 * 生成重排预演方案。不修改传入的 show；返回的方案包含最终 offset 表，
 * 供确认后一次性写入。applicable 为 false 时应用会失败并应恢复改前状态。
 */
export function buildReschedulePlan(
  show: ShowData,
  sceneId: string,
  cueId: string,
  newDuration: number,
  strategy: RescheduleStrategy,
): ReschedulePlan {
  const data = clone(show);
  const scene = data.scenes.find((item) => item.id === sceneId);
  const target = scene?.cues.find((item) => item.id === cueId);
  const plan: ReschedulePlan = {
    strategy,
    sceneId,
    cueId,
    title: target?.title ?? '',
    durationBefore: target?.duration ?? 0,
    durationAfter: Math.max(1, Math.round(Number(newDuration)) || 1),
    moves: [],
    blocked: [],
    conflicts: [],
    cycles: [],
    violations: [],
    applicable: false,
    offsets: {},
  };
  if (!scene || !target) return plan;

  const work = new Map<string, WorkCue>();
  const original = new Map<string, number>();
  data.scenes.forEach((item) =>
    item.cues.forEach((cue) => {
      work.set(cue.id, { cue, scene: item, offset: cue.offset });
      original.set(cue.id, cue.offset);
    }),
  );

  // 循环依赖：直接停住，不做任何传播。
  plan.cycles = findCycles(data);
  if (plan.cycles.length) return plan;

  const moveReasons = new Map<string, Set<string>>();
  const blockedBy = new Map<string, PlanBlock>();

  const absStart = (entry: WorkCue): number =>
    startSeconds(entry.scene.startTime) + entry.offset;
  const absEnd = (entry: WorkCue): number =>
    absStart(entry) + entry.cue.duration;
  const indexOf = (entry: WorkCue): number =>
    entry.scene.cues.findIndex((cue) => cue.id === entry.cue.id);

  const recordMove = (entry: WorkCue, reason: string): void => {
    const reasons = moveReasons.get(entry.cue.id) ?? new Set<string>();
    reasons.add(reason);
    moveReasons.set(entry.cue.id, reasons);
  };

  const blockCue = (entry: WorkCue, reason: string): void => {
    if (blockedBy.has(entry.cue.id)) return;
    blockedBy.set(entry.cue.id, {
      cueId: entry.cue.id,
      sceneId: entry.scene.id,
      sceneLabel: sceneLabel(entry.scene),
      title: entry.cue.title,
      keptOffset: original.get(entry.cue.id) ?? entry.offset,
      reason,
    });
  };

  const shiftCue = (entry: WorkCue, delta: number, reason: string): boolean => {
    if (Math.abs(delta) < EPSILON) return true;
    if (entry.cue.anchor) {
      blockCue(
        entry,
        `固定锚点，保持 ${timeLabel(entry.scene, original.get(entry.cue.id) ?? entry.offset)}`,
      );
      return false;
    }
    entry.offset += delta;
    recordMove(entry, reason);
    return true;
  };

  // 顺延整段：从 fromIndex 起整段一起移动，遇到锚点即停。
  const shiftSegment = (
    targetScene: Scene,
    fromIndex: number,
    delta: number,
    reason: string,
  ): boolean => {
    let ok = true;
    for (let i = fromIndex; i < targetScene.cues.length; i += 1) {
      const entry = work.get(targetScene.cues[i]!.id)!;
      if (!shiftCue(entry, delta, i === fromIndex ? reason : '同场整段顺延')) {
        ok = false;
        break;
      }
    }
    return ok;
  };

  // 从 from 开始恢复同场衔接：整段策略保持整段贴合，冲突项策略只推开实际重叠的提示。
  const settleScene = (targetScene: Scene, from: number): void => {
    for (let i = Math.max(from, 1); i < targetScene.cues.length; i += 1) {
      const previous = work.get(targetScene.cues[i - 1]!.id)!;
      const current = work.get(targetScene.cues[i]!.id)!;
      const need = previous.offset + previous.cue.duration;
      const gap = current.offset - need;
      const reason = `衔接上一条「${previous.cue.title}」`;
      if (gap < -EPSILON) {
        if (strategy === 'shift-segment')
          shiftSegment(targetScene, i, -gap, reason);
        else shiftCue(current, -gap, reason);
      } else if (strategy === 'shift-segment' && gap > EPSILON) {
        shiftSegment(targetScene, i, -gap, reason);
      }
    }
  };

  // 沿前置关系传播：前置结束后才允许开始，不满足就顺延。
  const runDependencyPass = (): boolean => {
    let moved = false;
    work.forEach((entry) => {
      entry.cue.dependsOn.forEach((depId) => {
        const dep = work.get(depId);
        if (!dep) return; // 失效引用由检查面板单独标记
        const need = absEnd(dep) - startSeconds(entry.scene.startTime);
        if (entry.offset < need - EPSILON) {
          const reason = `跟随前置「${dep.cue.title}」顺延`;
          if (strategy === 'shift-segment')
            shiftSegment(
              entry.scene,
              indexOf(entry),
              need - entry.offset,
              reason,
            );
          else shiftCue(entry, need - entry.offset, reason);
          settleScene(entry.scene, indexOf(entry) + 1);
          moved = true;
        }
      });
    });
    return moved;
  };

  const propagateDependencies = (): void => {
    let moved = true;
    let guard = 0;
    while (moved && guard < MAX_PASSES) {
      moved = runDependencyPass();
      guard += 1;
    }
  };

  const buildWindows = (): ResourceWindow[] =>
    [...work.values()].map((entry) => ({
      cueId: entry.cue.id,
      sceneId: entry.scene.id,
      title: entry.cue.title,
      start: absStart(entry) - PREP_WINDOW_SECONDS,
      end: absEnd(entry),
      props: entry.cue.props,
      cast: entry.cue.cast,
    }));

  // 1. 目标提示时长生效，先恢复本场衔接。
  target.duration = plan.durationAfter;
  settleScene(scene, indexOf(work.get(cueId)!) + 1);

  // 2. 沿前置关系传播到其它场。
  propagateDependencies();

  // 3. 跨场资源准备窗口冲突：尝试把较晚的一方顺延，锚点挡住就记为未解决。
  const unresolvedPairs = new Set<string>();
  for (let iteration = 0; iteration < MAX_PASSES; iteration += 1) {
    const conflicts = collectResourceConflicts(buildWindows()).filter(
      (conflict) =>
        !unresolvedPairs.has(
          `${conflict.kind}:${[conflict.a.cueId, conflict.b.cueId].sort().join('|')}`,
        ),
    );
    const conflict = conflicts[0];
    if (!conflict) break;
    const key = `${conflict.kind}:${[conflict.a.cueId, conflict.b.cueId].sort().join('|')}`;
    const [earlier, later] =
      conflict.a.start <= conflict.b.start
        ? [conflict.a, conflict.b]
        : [conflict.b, conflict.a];
    const mover = work.get(later.cueId)!;
    const reason = `避开与「${earlier.title}」的${conflict.kind}冲突（${conflict.shared.join('、')}）`;
    const needOffset =
      absEnd(work.get(earlier.cueId)!) +
      PREP_WINDOW_SECONDS -
      startSeconds(mover.scene.startTime);
    const delta = needOffset - mover.offset;
    const moved =
      delta > EPSILON &&
      (strategy === 'shift-segment'
        ? shiftSegment(mover.scene, indexOf(mover), delta, reason)
        : shiftCue(mover, delta, reason));
    if (!moved) {
      unresolvedPairs.add(key);
      plan.conflicts.push({
        id: `conflict-${key}`,
        cueId: later.cueId,
        otherCueId: earlier.cueId,
        title: later.title,
        otherTitle: earlier.title,
        kind: conflict.kind,
        shared: conflict.shared,
        detail: `「${later.title}」与「${earlier.title}」的${conflict.kind}准备窗口重叠（${conflict.shared.join(
          '、',
        )}），需要顺延的一方被锚点或循环挡住`,
      });
      continue;
    }
    settleScene(mover.scene, indexOf(mover) + 1);
    propagateDependencies();
  }

  // 4. 兜底：把传播步数耗尽后仍存在的资源冲突也记入方案。
  collectResourceConflicts(buildWindows()).forEach((conflict) => {
    const key = `${conflict.kind}:${[conflict.a.cueId, conflict.b.cueId].sort().join('|')}`;
    if (unresolvedPairs.has(key)) return;
    plan.conflicts.push({
      id: `conflict-${key}`,
      cueId: conflict.b.cueId,
      otherCueId: conflict.a.cueId,
      title: conflict.b.title,
      otherTitle: conflict.a.title,
      kind: conflict.kind,
      shared: conflict.shared,
      detail: `「${conflict.b.title}」与「${conflict.a.title}」的${conflict.kind}准备窗口重叠（${conflict.shared.join(
        '、',
      )}），自动重排未能在有限步数内解决`,
    });
  });

  // 5. 汇总移动与校验结果。
  work.forEach((entry, id) => {
    const before = original.get(id) ?? 0;
    plan.offsets[id] = entry.offset;
    if (Math.abs(entry.offset - before) > EPSILON) {
      plan.moves.push({
        cueId: id,
        sceneId: entry.scene.id,
        sceneLabel: sceneLabel(entry.scene),
        title: entry.cue.title,
        beforeOffset: before,
        afterOffset: entry.offset,
        reasons: [...(moveReasons.get(id) ?? new Set<string>())],
      });
    }
  });
  plan.blocked = [...blockedBy.values()];

  data.scenes.forEach((item) =>
    item.cues.forEach(
      (cue) => (cue.offset = plan.offsets[cue.id] ?? cue.offset),
    ),
  );
  plan.violations = validateShow(data, { includeResources: false });
  plan.applicable =
    !plan.cycles.length &&
    !plan.blocked.length &&
    !plan.conflicts.length &&
    !plan.violations.length;
  return plan;
}
