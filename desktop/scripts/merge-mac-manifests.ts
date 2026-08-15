/**
 * Merge the per-architecture `latest-mac.yml` files into one multi-arch feed.
 *
 * Each macOS build job produces a manifest listing only the architecture it
 * built. Publishing both to the same Release makes the later upload silently
 * overwrite the earlier one, leaving a feed that serves exactly one
 * architecture — and the other architecture's users get
 * `ERR_UPDATER_ZIP_FILE_NOT_FOUND` forever, silently, because background
 * updater errors do not surface. Merging is what makes the two architectures
 * equal citizens.
 *
 * How the client picks (electron-updater `MacUpdater.js`, `doDownloadUpdate`):
 * it looks for the substring `arm64` in each file's URL. On Apple Silicon it
 * keeps only entries that match; on Intel it keeps only entries that do NOT.
 * Our `artifactName` (`…-${arch}.${ext}`) already produces `-arm64.zip` and
 * `-x64.zip`, so no naming change is needed — the merged `files` list is
 * sufficient, and each machine downloads only its own ~222 MB rather than a
 * universal build's combined weight.
 *
 * Invariants:
 *   - Every input must agree on `version`. A mismatch means two different
 *     builds got mixed, which would hand half the users an update whose
 *     backend does not match its manifest; that is a build error, not
 *     something to paper over.
 *   - The output MUST contain an arm64 entry and MUST NOT contain duplicate
 *     URLs; both are the shapes that silently break one architecture.
 *   - Legacy top-level `path`/`sha512` point at the arm64 file. They are only
 *     read by clients too old to understand `files` (`Provider.js::getFileList`
 *     falls back to them), and arm64 is the majority platform.
 *
 * Usage: bun run scripts/merge-mac-manifests.ts <out.yml> <in-a.yml> <in-b.yml> [...]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dump, load } from 'js-yaml'

/** One entry of the manifest's `files` list. */
export interface ManifestFile {
  url: string
  sha512: string
  size: number
}

/** Shape of `latest-mac.yml` as electron-builder writes it. */
export interface MacManifest {
  version: string
  files: ManifestFile[]
  path: string
  sha512: string
  releaseDate: string
}

/** True when the client's arm64 test (`url` contains `arm64`) would match. */
export function isArm64Entry(file: ManifestFile): boolean {
  return file.url.includes('arm64')
}

/**
 * Merge per-arch manifests into one.
 *
 * @param manifests - one per architecture, in any order
 * @returns a manifest whose `files` covers every input architecture
 * @throws when versions disagree, an input is empty, or no arm64 entry results
 */
export function mergeMacManifests(manifests: MacManifest[]): MacManifest {
  if (manifests.length === 0) {
    throw new Error('[merge-mac-manifests] no manifests given')
  }

  const versions = [...new Set(manifests.map((m) => m.version))]
  if (versions.length > 1) {
    throw new Error(
      `[merge-mac-manifests] version mismatch across architectures: ${versions.join(', ')}. ` +
        'The jobs built different commits — republish rather than merging them.',
    )
  }

  const files: ManifestFile[] = []
  const seen = new Set<string>()
  for (const manifest of manifests) {
    for (const file of manifest.files) {
      // Same URL twice would make the client download one and ignore the other;
      // harmless today but it always means an input was passed twice.
      if (seen.has(file.url)) continue
      seen.add(file.url)
      files.push(file)
    }
  }

  const arm64 = files.find(isArm64Entry)
  if (!arm64) {
    throw new Error(
      '[merge-mac-manifests] no arm64 entry in the merged feed. Apple Silicon is the majority ' +
        'platform; publishing this would leave it with no update at all.',
    )
  }

  return {
    version: versions[0]!,
    files,
    path: arm64.url,
    sha512: arm64.sha512,
    // Any input's timestamp is equally true; take the newest so the feed does
    // not appear to move backwards if a job is retried.
    releaseDate: manifests.map((m) => m.releaseDate).sort().at(-1)!,
  }
}

function main(): void {
  const [outFile, ...inFiles] = process.argv.slice(2)
  if (!outFile || inFiles.length === 0) {
    throw new Error(
      'usage: bun run scripts/merge-mac-manifests.ts <out.yml> <in-a.yml> <in-b.yml> [...]',
    )
  }

  const manifests = inFiles.map((file) => load(readFileSync(file, 'utf-8')) as MacManifest)
  const merged = mergeMacManifests(manifests)
  writeFileSync(outFile, dump(merged, { lineWidth: -1 }), 'utf-8')

  const arches = merged.files.map((f) => (isArm64Entry(f) ? 'arm64' : 'x64')).join(' + ')
  console.log(`[merge-mac-manifests] ${merged.version}: ${arches} -> ${outFile}`)
}

// Only run when invoked directly, so the pure functions above stay unit-testable.
if (import.meta.main) {
  main()
}
