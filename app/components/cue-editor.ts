import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import type {
  Cue,
  CueDraft,
  CueIssue,
  CueKind,
  RehearsalRevision,
  RescheduleStrategy,
  Scene,
  ShowData,
  VersionDiff,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';
import {
  CUE_KINDS,
  OWNERS,
  STRATEGY_LABELS,
} from 'stage-cue-editor/models/show';
import {
  buildReschedulePlan,
  collectResourceConflicts,
  findCycles,
  resourceWindows,
  startSeconds,
  timeLabel,
  validateShow,
} from 'stage-cue-editor/utils/reschedule';
import type { ReschedulePlan } from 'stage-cue-editor/utils/reschedule';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function cue(
  id: string,
  kind: CueKind,
  title: string,
  duration: number,
  owner: string,
  extra: Partial<Cue> = {},
): Cue {
  return {
    id,
    kind,
    title,
    duration,
    owner,
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

function initialShow(): ShowData {
  const scenes: Scene[] = [
    {
      id: 'scene-1',
      act: '第一幕',
      name: 'S1',
      title: '月下序场',
      startTime: '19:30',
      locked: false,
      cues: [
        cue('cue-light-1', '灯光', '观众席渐暗 · 面光起', 45, '李岚', {
          lighting: 'FOH 1 号面光 65%，侧光暖白 40%',
          notes: '开演铃后 10 秒执行',
        }),
        cue('cue-actor-1', '演员', '说书人自左台入场', 90, '赵一帆', {
          cast: ['说书人／周启'],
          props: ['折扇'],
          notes: '追光跟随；入场后停留台中',
        }),
        cue('cue-sound-1', '音响', '古琴引子淡入', 120, '陈默', {
          sound: 'Q1 古琴引子，-18dB 淡入 6 秒',
          dependsOn: ['cue-deleted-old'],
          notes: '旧版依赖保留用于检查示例',
        }),
        cue('cue-prop-1', '道具', '月牙灯升至舞台中线', 75, '孙禾', {
          props: ['月牙灯'],
          lighting: '顶排 3 号定点',
          anchor: true,
          notes: '与升降机械联动，固定锚点不可顺延',
        }),
        cue('cue-actor-fan', '演员', '说书人掷扇收篇', 30, '赵一帆', {
          cast: ['说书人／周启'],
          props: ['折扇'],
          dependsOn: ['cue-actor-1'],
        }),
      ],
    },
    {
      id: 'scene-2',
      act: '第一幕',
      name: 'S2',
      title: '宫门夜宴',
      startTime: '19:40',
      locked: false,
      cues: [
        cue('cue-stage-2', '舞台', '中景屏风换为朱红', 60, '', {
          dependsOn: ['cue-prop-1'],
          notes: '负责人尚未确认；待月牙灯就位后换景',
        }),
        cue('cue-prop-2', '道具', '折扇交还道具台', 40, '孙禾', {
          props: ['折扇'],
        }),
        cue('cue-actor-2', '演员', '群臣列队入场', 110, '赵一帆', {
          cast: ['群演 6 人', '侍女 4 人'],
          props: ['宫灯'],
          dependsOn: ['cue-stage-2'],
        }),
        cue('cue-light-2', '灯光', '暖金顶光覆盖后区', 80, '李岚', {
          lighting: '顶光 4、5 号 70%，色温 3200K',
          dependsOn: ['cue-actor-2'],
        }),
      ],
    },
  ];
  scenes.forEach((scene) => recalculateScene(scene));
  return {
    title: '《长夜行》首演提示表',
    venue: '实验剧场 A 厅',
    date: '2026-10-18',
    scenes,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeShow(show: ShowData): ShowData {
  show.scenes.forEach((scene) =>
    scene.cues.forEach((item) => {
      item.anchor = item.anchor ?? false;
      item.dependsOn = item.dependsOn ?? [];
      item.props = item.props ?? [];
      item.cast = item.cast ?? [];
    }),
  );
  return show;
}

interface StoredState {
  show: ShowData;
  versions: VersionSnapshot[];
  revisions: RehearsalRevision[];
}

function loadState(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error('empty');
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      show: parsed.show ? normalizeShow(parsed.show) : initialShow(),
      versions: parsed.versions ?? [],
      revisions: parsed.revisions ?? [],
    };
  } catch {
    return { show: initialShow(), versions: [], revisions: [] };
  }
}

function recalculateScene(scene: Scene): void {
  let elapsed = 0;
  scene.cues.forEach((item) => {
    item.offset = elapsed;
    elapsed += Number(item.duration) || 0;
  });
}

export default class CueEditorComponent extends Component {
  @tracked show: ShowData;
  @tracked versions: VersionSnapshot[];
  @tracked revisions: RehearsalRevision[];
  @tracked activeSceneId = '';
  @tracked selectedCueId = '';
  @tracked draft: CueDraft | null = null;
  @tracked compareVersionId = '';
  @tracked message = '';
  @tracked search = '';
  @tracked rescheduleInput = '';
  @tracked preview: {
    sceneId: string;
    cueId: string;
    duration: number;
  } | null = null;
  @tracked previewStrategy: RescheduleStrategy = 'shift-segment';
  @tracked previewFailed = false;

  private undoStack: ShowData[] = [];
  private redoStack: ShowData[] = [];
  private dragCueId = '';

  constructor(owner: unknown, args: Record<string, unknown>) {
    super(owner, args);
    const stored = loadState();
    this.show = stored.show;
    this.versions = stored.versions;
    this.revisions = stored.revisions;
    this.activeSceneId = this.show.scenes[0]?.id ?? '';
    this.selectedCueId = this.show.scenes[0]?.cues[0]?.id ?? '';
    window.addEventListener('keydown', this.handleKeyboard);
  }

  get activeScene(): Scene | undefined {
    return this.show.scenes.find((scene) => scene.id === this.activeSceneId);
  }

  get selectedCue(): Cue | undefined {
    return this.activeScene?.cues.find(
      (item) => item.id === this.selectedCueId,
    );
  }

  get cueRows() {
    if (!this.activeScene) return [];
    const knownIds = new Set(this.allCues.map((entry) => entry.cue.id));
    const scene = this.activeScene;
    return scene.cues.map((item, index) => ({
      ...item,
      index,
      start: timeLabel(scene, item.offset),
      end: timeLabel(scene, item.offset + item.duration),
      selected: item.id === this.selectedCueId,
      hasIssue: this.issues.some((issue) => issue.cueId === item.id),
      pending: item.dependsOn.some((reference) => !knownIds.has(reference)),
      kindClass:
        item.kind === '灯光'
          ? 'light'
          : item.kind === '音响'
            ? 'sound'
            : item.kind === '道具'
              ? 'prop'
              : item.kind === '演员'
                ? 'cast'
                : item.kind === '字幕'
                  ? 'caption'
                  : 'stage',
      propsLabel: item.props.join('、'),
      castLabel: item.cast.join('、'),
    }));
  }

  get sceneRows() {
    return this.show.scenes.map((scene) => ({
      ...scene,
      active: scene.id === this.activeSceneId,
      issueCount: this.issues.filter((issue) => issue.sceneId === scene.id)
        .length,
      duration: scene.cues.reduce((total, item) => total + item.duration, 0),
    }));
  }

  get cueKindOptions(): CueKind[] {
    return CUE_KINDS;
  }

  get ownerOptions(): string[] {
    return OWNERS;
  }

  get allCues(): Array<{ cue: Cue; scene: Scene }> {
    return this.show.scenes.flatMap((scene) =>
      scene.cues.map((item) => ({ cue: item, scene })),
    );
  }

  get issues(): CueIssue[] {
    const issues: CueIssue[] = [];
    const cueIndex = new Map(
      this.allCues.map((entry) => [entry.cue.id, entry]),
    );
    this.allCues.forEach(({ cue: item, scene }) => {
      const cueStart = startSeconds(scene.startTime) + item.offset;
      if (!item.owner) {
        issues.push({
          id: `owner-${item.id}`,
          severity: 'error',
          title: '负责人空缺',
          detail: `${scene.act} ${scene.name}「${item.title}」尚未指定负责人。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
      item.dependsOn.forEach((reference) => {
        const dep = cueIndex.get(reference);
        if (!dep) {
          issues.push({
            id: `ref-${item.id}-${reference}`,
            severity: 'error',
            title: '待处理 · 引用的提示已删除',
            detail: `「${item.title}」仍依赖已删除的提示 ${reference}，请清理前置或恢复该提示。`,
            sceneId: scene.id,
            cueId: item.id,
          });
        } else {
          const depEnd =
            startSeconds(dep.scene.startTime) +
            dep.cue.offset +
            dep.cue.duration;
          if (cueStart < depEnd) {
            issues.push({
              id: `dep-${item.id}-${reference}`,
              severity: 'error',
              title: '前置提示尚未结束',
              detail: `「${item.title}」在前置提示「${dep.cue.title}」结束前开始。`,
              sceneId: scene.id,
              cueId: item.id,
            });
          }
        }
      });
      const previous = scene.cues[scene.cues.indexOf(item) - 1];
      if (previous && item.offset < previous.offset + previous.duration) {
        issues.push({
          id: `overlap-${item.id}`,
          severity: 'error',
          title: '同场时间冲突',
          detail: `「${item.title}」与上一条提示重叠。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
    });

    findCycles(this.show).forEach((chain, index) => {
      const titles = chain
        .map((id) => cueIndex.get(id)?.cue.title ?? id)
        .join(' → ');
      issues.push({
        id: `cycle-${index}`,
        severity: 'error',
        title: '循环依赖',
        detail: `前置关系形成循环：${titles}。重排预演会在循环处停住。`,
        cueId: chain[0],
      });
    });

    collectResourceConflicts(resourceWindows(this.show)).forEach((conflict) => {
      issues.push({
        id: `res-${conflict.kind}-${conflict.a.cueId}-${conflict.b.cueId}`,
        severity: 'warning',
        title: `${conflict.kind}准备窗口撞场`,
        detail: `「${conflict.a.title}」与「${conflict.b.title}」的准备窗口重叠：${conflict.shared.join('、')}。`,
        sceneId: conflict.b.sceneId,
        cueId: conflict.b.cueId,
      });
    });
    return issues.map((issue) => ({
      ...issue,
      icon: issue.severity === 'error' ? '!' : 'i',
    }));
  }

  get selectedProps(): string {
    return this.selectedCue?.props.join('、') ?? '';
  }

  get selectedCast(): string {
    return this.selectedCue?.cast.join('、') ?? '';
  }

  get errors(): number {
    return this.issues.filter((issue) => issue.severity === 'error').length;
  }

  get compareVersion(): VersionSnapshot | undefined {
    return this.versions.find(
      (version) => version.id === this.compareVersionId,
    );
  }

  get versionDiff(): VersionDiff[] {
    const version = this.compareVersion;
    if (!version) return [];
    const collect = (data: ShowData) =>
      data.scenes.flatMap((scene) =>
        scene.cues.map((item, index) => ({ cue: item, scene, index })),
      );
    const position = (entry: { scene: Scene; index: number }) =>
      `${entry.scene.name} · 第 ${entry.index + 1} 位`;
    const beforeEntries = collect(version.data);
    const afterEntries = collect(this.show);
    const beforeMap = new Map(
      beforeEntries.map((entry) => [entry.cue.id, entry]),
    );
    const afterMap = new Map(
      afterEntries.map((entry) => [entry.cue.id, entry]),
    );
    const diffs: VersionDiff[] = [];
    beforeEntries.forEach((before) => {
      const after = afterMap.get(before.cue.id);
      if (!after) {
        diffs.push({
          id: before.cue.id,
          changed: true,
          label: `${before.scene.name} · ${before.cue.title}`,
          owner: before.cue.owner || '未指定',
          duration: `${before.cue.duration} 秒`,
          flow: '已移除',
        });
        return;
      }
      const ownerChanged = before.cue.owner !== after.cue.owner;
      const durationChanged = before.cue.duration !== after.cue.duration;
      const flowChanged =
        before.scene.id !== after.scene.id || before.index !== after.index;
      diffs.push({
        id: before.cue.id,
        changed: ownerChanged || durationChanged || flowChanged,
        label: `${after.scene.name} · ${after.cue.title}`,
        owner: ownerChanged
          ? `${before.cue.owner || '未指定'} → ${after.cue.owner || '未指定'}`
          : after.cue.owner || '未指定',
        duration: durationChanged
          ? `${before.cue.duration} 秒 → ${after.cue.duration} 秒`
          : `${after.cue.duration} 秒`,
        flow: flowChanged
          ? `${position(before)} → ${position(after)}`
          : position(after),
      });
    });
    afterEntries.forEach((after) => {
      if (beforeMap.has(after.cue.id)) return;
      diffs.push({
        id: after.cue.id,
        changed: true,
        label: `${after.scene.name} · ${after.cue.title}`,
        owner: after.cue.owner || '未指定',
        duration: `${after.cue.duration} 秒`,
        flow: `新增 · ${position(after)}`,
      });
    });
    return diffs;
  }

  get filteredScenes() {
    const term = this.search.trim().toLowerCase();
    return this.sceneRows.filter(
      (scene) =>
        !term ||
        `${scene.act}${scene.name}${scene.title}`.toLowerCase().includes(term),
    );
  }

  get previewPlan(): ReschedulePlan | null {
    if (!this.preview) return null;
    return buildReschedulePlan(
      this.show,
      this.preview.sceneId,
      this.preview.cueId,
      this.preview.duration,
      this.previewStrategy,
    );
  }

  get previewDelta(): number {
    const plan = this.previewPlan;
    return plan ? plan.durationAfter - plan.durationBefore : 0;
  }

  get previewDeltaLabel(): string {
    const delta = this.previewDelta;
    return `${delta > 0 ? '+' : ''}${delta} 秒`;
  }

  get isShiftStrategy(): boolean {
    return this.previewStrategy === 'shift-segment';
  }

  get previewStrategyLabel(): string {
    return STRATEGY_LABELS[this.previewStrategy];
  }

  get previewMoveRows() {
    const plan = this.previewPlan;
    if (!plan) return [];
    return plan.moves.map((move) => {
      const scene = this.show.scenes.find((item) => item.id === move.sceneId);
      return {
        ...move,
        before: scene ? timeLabel(scene, move.beforeOffset) : '—',
        after: scene ? timeLabel(scene, move.afterOffset) : '—',
        reason: move.reasons.join('；'),
      };
    });
  }

  get previewBlockedRows() {
    const plan = this.previewPlan;
    if (!plan) return [];
    return plan.blocked.map((block) => {
      const scene = this.show.scenes.find((item) => item.id === block.sceneId);
      return {
        ...block,
        kept: scene ? timeLabel(scene, block.keptOffset) : '—',
      };
    });
  }

  get previewCycleRows(): string[] {
    const plan = this.previewPlan;
    if (!plan) return [];
    const titles = new Map(
      this.allCues.map((entry) => [entry.cue.id, entry.cue.title]),
    );
    return plan.cycles.map((chain) =>
      chain.map((id) => titles.get(id) ?? id).join(' → '),
    );
  }

  get previewBlockerCount(): number {
    const plan = this.previewPlan;
    if (!plan) return 0;
    return (
      plan.cycles.length +
      plan.blocked.length +
      plan.conflicts.length +
      plan.violations.length
    );
  }

  get revisionRows() {
    return this.revisions.map((revision) => ({
      ...revision,
      summary: `「${revision.cueTitle}」${revision.durationBefore} → ${revision.durationAfter} 秒`,
      strategyLabel: STRATEGY_LABELS[revision.strategy],
      createdLabel: new Date(revision.createdAt).toLocaleString('zh-CN', {
        hour12: false,
      }),
    }));
  }

  @action
  selectScene(id: string): void {
    this.activeSceneId = id;
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
    this.draft = null;
    this.rescheduleInput = '';
    this.cancelPreview();
  }

  @action
  selectCue(id: string): void {
    this.selectedCueId = id;
    this.draft = null;
    this.rescheduleInput = '';
  }

  @action
  updateShowTitle(value: string): void {
    this.mutate((show) => {
      show.title = value;
    });
  }

  @action
  createCueDraft(kind: CueKind = '灯光'): void {
    if (this.activeScene?.locked) {
      this.notify('该场次已锁定，请先建立修订');
      return;
    }
    this.draft = {
      kind,
      title: '',
      duration: 60,
      owner: '',
      lighting: '',
      sound: '',
      props: '',
      cast: '',
      notes: '',
      dependsOn: '',
    };
  }

  @action
  cancelDraft(): void {
    this.draft = null;
  }

  @action
  editSelectedCue(): void {
    const item = this.selectedCue;
    if (!item || this.activeScene?.locked) return;
    this.draft = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      duration: item.duration,
      owner: item.owner,
      lighting: item.lighting,
      sound: item.sound,
      props: item.props.join('、'),
      cast: item.cast.join('、'),
      notes: item.notes,
      dependsOn: item.dependsOn.join('、'),
    };
  }

  @action
  updateDraft<K extends keyof CueDraft>(field: K, value: CueDraft[K]): void {
    if (this.draft) this.draft = { ...this.draft, [field]: value };
  }

  @action
  saveDraft(): void {
    if (
      !this.draft ||
      !this.draft.title.trim() ||
      !this.activeScene ||
      this.activeScene.locked
    )
      return;
    const draft = this.draft;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene) return;
      const existing = draft.id
        ? scene.cues.find((item) => item.id === draft.id)
        : undefined;
      const saved: Cue = {
        id: draft.id ?? uid('cue'),
        kind: draft.kind,
        title: draft.title.trim(),
        duration: Math.max(1, Number(draft.duration) || 1),
        owner: draft.owner,
        lighting: draft.lighting,
        sound: draft.sound,
        props: draft.props
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        cast: draft.cast
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        notes: draft.notes,
        dependsOn: draft.dependsOn
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        offset: existing?.offset ?? 0,
        anchor: existing?.anchor ?? false,
      };
      const index = scene.cues.findIndex((item) => item.id === saved.id);
      if (index >= 0) scene.cues.splice(index, 1, saved);
      else scene.cues.push(saved);
      recalculateScene(scene);
      this.selectedCueId = saved.id;
    });
    this.draft = null;
  }

  @action
  removeCue(id: string): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene || scene.locked) return;
      scene.cues = scene.cues.filter((item) => item.id !== id);
      recalculateScene(scene);
    });
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
  }

  @action
  addScene(): void {
    const scene: Scene = {
      id: uid('scene'),
      act: `第${this.show.scenes.length + 1}幕`,
      name: `S${this.show.scenes.length + 1}`,
      title: '未命名场次',
      startTime: '20:00',
      locked: false,
      cues: [],
    };
    this.mutate((show) => show.scenes.push(scene));
    this.activeSceneId = scene.id;
    this.selectedCueId = '';
  }

  @action
  copyPreviousScene(): void {
    const index = this.show.scenes.findIndex(
      (scene) => scene.id === this.activeSceneId,
    );
    const previous = this.show.scenes[index - 1];
    if (!previous) {
      this.notify('当前已是第一场');
      return;
    }
    const copied: Scene = clone(previous);
    copied.id = uid('scene');
    copied.act = this.activeScene?.act ?? copied.act;
    copied.name = `${copied.name}-副本`;
    copied.title = `${copied.title}（复制）`;
    copied.cues = copied.cues.map((item) => ({
      ...item,
      id: uid('cue'),
      dependsOn: [],
    }));
    recalculateScene(copied);
    this.mutate((show) => show.scenes.splice(index + 1, 0, copied));
    this.activeSceneId = copied.id;
    this.selectedCueId = copied.cues[0]?.id ?? '';
    this.notify('已复制上一场流程');
  }

  @action
  updateSceneField(
    field: 'title' | 'startTime' | 'act' | 'name',
    value: string,
  ): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (scene && !scene.locked) scene[field] = value;
    });
  }

  @action
  updateSelectedField(field: keyof Cue, value: unknown): void {
    const id = this.selectedCueId;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      const item = scene?.cues.find((entry) => entry.id === id);
      if (!scene || !item || scene.locked) return;
      if (field === 'duration') item.duration = Math.max(1, Number(value) || 1);
      else if (field === 'props' || field === 'cast')
        item[field] = String(value)
          .split(/[、,，]/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      else Object.assign(item, { [field]: value });
      recalculateScene(scene);
    });
  }

  @action
  toggleSelectedAnchor(): void {
    const item = this.selectedCue;
    if (!item || this.activeScene?.locked) return;
    const willAnchor = !item.anchor;
    this.mutate((show) => {
      const scene = show.scenes.find(
        (entry) => entry.id === this.activeSceneId,
      );
      const target = scene?.cues.find((entry) => entry.id === item.id);
      if (!scene || !target || scene.locked) return;
      target.anchor = willAnchor;
    });
    this.notify(
      willAnchor ? '已设为固定锚点，重排传播将在此停住' : '已取消固定锚点',
    );
  }

  @action
  setRescheduleInput(value: string): void {
    this.rescheduleInput = value;
  }

  @action
  startReschedule(): void {
    const item = this.selectedCue;
    const scene = this.activeScene;
    if (!item || !scene) return;
    if (scene.locked) {
      this.notify('本场已锁定，请先建立修订再重排');
      return;
    }
    const duration = Math.round(Number(this.rescheduleInput));
    if (!Number.isFinite(duration) || duration < 1) {
      this.notify('请输入有效的新时长（秒）');
      return;
    }
    if (duration === item.duration) {
      this.notify('新时长与当前时长相同');
      return;
    }
    this.preview = { sceneId: scene.id, cueId: item.id, duration };
    this.previewStrategy = 'shift-segment';
    this.previewFailed = false;
  }

  @action
  selectPreviewStrategy(strategy: RescheduleStrategy): void {
    this.previewStrategy = strategy;
    this.previewFailed = false;
  }

  @action
  cancelPreview(): void {
    this.preview = null;
    this.previewFailed = false;
  }

  @action
  applyPreview(): void {
    const preview = this.preview;
    const plan = this.previewPlan;
    if (!preview || !plan) return;
    const scene = this.show.scenes.find((item) => item.id === preview.sceneId);
    if (!scene || scene.locked) {
      this.notify('场次已锁定，无法应用重排');
      return;
    }
    const before = clone(this.show);
    const next = clone(this.show);
    const target = next.scenes
      .find((item) => item.id === preview.sceneId)
      ?.cues.find((item) => item.id === preview.cueId);
    if (!target) return;
    target.duration = plan.durationAfter;
    next.scenes.forEach((item) =>
      item.cues.forEach((entry) => {
        const offset = plan.offsets[entry.id];
        if (typeof offset === 'number') entry.offset = offset;
      }),
    );
    const problems = validateShow(next);
    if (!plan.applicable || problems.length) {
      // 应用失败：恢复改前状态，冲突原因保留在预演面板中
      this.show = before;
      this.previewFailed = true;
      this.notify('应用失败，已恢复改前状态');
      return;
    }
    this.commit(next);
    const revision: RehearsalRevision = {
      id: uid('revision'),
      createdAt: new Date().toISOString(),
      cueId: plan.cueId,
      cueTitle: plan.title,
      sceneLabel: `${scene.act} ${scene.name}`,
      strategy: plan.strategy,
      durationBefore: plan.durationBefore,
      durationAfter: plan.durationAfter,
      moves: plan.moves.map((move) => ({
        cueId: move.cueId,
        title: move.title,
        beforeOffset: move.beforeOffset,
        afterOffset: move.afterOffset,
      })),
    };
    this.revisions = [revision, ...this.revisions];
    this.persist();
    this.preview = null;
    this.previewFailed = false;
    this.rescheduleInput = '';
    this.notify(
      `重排已应用，排练修订已记录（${STRATEGY_LABELS[plan.strategy]}）`,
    );
  }

  @action
  moveSelected(direction: -1 | 1): void {
    const cues = this.activeScene?.cues ?? [];
    const from = cues.findIndex((item) => item.id === this.selectedCueId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= cues.length) return;
    this.moveCue(cues[from]!.id, cues[to]!.id);
  }

  @action
  startDrag(id: string): void {
    this.dragCueId = id;
  }

  @action
  allowDrop(event: DragEvent): boolean {
    event.preventDefault();
    return false;
  }

  @action
  dropOn(id: string): void {
    if (this.dragCueId) this.moveCue(this.dragCueId, id);
    this.dragCueId = '';
  }

  @action
  moveCue(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene || scene.locked) return;
      const from = scene.cues.findIndex((item) => item.id === sourceId);
      const to = scene.cues.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = scene.cues.splice(from, 1);
      scene.cues.splice(to, 0, moved!);
      recalculateScene(scene);
    });
    this.selectedCueId = sourceId;
    this.notify('顺序已更新，后续提示时间自动顺延');
  }

  @action
  lockVersion(): void {
    const snapshot: VersionSnapshot = {
      id: uid('version'),
      name: `锁定版 ${this.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      data: clone(this.show),
    };
    this.versions = [snapshot, ...this.versions];
    this.compareVersionId = snapshot.id;
    this.persist();
    this.notify('已锁定当前版本（只读）');
  }

  @action
  createRevision(): void {
    this.mutate((show) =>
      show.scenes.forEach((scene) => {
        scene.locked = false;
      }),
    );
    this.notify('已从当前锁定版建立可编辑修订');
  }

  @action
  toggleSceneLock(): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (scene) scene.locked = !scene.locked;
    });
  }

  @action
  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.show));
    this.show = previous;
    this.ensureSelection();
    this.persist();
  }

  @action
  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.show));
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  @action
  setSearch(value: string): void {
    this.search = value;
  }

  @action
  selectCompareVersion(version: VersionSnapshot): void {
    this.compareVersionId = version.id;
  }

  willDestroy(): void {
    super.willDestroy();
    window.removeEventListener('keydown', this.handleKeyboard);
  }

  private mutate(mutator: (show: ShowData) => void): void {
    const next = clone(this.show);
    mutator(next);
    this.commit(next);
  }

  private commit(next: ShowData): void {
    this.undoStack.push(clone(this.show));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    next.updatedAt = new Date().toISOString();
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  private ensureSelection(): void {
    if (!this.show.scenes.some((scene) => scene.id === this.activeSceneId))
      this.activeSceneId = this.show.scenes[0]?.id ?? '';
    if (!this.activeScene?.cues.some((item) => item.id === this.selectedCueId))
      this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
  }

  private persist(): void {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        show: this.show,
        versions: this.versions,
        revisions: this.revisions,
      }),
    );
  }

  private notify(value: string): void {
    this.message = value;
    window.setTimeout(() => {
      if (this.message === value) this.message = '';
    }, 2200);
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const inEditor =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.tagName === 'SELECT';
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (inEditor) return;
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelected(-1);
    } else if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveSelected(1);
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      this.createCueDraft();
    }
  };
}
