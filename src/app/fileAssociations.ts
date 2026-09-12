export interface FileAssociationRule {
  id: string;
  patterns: string;
  executablePath: string;
  argumentsTemplate: string;
}

export interface AssociationProgramInfo {
  path: string;
  displayName: string;
  exists: boolean;
}

export type FileOpenTarget =
  | { kind: "local"; path: string }
  | { kind: "remote"; profileId: string; path: string };

export interface FileOpenRequest {
  requestId: string;
  target: FileOpenTarget;
  associationId?: string | null;
}

export interface FileOpenProgress {
  phase: "preparing" | "downloading" | "opening";
  completedBytes?: number | null;
}

export type FileOpenResult =
  | { status: "opened"; localPath: string; associationId: string | null }
  | { status: "cancelled" };
