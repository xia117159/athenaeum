import type { DirectorySizeLeaseTarget } from "./directorySizeState";
import type { DirectorySnapshot, FolderExpansionBranch } from "./types";

export type SizeAlignmentTarget = DirectorySizeLeaseTarget & {
  generation: number; path: string; expectedRoot: DirectorySnapshot; expectedBranch?: FolderExpansionBranch;
};
export type AlignmentResult = { snapshot: DirectorySnapshot; error?: never } | { snapshot?: never; error: string };

/** One attempted read: completed records must not become a hidden file cache. */
export class DirectorySizeAlignmentRequest {
  private started = false;
  private completed = false;
  private targets = new Map<string, SizeAlignmentTarget>();
  private result?: AlignmentResult;

  enroll(target: SizeAlignmentTarget) {
    if (this.started || this.completed || this.targets.has(target.consumerId)) return false;
    this.targets.set(target.consumerId, target); return true;
  }
  start() { this.started = true; }
  prune(keep: (target: SizeAlignmentTarget) => boolean) {
    for (const [id, target] of this.targets) if (!keep(target)) this.targets.delete(id);
  }
  finish(result: AlignmentResult, deliver: (target: SizeAlignmentTarget, result: AlignmentResult) => void) {
    if (this.completed) return;
    this.completed = true; this.result = result;
    try { for (const target of this.targets.values()) deliver(target, result); }
    finally { this.targets.clear(); this.result = undefined; }
  }
  discard() { this.completed = true; this.targets.clear(); this.result = undefined; }
  get retainedPayloadEntries() { return this.result?.snapshot?.entries.length ?? 0; }
  get retainedConsumers() { return this.targets.size; }
}
