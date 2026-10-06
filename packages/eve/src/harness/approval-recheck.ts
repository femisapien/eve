import type { ApprovalContext } from "#approval/definition.js";

/**
 * Approval contexts built to re-check a call a person already approved, just
 * before eve runs it. A policy reads this to hold the call to what was
 * approved, such as the connection instance it was asked against.
 */
const rechecks = new WeakSet<object>();

export function markApprovalRecheck<T extends ApprovalContext>(context: T): T {
  rechecks.add(context);
  return context;
}

/** Whether `context` is the re-check of an approved call just before it runs. */
export function isApprovalRecheck(context: ApprovalContext): boolean {
  return rechecks.has(context);
}
