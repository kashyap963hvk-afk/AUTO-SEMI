import type { Question } from "@/lib/domain/fifo";
import type { ChecklistItem } from "@/lib/domain/release";
import type { SpecField } from "@/lib/domain/spec";
import type { Stage, StageResult } from "@/lib/eda/contracts";
import type { ProjectAiPolicy } from "@/lib/ai/contracts";
import type { ProjectData } from "@/lib/store/repo";

export interface Overview {
  project: {
    id: string;
    name: string;
    description: string;
    state: string;
    data: ProjectData;
    ai_policy: ProjectAiPolicy;
    updated_at: string;
  };
  interview: { question: Question | null; field: SpecField | null; done: boolean };
  approval: { canApprove: boolean; blockers: string[]; proposalsNeedingAcceptance: string[]; physicalUnknowns: string[] };
  level: { level: number; label: string };
  checklist: ChecklistItem[];
  latestRuns: Partial<Record<Stage, { id: string; result: StageResult; source_revision: number }>>;
  stages: Stage[];
}

export interface PanelProps {
  ov: Overview;
  reload: () => Promise<void>;
  toast: (msg: string, tone?: "bad" | "good" | "info") => void;
  go: (tab: string) => void;
}
