import type {
  Cue,
  ReplanApplyResult,
  ReplanMove,
  ReplanPreview,
  ReplanStop,
  ReplanStopKind,
  ReplanStrategy,
  Scene,
  ShowData,
} from 'stage-cue-editor/models/show';

/** 跨场演员/道具的准备窗口（秒）：同一资源两次使用间隔不足即视为撞场 */
export const PREP_BUFFER_SECONDS = 60;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function startSeconds(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 3600 + Number(minute) * 60;
}

export function clockLabel(totalSeconds: number): string {
  const total = ((Math.round(totalSeconds) % 86400) + 86400) % 86400;
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function timeLabel(startTime: string, offset: number): string {
  return clockLabel(startSeconds(startTime) + offset);
}

export function sceneLabel(scene: Scene): string {
  return `${scene.act} ${scene.name}`;
}

interface CueNode {
  cue: Cue;
  scene: Scene;
}

interface Edge {
  from: string;
  to: string;
}

interface Graph {
  nodes: Map<string, CueNode>;
  edges: Edge[];
  successors: Map<string, string[]>;
  predecessors: Map<string, string[]>;
  /** 循环成员 → 所在循环的全部成员标题 */
  cycleOf: Map<string, string[]>;
  sceneOrder: Map<string, number>;
}

interface Schedule {
  original: Map<string, number>;
  offsets: Map<string, number>;
  durations: Map<string, number>;
}

function buildGraph(show: ShowData): Graph {
  const nodes = new Map<string, CueNode>();
  const sceneOrder = new Map<string, number>();
  show.scenes.forEach((scene, index) => {
    sceneOrder.set(scene.id, index);
    scene.cues.forEach((cue) => nodes.set(cue.id, { cue, scene }));
  });

  const seen = new Set<string>();
  const edges: Edge[] = [];
  const push = (from: string, to: string): void => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  };
  show.scenes.forEach((scene) => {
    scene.cues.forEach((cue, index) => {
      const previous = scene.cues[index - 1];
      // 同场顺序本身就是前置关系：后一条不得早于前一条结束
      if (previous) push(previous.id, cue.id);
      cue.dependsOn.forEach((dep) => push(dep, cue.id));
    });
  });

  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  edges.forEach(({ from, to }) => {
    successors.set(from, [...(successors.get(from) ?? []), to]);
    predecessors.set(to, [...(predecessors.get(to) ?? []), from]);
  });

  return {
    nodes,
    edges,
    successors,
    predecessors,
    cycleOf: findCycles(nodes, edges),
    sceneOrder,
  };
}

/** Tarjan 强连通分量：分量大于 1 或存在自环即循环依赖 */
function findCycles(
  nodes: Map<string, CueNode>,
  edges: Edge[],
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  edges.forEach(({ from, to }) =>
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]),
  );

  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result = new Map<string, string[]>();
  let counter = 0;

  const strongConnect = (root: string): void => {
    indexOf.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    (adjacency.get(root) ?? []).forEach((next) => {
      if (!indexOf.has(next)) {
        strongConnect(next);
        lowLink.set(root, Math.min(lowLink.get(root)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(root, Math.min(lowLink.get(root)!, indexOf.get(next)!));
      }
    });
    if (lowLink.get(root) !== indexOf.get(root)) return;
    const members: string[] = [];
    let member = '';
    do {
      member = stack.pop()!;
      onStack.delete(member);
      members.push(member);
    } while (member !== root);
    const isCycle =
      members.length > 1 || (adjacency.get(root) ?? []).includes(root);
    if (!isCycle) return;
    const titles = members.map((id) => nodes.get(id)?.cue.title ?? id).sort();
    members.forEach((id) => result.set(id, titles));
  };

  nodes.forEach((_, id) => {
    if (!indexOf.has(id)) strongConnect(id);
  });
  return result;
}

class Planner {
  readonly graph: Graph;
  readonly state: Schedule;
  readonly stops = new Map<string, ReplanStop>();
  readonly moves = new Map<string, ReplanMove>();
  private readonly changedId: string;

  constructor(show: ShowData, changedId: string, newDuration: number) {
    this.graph = buildGraph(show);
    this.changedId = changedId;
    const original = new Map<string, number>();
    const offsets = new Map<string, number>();
    const durations = new Map<string, number>();
    show.scenes.forEach((scene) =>
      scene.cues.forEach((cue) => {
        original.set(cue.id, cue.offset);
        offsets.set(cue.id, cue.offset);
        durations.set(cue.id, cue.duration);
      }),
    );
    durations.set(changedId, Math.max(1, Math.round(newDuration)));
    this.state = { original, offsets, durations };
  }

  startOf(id: string): number {
    const node = this.graph.nodes.get(id)!;
    return (
      startSeconds(node.scene.startTime) + (this.state.offsets.get(id) ?? 0)
    );
  }

  endOf(id: string): number {
    return this.startOf(id) + (this.state.durations.get(id) ?? 0);
  }

  /** 沿前置关系（显式 dependsOn + 同场顺序）传播，遇停住项记录原因 */
  runPropagation(): void {
    this.propagate();
    this.checkChangedCueResources();
  }

  /** 按策略消解跨场资源冲突；返回 false 表示无法自动消解 */
  resolveResourceStops(strategy: ReplanStrategy): boolean {
    let guard = 0;
    while (guard < 60) {
      guard += 1;
      this.sweepResourceConflicts();
      const stop = [...this.stops.values()].find(
        (item) => item.kind === 'resource',
      );
      if (!stop) return true;
      if (!this.relocate(stop.cueId, strategy)) return false;
      this.propagate();
    }
    const first = [...this.stops.values()].find(
      (item) => item.kind === 'resource',
    );
    if (first) first.detail = `${first.detail}（自动消解次数超限）`;
    return false;
  }

  /** 校验最终排程：前置约束、跨场资源窗口；只检查本次波及到的提示 */
  validate(): ReplanStop[] {
    const touched = new Set([...this.moves.keys(), this.changedId]);
    const problems: ReplanStop[] = [];
    this.graph.edges.forEach(({ from, to }) => {
      if (!touched.has(from) && !touched.has(to)) return;
      if (this.startOf(to) >= this.endOf(from)) return;
      const node = this.graph.nodes.get(to)!;
      const fromTitle = this.graph.nodes.get(from)?.cue.title ?? from;
      const existing = this.stops.get(to);
      const kind: ReplanStopKind =
        existing?.kind ??
        (node.cue.anchor
          ? 'anchor'
          : node.scene.locked
            ? 'locked'
            : this.graph.cycleOf.has(to)
              ? 'cycle'
              : 'resource');
      problems.push(
        this.makeStop(
          to,
          kind,
          `前置「${fromTitle}」结束于 ${clockLabel(this.endOf(from))}，但「${node.cue.title}」保留在 ${clockLabel(this.startOf(to))}，无法同时满足。`,
        ),
      );
    });
    const ids = [...touched];
    ids.forEach((id) => {
      const conflicts = this.resourceConflicts(id, this.startOf(id));
      if (!conflicts.resources.length) return;
      problems.push(
        this.makeStop(
          id,
          'resource',
          `与 ${conflicts.others.map((other) => `「${other.cue.title}」`).join('、')} 共用 ${conflicts.resources.join('、')}，撞场未消解。`,
          {
            resources: conflicts.resources,
            relatedCueTitles: conflicts.others.map((other) => other.cue.title),
          },
        ),
      );
    });
    return problems;
  }

  sortedMoves(): ReplanMove[] {
    return [...this.moves.values()].sort((left, right) => {
      const sceneDiff =
        (this.graph.sceneOrder.get(left.sceneId) ?? 0) -
        (this.graph.sceneOrder.get(right.sceneId) ?? 0);
      return sceneDiff !== 0 ? sceneDiff : left.afterOffset - right.afterOffset;
    });
  }

  stopList(): ReplanStop[] {
    return [...this.stops.values()];
  }

  private propagate(): void {
    let changed = true;
    let guard = 0;
    const cap = this.graph.nodes.size * this.graph.nodes.size + 10;
    while (changed && guard < cap) {
      changed = false;
      guard += 1;
      this.graph.edges.forEach(({ from, to }) => {
        const needed = this.endOf(from);
        if (this.startOf(to) >= needed) return;
        const fromTitle = this.graph.nodes.get(from)?.cue.title ?? from;
        if (
          this.tryMove(
            to,
            needed,
            `前置「${fromTitle}」结束于 ${clockLabel(needed)}，顺延`,
          )
        )
          changed = true;
      });
    }
  }

  /** 尝试把提示移动到指定绝对时间；被锚点、循环、锁定或撞场挡住时记录保留原因 */
  private tryMove(id: string, neededAbsStart: number, cause: string): boolean {
    if (this.stops.has(id)) return false;
    const node = this.graph.nodes.get(id)!;
    const cycle = this.graph.cycleOf.get(id);
    if (cycle) {
      this.stops.set(
        id,
        this.makeStop(
          id,
          'cycle',
          `与 ${cycle.join('、')} 构成循环依赖，无法确定先后，保留原时间。`,
          { relatedCueTitles: cycle },
        ),
      );
      return false;
    }
    if (node.cue.anchor) {
      this.stops.set(
        id,
        this.makeStop(
          id,
          'anchor',
          `固定锚点，保留 ${clockLabel(this.startOf(id))} 不变。`,
        ),
      );
      return false;
    }
    if (node.scene.locked) {
      this.stops.set(
        id,
        this.makeStop(id, 'locked', '所在场次已锁定，保留原时间。'),
      );
      return false;
    }
    const newOffset = neededAbsStart - startSeconds(node.scene.startTime);
    if (newOffset < 0) {
      this.stops.set(
        id,
        this.makeStop(
          id,
          'scene-start',
          `需要早于本场开场 ${node.scene.startTime}，保留原时间。`,
        ),
      );
      return false;
    }
    const conflicts = this.resourceConflicts(id, neededAbsStart);
    if (conflicts.resources.length) {
      this.stops.set(
        id,
        this.makeStop(
          id,
          'resource',
          `与 ${conflicts.others.map((other) => `「${other.cue.title}」`).join('、')} 共用 ${conflicts.resources.join('、')}，准备窗口不足 ${PREP_BUFFER_SECONDS} 秒，保留原时间。`,
          {
            resources: conflicts.resources,
            relatedCueTitles: conflicts.others.map((other) => other.cue.title),
          },
        ),
      );
      return false;
    }
    this.state.offsets.set(id, newOffset);
    this.recordMove(id, newOffset, cause);
    return true;
  }

  /** 时长被调整的提示本身也可能撞上其他场的演员/道具 */
  private checkChangedCueResources(): void {
    const node = this.graph.nodes.get(this.changedId);
    if (!node) return;
    const conflicts = this.resourceConflicts(
      this.changedId,
      this.startOf(this.changedId),
    );
    conflicts.others.forEach((other) => {
      const otherId = other.cue.id;
      if (this.stops.has(otherId)) return;
      const shared = [
        ...other.cue.props.filter((value) => node.cue.props.includes(value)),
        ...other.cue.cast.filter((value) => node.cue.cast.includes(value)),
      ];
      const detail = `与调整时长的「${node.cue.title}」共用 ${shared.join('、')}，准备窗口不足 ${PREP_BUFFER_SECONDS} 秒，保留原时间。`;
      if (other.cue.anchor)
        this.stops.set(
          otherId,
          this.makeStop(otherId, 'anchor', `固定锚点；${detail}`),
        );
      else if (other.scene.locked)
        this.stops.set(
          otherId,
          this.makeStop(otherId, 'locked', `所在场次已锁定；${detail}`),
        );
      else if (this.graph.cycleOf.has(otherId)) {
        this.stops.set(
          otherId,
          this.makeStop(otherId, 'cycle', `处于循环依赖中；${detail}`),
        );
      } else {
        this.stops.set(
          otherId,
          this.makeStop(otherId, 'resource', detail, {
            resources: shared,
            relatedCueTitles: [node.cue.title],
          }),
        );
      }
    });
  }

  /** 扫描本次波及到的提示，把当前位置仍撞场的记为资源停住，等待策略消解；被调整时长的提示本身不重定位 */
  private sweepResourceConflicts(): void {
    const touched = new Set([...this.moves.keys(), this.changedId]);
    touched.forEach((id) => {
      if (id === this.changedId || this.stops.has(id)) return;
      const node = this.graph.nodes.get(id);
      if (
        !node ||
        node.cue.anchor ||
        node.scene.locked ||
        this.graph.cycleOf.has(id)
      )
        return;
      const conflicts = this.resourceConflicts(id, this.startOf(id));
      if (!conflicts.resources.length) return;
      this.stops.set(
        id,
        this.makeStop(
          id,
          'resource',
          `与 ${conflicts.others.map((other) => `「${other.cue.title}」`).join('、')} 共用 ${conflicts.resources.join('、')}，准备窗口不足 ${PREP_BUFFER_SECONDS} 秒，保留原时间。`,
          {
            resources: conflicts.resources,
            relatedCueTitles: conflicts.others.map((other) => other.cue.title),
          },
        ),
      );
    });
  }

  /** 按策略把撞场提示挪到最近的空档：顺延整段 = 下游整段一起顺移；只移动冲突项 = 仅挪本项 */
  private relocate(id: string, strategy: ReplanStrategy): boolean {
    const node = this.graph.nodes.get(id);
    if (!node) return false;
    if (node.cue.anchor || node.scene.locked || this.graph.cycleOf.has(id)) {
      this.stops.set(
        id,
        this.makeStop(
          id,
          node.cue.anchor ? 'anchor' : node.scene.locked ? 'locked' : 'cycle',
          '撞场项本身不可移动，无法自动消解。',
        ),
      );
      return false;
    }
    const sceneStart = startSeconds(node.scene.startTime);
    let position = Math.max(this.earliestStart(id), this.startOf(id));
    let guard = 0;
    for (;;) {
      const conflicts = this.resourceConflicts(id, position);
      if (!conflicts.resources.length) break;
      guard += 1;
      if (guard > 100) {
        this.stops.set(
          id,
          this.makeStop(id, 'resource', '找不到可用的空档，撞场无法自动消解。'),
        );
        return false;
      }
      position = Math.max(
        position + 1,
        ...conflicts.others.map(
          (other) => this.endOf(other.cue.id) + PREP_BUFFER_SECONDS,
        ),
      );
    }
    this.stops.delete(id);
    if (strategy === 'shift-section') {
      const delay = position - this.startOf(id);
      const closure = this.downstreamClosure(id);
      for (const memberId of closure) {
        if (memberId === id) continue;
        const member = this.graph.nodes.get(memberId)!;
        if (
          member.cue.anchor ||
          member.scene.locked ||
          this.graph.cycleOf.has(memberId)
        ) {
          const kind: ReplanStopKind = member.cue.anchor
            ? 'anchor'
            : member.scene.locked
              ? 'locked'
              : 'cycle';
          this.stops.set(
            memberId,
            this.makeStop(
              memberId,
              kind,
              `顺延整段需要一并移动「${member.cue.title}」，但它不可移动，整段保留原时间。`,
            ),
          );
          return false;
        }
      }
      closure.forEach((memberId) => {
        const after = (this.state.offsets.get(memberId) ?? 0) + delay;
        this.state.offsets.set(memberId, after);
        this.recordMove(memberId, after, '整段顺延，避让跨场共用资源');
      });
      return true;
    }
    const after = position - sceneStart;
    this.state.offsets.set(id, after);
    this.recordMove(id, after, '仅移动本项，避让跨场共用资源');
    return true;
  }

  private downstreamClosure(id: string): string[] {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const current = queue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      (this.graph.successors.get(current) ?? []).forEach((next) =>
        queue.push(next),
      );
    }
    return [...seen];
  }

  private earliestStart(id: string): number {
    return (this.graph.predecessors.get(id) ?? []).reduce(
      (max, pred) => Math.max(max, this.endOf(pred)),
      0,
    );
  }

  /** 跨场共用演员/道具且时间窗重叠或间隔小于准备窗口 */
  private resourceConflicts(
    id: string,
    absStart: number,
  ): { resources: string[]; others: CueNode[] } {
    const node = this.graph.nodes.get(id)!;
    const end = absStart + (this.state.durations.get(id) ?? 0);
    const resources = new Set<string>();
    const others: CueNode[] = [];
    this.graph.nodes.forEach((other, otherId) => {
      if (otherId === id || other.scene.id === node.scene.id) return;
      const shared = [
        ...node.cue.props.filter((value) => other.cue.props.includes(value)),
        ...node.cue.cast.filter((value) => other.cue.cast.includes(value)),
      ];
      if (!shared.length) return;
      const otherStart = this.startOf(otherId);
      const otherEnd = otherStart + (this.state.durations.get(otherId) ?? 0);
      if (
        absStart < otherEnd + PREP_BUFFER_SECONDS &&
        otherStart < end + PREP_BUFFER_SECONDS
      ) {
        shared.forEach((value) => resources.add(value));
        others.push(other);
      }
    });
    return { resources: [...resources], others };
  }

  private recordMove(id: string, afterOffset: number, cause: string): void {
    const node = this.graph.nodes.get(id)!;
    const existing = this.moves.get(id);
    if (existing) {
      existing.afterOffset = afterOffset;
      existing.cause = cause;
      return;
    }
    this.moves.set(id, {
      cueId: id,
      cueTitle: node.cue.title,
      sceneId: node.scene.id,
      sceneLabel: sceneLabel(node.scene),
      beforeOffset: this.state.original.get(id) ?? 0,
      afterOffset,
      cause,
    });
  }

  private makeStop(
    id: string,
    kind: ReplanStopKind,
    detail: string,
    extra: Partial<ReplanStop> = {},
  ): ReplanStop {
    const node = this.graph.nodes.get(id)!;
    return {
      cueId: id,
      cueTitle: node.cue.title,
      sceneId: node.scene.id,
      sceneLabel: sceneLabel(node.scene),
      kind,
      detail,
      ...extra,
    };
  }
}

function mergeStops(stops: ReplanStop[], problems: ReplanStop[]): ReplanStop[] {
  const merged = new Map<string, ReplanStop>();
  [...stops, ...problems].forEach((stop) =>
    merged.set(`${stop.cueId}:${stop.kind}`, stop),
  );
  return [...merged.values()];
}

/** 预演：只传播并列出受影响提示与保留时间的原因，不改动数据 */
export function previewReplan(
  show: ShowData,
  cueId: string,
  newDuration: number,
): ReplanPreview {
  const planner = new Planner(show, cueId, newDuration);
  planner.runPropagation();
  const node = planner.graph.nodes.get(cueId);
  const stops = planner.stopList();
  return {
    cueId,
    cueTitle: node?.cue.title ?? cueId,
    sceneLabel: node ? sceneLabel(node.scene) : '',
    beforeDuration: node?.cue.duration ?? 0,
    afterDuration: Math.max(1, Math.round(newDuration)),
    moves: planner.sortedMoves(),
    stops,
    hasCycle: stops.some((stop) => stop.kind === 'cycle'),
  };
}

/**
 * 应用重排：先传播，再按策略消解跨场资源冲突，最后整体校验。
 * 失败时返回保留的冲突原因，绝不改动传入的 show（由调用方恢复改前状态）。
 */
export function applyReplan(
  show: ShowData,
  cueId: string,
  newDuration: number,
  strategy: ReplanStrategy,
): ReplanApplyResult {
  const planner = new Planner(show, cueId, newDuration);
  planner.runPropagation();
  const hard = planner
    .stopList()
    .filter((stop) => stop.kind === 'cycle' || stop.kind === 'scene-start');
  if (hard.length) return { ok: false, moves: [], stops: planner.stopList() };
  if (!planner.resolveResourceStops(strategy))
    return { ok: false, moves: [], stops: planner.stopList() };
  const problems = planner.validate();
  if (problems.length)
    return {
      ok: false,
      moves: [],
      stops: mergeStops(planner.stopList(), problems),
    };

  const next = clone(show);
  next.scenes.forEach((scene) =>
    scene.cues.forEach((cue) => {
      cue.duration = planner.state.durations.get(cue.id) ?? cue.duration;
      cue.offset = planner.state.offsets.get(cue.id) ?? cue.offset;
    }),
  );
  next.updatedAt = new Date().toISOString();
  return {
    ok: true,
    show: next,
    moves: planner.sortedMoves(),
    stops: planner.stopList(),
  };
}
