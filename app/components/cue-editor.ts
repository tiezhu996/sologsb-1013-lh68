import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import type {
  Cue,
  CueDraft,
  CueIssue,
  CueKind,
  CueVersionDiff,
  RehearsalRevision,
  ReplanPreview,
  ReplanStop,
  ReplanStopKind,
  ReplanStrategy,
  Scene,
  ShowData,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';
import { CUE_KINDS, OWNERS } from 'stage-cue-editor/models/show';
import {
  applyReplan,
  previewReplan as buildPreview,
  startSeconds,
  timeLabel,
} from 'stage-cue-editor/utils/replanner';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const STOP_KIND_LABELS: Record<ReplanStopKind, string> = {
  cycle: '循环依赖',
  anchor: '固定锚点',
  resource: '资源冲突',
  locked: '场次锁定',
  'scene-start': '早于开场',
};

const STRATEGY_LABELS: Record<ReplanStrategy, string> = {
  'shift-section': '顺延整段',
  'move-conflicts': '只移动冲突项',
};

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
          dependsOn: ['cue-light-1'],
          notes: '追光跟随；入场后停留台中',
        }),
        cue('cue-sound-1', '音响', '古琴引子淡入', 120, '陈默', {
          sound: 'Q1 古琴引子，-18dB 淡入 6 秒',
          dependsOn: ['cue-light-1', 'cue-deleted-old'],
          notes: '旧版依赖保留用于检查示例',
        }),
        cue('cue-prop-1', '道具', '月牙灯升至舞台中线', 75, '孙禾', {
          props: ['月牙灯'],
          lighting: '顶排 3 号定点',
          anchor: true,
          notes: '机械定点升降，锚定不可顺延',
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
          notes: '负责人尚未确认',
        }),
        cue('cue-actor-2', '演员', '群臣列队入场', 110, '赵一帆', {
          cast: ['群演 6 人', '侍女 4 人'],
          props: ['宫灯'],
          dependsOn: ['cue-actor-1'],
        }),
        cue('cue-light-2', '灯光', '暖金顶光覆盖后区', 80, '李岚', {
          lighting: '顶光 4、5 号 70%，色温 3200K',
          props: ['月牙灯'],
          dependsOn: ['cue-stage-2'],
          notes: '与 S1 同一月牙灯，需跨场转运',
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

interface StoredState {
  show: ShowData;
  versions: VersionSnapshot[];
  revisions: RehearsalRevision[];
}

function loadStored(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error('empty');
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      show: parsed.show ?? initialShow(),
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

function overlaps(
  aStart: number,
  aDuration: number,
  bStart: number,
  bDuration: number,
): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

export default class CueEditorComponent extends Component {
  private static stored = loadStored();

  @tracked show: ShowData = CueEditorComponent.stored.show;
  @tracked versions: VersionSnapshot[] = CueEditorComponent.stored.versions;
  @tracked revisions: RehearsalRevision[] = CueEditorComponent.stored.revisions;
  @tracked activeSceneId = this.show.scenes[0]?.id ?? '';
  @tracked selectedCueId = this.show.scenes[0]?.cues[0]?.id ?? '';
  @tracked draft: CueDraft | null = null;
  @tracked compareVersionId = '';
  @tracked message = '';
  @tracked search = '';
  @tracked preview: ReplanPreview | null = null;
  @tracked previewError: ReplanStop[] = [];
  @tracked strategy: ReplanStrategy = 'shift-section';
  @tracked replanDurationInput: number | null = null;

  private undoStack: ShowData[] = [];
  private redoStack: ShowData[] = [];
  private dragCueId = '';

  constructor(owner: unknown, args: Record<string, unknown>) {
    super(owner, args);
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

  get existingCueIds(): Set<string> {
    return new Set(this.allCues.map((entry) => entry.cue.id));
  }

  get cueRows() {
    if (!this.activeScene) return [];
    const scene = this.activeScene;
    return scene.cues.map((item, index) => ({
      ...item,
      index,
      start: timeLabel(scene.startTime, item.offset),
      end: timeLabel(scene.startTime, item.offset + item.duration),
      selected: item.id === this.selectedCueId,
      anchored: Boolean(item.anchor),
      pendingRefs: item.dependsOn.filter(
        (ref) => !this.existingCueIds.has(ref),
      ),
      hasIssue: this.issues.some((issue) => issue.cueId === item.id),
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
    this.allCues.forEach(({ cue: item, scene }) => {
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
        if (!this.existingCueIds.has(reference)) {
          issues.push({
            id: `ref-${item.id}-${reference}`,
            severity: 'error',
            title: '待处理：提示被引用但已删除',
            detail: `「${item.title}」仍依赖已删除的提示 ${reference}。`,
            sceneId: scene.id,
            cueId: item.id,
          });
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

    const allCues = this.allCues;
    for (let index = 0; index < allCues.length; index += 1) {
      for (let next = index + 1; next < allCues.length; next += 1) {
        const left = allCues[index]!;
        const right = allCues[next]!;
        if (left.cue.id === right.cue.id || left.scene.id === right.scene.id)
          continue;
        const leftStart = startSeconds(left.scene.startTime) + left.cue.offset;
        const rightStart =
          startSeconds(right.scene.startTime) + right.cue.offset;
        if (
          !overlaps(
            leftStart,
            left.cue.duration,
            rightStart,
            right.cue.duration,
          )
        )
          continue;
        const sharedProps = left.cue.props.filter((value) =>
          right.cue.props.includes(value),
        );
        const sharedCast = left.cue.cast.filter((value) =>
          right.cue.cast.includes(value),
        );
        if (sharedProps.length) {
          issues.push({
            id: `prop-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '道具撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时使用：${sharedProps.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
        if (sharedCast.length) {
          issues.push({
            id: `cast-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '演员撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时需要：${sharedCast.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
      }
    }
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

  /** 与锁定版逐条比较：负责人、时长、流程（顺序与前置） */
  get versionDiff(): CueVersionDiff[] {
    const version = this.compareVersion;
    if (!version) return [];
    const collect = (data: ShowData) => {
      const map = new Map<string, { scene: Scene; cue: Cue; index: number }>();
      data.scenes.forEach((scene) =>
        scene.cues.forEach((item, index) =>
          map.set(item.id, { scene, cue: item, index }),
        ),
      );
      return map;
    };
    const flowLabel = (entry?: { cue: Cue; index: number }): string =>
      entry
        ? `第${entry.index + 1}条 · 前置${entry.cue.dependsOn.length}个`
        : '—';
    const before = collect(version.data);
    const after = collect(this.show);
    const ids = [
      ...before.keys(),
      ...[...after.keys()].filter((id) => !before.has(id)),
    ];
    return ids.map((id) => {
      const b = before.get(id);
      const a = after.get(id);
      const ownerBefore = b?.cue.owner || '未指定';
      const ownerAfter = a?.cue.owner || '未指定';
      const durationBefore = b ? `${b.cue.duration}s` : '—';
      const durationAfter = a ? `${a.cue.duration}s` : '—';
      const flowBefore = flowLabel(b);
      const flowAfter = flowLabel(a);
      const source = (a ?? b)!;
      return {
        id,
        sceneLabel: `${source.scene.act} ${source.scene.name}`,
        cueLabel: `${source.cue.kind} · ${source.cue.title}`,
        ownerBefore,
        ownerAfter,
        durationBefore,
        durationAfter,
        flowBefore,
        flowAfter,
        changed:
          !b ||
          !a ||
          ownerBefore !== ownerAfter ||
          durationBefore !== durationAfter ||
          flowBefore !== flowAfter,
        added: !b,
        removed: !a,
      };
    });
  }

  get filteredScenes() {
    const term = this.search.trim().toLowerCase();
    return this.sceneRows.filter(
      (scene) =>
        !term ||
        `${scene.act}${scene.name}${scene.title}`.toLowerCase().includes(term),
    );
  }

  get canReplan(): boolean {
    return Boolean(this.selectedCue) && !this.activeScene?.locked;
  }

  get replanDurationValue(): number {
    return this.replanDurationInput ?? this.selectedCue?.duration ?? 60;
  }

  get isShiftSection(): boolean {
    return this.strategy === 'shift-section';
  }

  get isMoveConflicts(): boolean {
    return this.strategy === 'move-conflicts';
  }

  get previewRows() {
    return (this.preview?.moves ?? []).map((move) => {
      const scene = this.show.scenes.find((item) => item.id === move.sceneId);
      return {
        ...move,
        beforeLabel: timeLabel(scene?.startTime ?? '00:00', move.beforeOffset),
        afterLabel: timeLabel(scene?.startTime ?? '00:00', move.afterOffset),
      };
    });
  }

  get previewStopRows() {
    return (this.preview?.stops ?? []).map((stop) => ({
      ...stop,
      kindLabel: STOP_KIND_LABELS[stop.kind],
    }));
  }

  get previewErrorRows() {
    return this.previewError.map((stop) => ({
      ...stop,
      kindLabel: STOP_KIND_LABELS[stop.kind],
    }));
  }

  get revisionRows() {
    return this.revisions.map((revision) => ({
      ...revision,
      strategyLabel: STRATEGY_LABELS[revision.strategy],
      timeLabel: revision.createdAt.slice(5, 16).replace('T', ' '),
    }));
  }

  @action
  selectScene(id: string): void {
    this.activeSceneId = id;
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
    this.draft = null;
    this.cancelReplanState();
  }

  @action
  selectCue(id: string): void {
    this.selectedCueId = id;
    this.draft = null;
    this.replanDurationInput = null;
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
    if (!this.draft || !this.draft.title.trim() || !this.activeScene) return;
    const draft = this.draft;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene) return;
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
        offset: 0,
        anchor: draft.id
          ? (scene.cues.find((item) => item.id === draft.id)?.anchor ?? false)
          : false,
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
  toggleAnchor(): void {
    const id = this.selectedCueId;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      const item = scene?.cues.find((entry) => entry.id === id);
      if (!scene || !item || scene.locked) return;
      item.anchor = !item.anchor;
    });
    this.notify(this.selectedCue?.anchor ? '已设为固定锚点' : '已取消锚点');
  }

  @action
  setReplanDuration(value: string): void {
    this.replanDurationInput = Math.max(1, Number(value) || 1);
  }

  @action
  chooseStrategy(value: ReplanStrategy): void {
    this.strategy = value;
  }

  @action
  startReplan(): void {
    const item = this.selectedCue;
    if (!item) return;
    if (this.activeScene?.locked) {
      this.notify('场次已锁定，无法预演重排');
      return;
    }
    this.preview = buildPreview(this.show, item.id, this.replanDurationValue);
    this.previewError = [];
  }

  @action
  cancelReplan(): void {
    this.cancelReplanState();
  }

  @action
  confirmReplan(): void {
    const preview = this.preview;
    if (!preview) return;
    const result = applyReplan(
      this.show,
      preview.cueId,
      preview.afterDuration,
      this.strategy,
    );
    if (!result.ok || !result.show) {
      // 应用失败：恢复改前状态（show 未被改动），保留冲突原因
      this.previewError = result.stops;
      this.notify('应用失败，已恢复改前状态');
      return;
    }
    this.commit(result.show);
    const revision: RehearsalRevision = {
      id: uid('revision'),
      createdAt: new Date().toISOString(),
      cueId: preview.cueId,
      cueTitle: preview.cueTitle,
      sceneLabel: preview.sceneLabel,
      beforeDuration: preview.beforeDuration,
      afterDuration: preview.afterDuration,
      strategy: this.strategy,
      movedCount: result.moves.length,
      note: result.stops.length ? `保留 ${result.stops.length} 条提示时间` : '',
    };
    this.revisions = [revision, ...this.revisions];
    this.cancelReplanState();
    this.persist();
    this.notify(`已应用重排并写入排练修订（顺延 ${result.moves.length} 条）`);
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
    this.notify('已锁定当前版本');
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
    this.undoStack.push(clone(this.show));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.show);
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  private commit(next: ShowData): void {
    this.undoStack.push(clone(this.show));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  private cancelReplanState(): void {
    this.preview = null;
    this.previewError = [];
    this.replanDurationInput = null;
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
