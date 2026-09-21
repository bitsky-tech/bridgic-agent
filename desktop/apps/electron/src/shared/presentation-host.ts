import type { MountReferenceSummary, MountReferenceUsage, MountReplacementValidation } from './mount-references'

export type PresentationSourceMount = MountReferenceSummary

export interface PresentationMountedSource extends MountReferenceSummary {
  relativePath?: string
}

export type PresentationMountUsage = MountReferenceUsage

export type PresentationMountReplacementValidation = MountReplacementValidation
