export interface MountReferenceUsage {
  assetCount: number
  elementCount: number
  projectCount: number
}

export type MountReplacementValidation =
  | { compatible: true }
  | { compatible: false; reason: 'unavailable' | 'type-mismatch' | 'content-mismatch'; assetName: string }

export interface MountReferenceSummary {
  id: string
  name: string
  path: string
  kind: 'file' | 'folder'
  exists: boolean
  size_bytes: number | null
  item_count: number | null
  removable?: boolean
  created_at: string
}

export type MountReferenceRebindResult =
  | { ok: true; mount: MountReferenceSummary }
  | { ok: false; validation: Exclude<MountReplacementValidation, { compatible: true }> }
