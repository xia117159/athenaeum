export interface DirectorySizeViewScope { path: string; priority: number }
export interface UpdateDirectorySizeViewsRequest {
  revision: number; scopes: DirectorySizeViewScope[]; ownerEpoch?: string; shutdownNonce?: string;
}
export interface DirectorySizeViewsAck { acceptedRevision: number; ownerEpoch: string; truncated: boolean }
export interface DirectorySizeViewsFlushRequested { nonce: string; ownerEpoch: string }
