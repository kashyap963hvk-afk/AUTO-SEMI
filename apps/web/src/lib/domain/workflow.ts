/** Persisted workflow states and the server-side transition table (spec section 25). */

export const STATES = [
  "DRAFT",
  "REQUIREMENTS_IN_PROGRESS",
  "SPEC_REVIEW_REQUIRED",
  "SPEC_APPROVED",
  "ARCHITECTURE_REVIEW_REQUIRED",
  "RTL_GENERATING",
  "RTL_LINTING",
  "VERIFICATION_RUNNING",
  "FORMAL_RUNNING",
  "SYNTHESIS_RUNNING",
  "PHYSICAL_DESIGN_RUNNING",
  "PHYSICAL_CHECKS_RUNNING",
  "REPAIR_REQUIRED",
  "BLOCKED_TOOL_UNAVAILABLE",
  "BLOCKED_MISSING_CONSTRAINTS",
  "BLOCKED_UNSUPPORTED_FEATURE",
  "BLOCKED_AI_PROVIDER",
  "PROTOTYPE_CHECKS_PASSED",
  "RELEASE_REVIEW_REQUIRED",
  "RELEASE_APPROVED",
  "PACKAGE_EXPORTED",
  "SUBMITTED",
  "PROVIDER_ACCEPTED",
  "FAILED",
  "CANCELLED",
] as const;
export type WorkflowState = (typeof STATES)[number];

const RUNNING: WorkflowState[] = ["RTL_LINTING", "VERIFICATION_RUNNING", "FORMAL_RUNNING", "SYNTHESIS_RUNNING", "PHYSICAL_DESIGN_RUNNING", "PHYSICAL_CHECKS_RUNNING"];
const BLOCKED: WorkflowState[] = ["BLOCKED_TOOL_UNAVAILABLE", "BLOCKED_MISSING_CONSTRAINTS", "BLOCKED_UNSUPPORTED_FEATURE"];
/** States from which the user may (re)start checks on the current RTL revision. */
const CHECKABLE: WorkflowState[] = ["RTL_GENERATING", "REPAIR_REQUIRED", "PROTOTYPE_CHECKS_PASSED", "RELEASE_REVIEW_REQUIRED", "RELEASE_APPROVED", "PACKAGE_EXPORTED", "FAILED", ...BLOCKED, ...RUNNING];

/**
 * Allowed transitions. SUBMITTED and PROVIDER_ACCEPTED have no inbound edges:
 * there is no authorised provider integration, so they are unreachable by design.
 */
export const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  DRAFT: ["REQUIREMENTS_IN_PROGRESS", "BLOCKED_AI_PROVIDER", "CANCELLED"],
  REQUIREMENTS_IN_PROGRESS: ["REQUIREMENTS_IN_PROGRESS", "SPEC_REVIEW_REQUIRED", "BLOCKED_AI_PROVIDER", "CANCELLED"],
  BLOCKED_AI_PROVIDER: ["REQUIREMENTS_IN_PROGRESS", "DRAFT", "REPAIR_REQUIRED", "CANCELLED"],
  SPEC_REVIEW_REQUIRED: ["SPEC_APPROVED", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  SPEC_APPROVED: ["ARCHITECTURE_REVIEW_REQUIRED", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  ARCHITECTURE_REVIEW_REQUIRED: ["RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  RTL_GENERATING: ["RTL_LINTING", "RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  // A running state may restart the sequence (stale run recovery) or start a new revision.
  RTL_LINTING: ["RTL_LINTING", "VERIFICATION_RUNNING", "REPAIR_REQUIRED", "FAILED", ...BLOCKED, "RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  VERIFICATION_RUNNING: ["FORMAL_RUNNING", "RTL_LINTING", "REPAIR_REQUIRED", "FAILED", ...BLOCKED, "RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  FORMAL_RUNNING: ["SYNTHESIS_RUNNING", "RTL_LINTING", "REPAIR_REQUIRED", "FAILED", ...BLOCKED, "RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  SYNTHESIS_RUNNING: ["PHYSICAL_DESIGN_RUNNING", "PROTOTYPE_CHECKS_PASSED", "RTL_LINTING", "REPAIR_REQUIRED", "FAILED", ...BLOCKED, "RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  PHYSICAL_DESIGN_RUNNING: ["PHYSICAL_CHECKS_RUNNING", "PROTOTYPE_CHECKS_PASSED", "RTL_LINTING", "FAILED", ...BLOCKED, "RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  PHYSICAL_CHECKS_RUNNING: ["PROTOTYPE_CHECKS_PASSED", "FAILED", ...BLOCKED, "RTL_GENERATING", "CANCELLED"],
  REPAIR_REQUIRED: ["RTL_GENERATING", "RTL_LINTING", "FAILED", "BLOCKED_AI_PROVIDER", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  BLOCKED_TOOL_UNAVAILABLE: ["RTL_LINTING", "PHYSICAL_DESIGN_RUNNING", "RTL_GENERATING", "RELEASE_REVIEW_REQUIRED", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  BLOCKED_MISSING_CONSTRAINTS: ["RTL_LINTING", "PHYSICAL_DESIGN_RUNNING", "RTL_GENERATING", "RELEASE_REVIEW_REQUIRED", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  BLOCKED_UNSUPPORTED_FEATURE: ["RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  PROTOTYPE_CHECKS_PASSED: ["RELEASE_REVIEW_REQUIRED", "PHYSICAL_DESIGN_RUNNING", "RTL_LINTING", "RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  RELEASE_REVIEW_REQUIRED: ["RELEASE_APPROVED", "RELEASE_REVIEW_REQUIRED", "PHYSICAL_DESIGN_RUNNING", "RTL_LINTING", "RTL_GENERATING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  RELEASE_APPROVED: ["PACKAGE_EXPORTED", "RTL_GENERATING", "RTL_LINTING", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  PACKAGE_EXPORTED: ["PACKAGE_EXPORTED", "RELEASE_REVIEW_REQUIRED", "RTL_GENERATING", "RTL_LINTING", "REQUIREMENTS_IN_PROGRESS"],
  SUBMITTED: ["PROVIDER_ACCEPTED", "FAILED"],
  PROVIDER_ACCEPTED: [],
  // A failed layout does not invalidate passing RTL checks: release review stays possible, and the
  // policy checklist decides (an RTL-only package discloses the failure; a physical one is blocked).
  FAILED: ["RTL_GENERATING", "RTL_LINTING", "REPAIR_REQUIRED", "PHYSICAL_DESIGN_RUNNING", "RELEASE_REVIEW_REQUIRED", "REQUIREMENTS_IN_PROGRESS", "CANCELLED"],
  CANCELLED: [],
};

export class TransitionError extends Error {
  constructor(public readonly from: WorkflowState, public readonly to: WorkflowState) {
    super(`transition ${from} -> ${to} is not allowed`);
    this.name = "TransitionError";
  }
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!TRANSITIONS[from]?.includes(to)) throw new TransitionError(from, to);
}

export function canRunChecks(state: WorkflowState): boolean {
  return CHECKABLE.includes(state);
}

export function isRunning(state: WorkflowState): boolean {
  return RUNNING.includes(state);
}

/** Plain-language status for a non-technical user (spec section 2). */
export function userStatus(state: WorkflowState): { label: string; tone: "info" | "warn" | "bad" | "good" | "run" } {
  switch (state) {
    case "DRAFT":
    case "REQUIREMENTS_IN_PROGRESS":
      return { label: "Needs information", tone: "info" };
    case "SPEC_REVIEW_REQUIRED":
    case "ARCHITECTURE_REVIEW_REQUIRED":
    case "SPEC_APPROVED":
    case "RTL_GENERATING":
      return { label: "Waiting for approval", tone: "warn" };
    case "RTL_LINTING":
    case "VERIFICATION_RUNNING":
    case "FORMAL_RUNNING":
    case "SYNTHESIS_RUNNING":
    case "PHYSICAL_DESIGN_RUNNING":
    case "PHYSICAL_CHECKS_RUNNING":
      return { label: "Running checks", tone: "run" };
    case "REPAIR_REQUIRED":
    case "FAILED":
      return { label: "Failed", tone: "bad" };
    case "PROTOTYPE_CHECKS_PASSED":
      return { label: "Prototype checks passed", tone: "good" };
    case "RELEASE_REVIEW_REQUIRED":
    case "RELEASE_APPROVED":
    case "PACKAGE_EXPORTED":
      return { label: "Release candidate ready for review", tone: "good" };
    case "BLOCKED_TOOL_UNAVAILABLE":
    case "BLOCKED_MISSING_CONSTRAINTS":
    case "BLOCKED_UNSUPPORTED_FEATURE":
    case "BLOCKED_AI_PROVIDER":
      return { label: "Blocked by missing/sign-off-only requirements", tone: "warn" };
    default:
      return { label: state, tone: "info" };
  }
}
