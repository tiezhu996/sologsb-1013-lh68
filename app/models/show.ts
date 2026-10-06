export type CueKind = '灯光' | '音响' | '道具' | '演员' | '舞台' | '字幕';

export type RescheduleStrategy = 'shift-segment' | 'move-conflicts';

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
  anchor: boolean;
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

export interface RehearsalRevision {
  id: string;
  createdAt: string;
  cueId: string;
  cueTitle: string;
  sceneLabel: string;
  strategy: RescheduleStrategy;
  durationBefore: number;
  durationAfter: number;
  moves: Array<{
    cueId: string;
    title: string;
    beforeOffset: number;
    afterOffset: number;
  }>;
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

export interface VersionDiff {
  id: string;
  changed: boolean;
  label: string;
  owner: string;
  duration: string;
  flow: string;
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

export const STRATEGY_LABELS: Record<RescheduleStrategy, string> = {
  'shift-segment': '顺延整段',
  'move-conflicts': '只移动冲突项',
};
