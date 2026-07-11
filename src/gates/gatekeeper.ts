import type { Bundle } from "../okf/bundle-core.js";
import { conceptsByType } from "../okf/bundle-core.js";
import { canPerform, requiresGate, type ActionCategory, type Level } from "../autonomy/ladder.js";
import type { ApprovalRecord } from "./approvals.js";

/** Anything that can answer "what is approval <id>?" — ApprovalStore or a store-backed map. */
export interface ApprovalLookup {
  get(id: string): ApprovalRecord | undefined;
}

/**
 * Constitution enforcement lives here — in the harness, in code. It is never
 * merely requested in a prompt (D5). The gated-action vocabulary is read from
 * the constitution concept itself so the knowledge layer stays sovereign;
 * these defaults are the floor, not the ceiling.
 */
export const DEFAULT_GATED_TYPES: readonly string[] = [
  "money-movement",
  "government-filing",
  "external-publishing",
  "credential-exposure",
  "access-expansion",
];

export function loadGatedTypes(bundle: Bundle): string[] {
  const constitution = conceptsByType(bundle, "constitution")[0];
  const declared = constitution?.frontmatter["gated-actions"];
  if (Array.isArray(declared) && declared.every((x) => typeof x === "string") && declared.length > 0) {
    // Union, never replacement: a constitution can add gates, not remove the floor.
    return [...new Set([...DEFAULT_GATED_TYPES, ...declared])];
  }
  return [...DEFAULT_GATED_TYPES];
}

export class GateViolation extends Error {
  constructor(
    message: string,
    readonly actionType: string,
  ) {
    super(message);
    this.name = "GateViolation";
  }
}

export interface ActionCheck {
  agent: string;
  level: Level;
  category: ActionCategory;
  /** Constitution vocabulary type, e.g. `report` or `government-filing`. */
  actionType: string;
  gatedTypes: readonly string[];
  approvals: ApprovalLookup;
  approvalId?: string;
  /** L3 whitelisted reversible actions — the agent concept's whitelist. */
  whitelist?: readonly string[];
}

/**
 * Throws GateViolation unless the action is permitted. The rules, in order:
 *  1. The agent's ladder level must allow the action category.
 *  2. Reversible (L3) actions must be on the agent's whitelist.
 *  3. Constitution-gated types and all external actions require a matching,
 *     APPROVED approval record for the same actionType.
 */
export function assertActionAllowed(check: ActionCheck): void {
  const { agent, level, category, actionType } = check;

  if (!canPerform(level, category)) {
    throw new GateViolation(
      `${agent} (${level}) may not perform ${category} actions — the ladder is the law`,
      actionType,
    );
  }

  if (category === "reversible") {
    const whitelist = check.whitelist ?? [];
    if (!whitelist.includes(actionType)) {
      throw new GateViolation(
        `${agent} (${level}) reversible action '${actionType}' is not on its whitelist [${whitelist.join(", ")}]`,
        actionType,
      );
    }
  }

  const isGatedType = check.gatedTypes.includes(actionType);
  if (isGatedType || requiresGate(category)) {
    if (!check.approvalId) {
      throw new GateViolation(
        `${agent}: '${actionType}' is gated and no approvalId was supplied`,
        actionType,
      );
    }
    const record = check.approvals.get(check.approvalId);
    if (!record) {
      throw new GateViolation(`${agent}: approval ${check.approvalId} does not exist`, actionType);
    }
    if (record.status !== "approved") {
      throw new GateViolation(
        `${agent}: approval ${check.approvalId} is ${record.status}, not approved`,
        actionType,
      );
    }
    if (record.actionType !== actionType) {
      throw new GateViolation(
        `${agent}: approval ${check.approvalId} is for '${record.actionType}', not '${actionType}' — approvals are per-action`,
        actionType,
      );
    }
  }
}
