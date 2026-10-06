export type CueKind = '灯光' | '音响' | '道具' | '演员' | '舞台' | '字幕';

export interface Cue {
  id: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string[];
  cast: string[];
  notes: string;
  dependsOn: string[];
  offset: number;
  anchor?: boolean;
}

export interface Scene {
  id: string;
  act: string;
  name: string;
  title: string;
  startTime: string;
  locked: boolean;
  cues: Cue[];
}

export interface ShowData {
  title: string;
  venue: string;
  date: string;
  scenes: Scene[];
  updatedAt: string;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  data: ShowData;
}

export interface CueDraft {
  id?: string;
  kind: CueKind;
  title: string;
  duration: number;
  owner: string;
  lighting: string;
  sound: string;
  props: string;
  cast: string;
  notes: string;
  dependsOn: string;
}

export interface CueIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  icon?: string;
  sceneId?: string;
  cueId?: string;
}

/** 重排停住的原因：循环依赖 / 固定锚点 / 跨场资源冲突 / 场次锁定 / 需要早于开场 */
export type ReplanStopKind =
  'cycle' | 'anchor' | 'resource' | 'locked' | 'scene-start';

export interface ReplanStop {
  cueId: string;
  cueTitle: string;
  sceneId: string;
  sceneLabel: string;
  kind: ReplanStopKind;
  /** 保留时间的原因，展示给舞台监督 */
  detail: string;
  /** 撞场的演员或道具 */
  resources?: string[];
  /** 关联提示（撞场对象或循环成员） */
  relatedCueTitles?: string[];
}

export interface ReplanMove {
  cueId: string;
  cueTitle: string;
  sceneId: string;
  sceneLabel: string;
  beforeOffset: number;
  afterOffset: number;
  cause: string;
}

export interface ReplanPreview {
  cueId: string;
  cueTitle: string;
  sceneLabel: string;
  beforeDuration: number;
  afterDuration: number;
  moves: ReplanMove[];
  stops: ReplanStop[];
  hasCycle: boolean;
}

/** 顺延整段 = 冲突点之后整段一起顺移；只移动冲突项 = 仅挪走撞场的提示 */
export type ReplanStrategy = 'shift-section' | 'move-conflicts';

export interface ReplanApplyResult {
  ok: boolean;
  show?: ShowData;
  moves: ReplanMove[];
  /** 应用失败时保留的冲突原因 */
  stops: ReplanStop[];
}

export interface RehearsalRevision {
  id: string;
  createdAt: string;
  cueId: string;
  cueTitle: string;
  sceneLabel: string;
  beforeDuration: number;
  afterDuration: number;
  strategy: ReplanStrategy;
  movedCount: number;
  note: string;
}

export interface CueVersionDiff {
  id: string;
  sceneLabel: string;
  cueLabel: string;
  ownerBefore: string;
  ownerAfter: string;
  durationBefore: string;
  durationAfter: string;
  flowBefore: string;
  flowAfter: string;
  changed: boolean;
  added: boolean;
  removed: boolean;
}

export const CUE_KINDS: CueKind[] = [
  '灯光',
  '音响',
  '道具',
  '演员',
  '舞台',
  '字幕',
];
export const OWNERS = ['李岚', '周启', '陈默', '赵一帆', '孙禾', '待指定'];
