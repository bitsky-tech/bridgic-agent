/**
 * electron-builder afterPack hook.
 *
 * Runs once per platform/arch combination after files are copied to the app
 * payload but before signing. It makes bundled CLI/runtime binaries executable
 * and signs the native runtime payload on macOS.
 */

const { execFileSync, spawnSync } = require('node:child_process')
const {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} = require('node:fs')
const path = require('node:path')

const AMPHI_BIN_NAMES_POSIX = ['amphi']
const AMPHI_BIN_NAMES_WIN = ['amphi.exe', 'amphi-autostart.exe']
const UV_BIN_NAMES_POSIX = ['uv']
const UV_BIN_NAMES_WIN = ['uv.exe']
/**
 * Files needing the exec bit inside node_runtime: `node` itself, plus the three
 * JS entry points that `bin/npm`, `bin/npx` and `bin/corepack` symlink to.
 * Those are plain JS but are invoked through their `#!/usr/bin/env node`
 * shebang, so losing the bit in packaging breaks them with EACCES.
 * Enumerated rather than matched by suffix so unrelated files (npm-prefix.js)
 * are not touched.
 */
const NODE_RUNTIME_EXECUTABLES = /^(?:node|npm-cli\.js|npx-cli\.js|corepack\.js)$/
/**
 * Restore `node_runtime/node_modules`, which electron-builder drops unconditionally.
 *
 * `app-builder-lib/out/util/filter.js::createFilter` contains:
 *
 *     // filter the root node_modules, but not a subnode_modules
 *     if (relative === "node_modules") { return false }
 *
 * It is hard-coded and ignores the configured `filter`, and it applies to EVERY
 * FileMatcher — including `extraResources`, not just the app dir it was written
 * for. Node's Windows zip keeps npm at `node_runtime/node_modules/npm`, i.e.
 * exactly at a copy root, so the whole tree vanished from the installer: 1777
 * files went in, 14 came out. POSIX is unaffected because its npm lives at
 * `lib/node_modules`, and `"lib/node_modules" !== "node_modules"`.
 *
 * Symptom when this regresses: `node.exe --version` works, every `npm`/`npx`
 * invocation dies with `Cannot find module '…/node_modules/npm/bin/npm-cli.js'`,
 * and all four npm-based Skills (docx / pptx / remotion / hyperframes) break.
 *
 * Throws rather than warns: shipping a Node runtime whose npm is missing is a
 * silent, user-facing breakage — exactly the class of failure that cost a full
 * release cycle to find.
 */
function restoreNodeModules(resourcesDir) {
  const packaged = path.join(resourcesDir, 'node_runtime')
  if (!existsSync(packaged)) {
    return
  }
  // Layout is platform-dependent; only the Windows one sits at a copy root.
  const source = path.join(__dirname, '..', 'resources', 'node_runtime', 'node_modules')
  const target = path.join(packaged, 'node_modules')

  if (existsSync(target)) {
    console.log('[after-pack] node_runtime/node_modules already present, nothing to restore')
    return
  }
  if (!existsSync(source)) {
    // POSIX: npm lives under lib/, so a missing root node_modules is expected.
    const posixNpm = path.join(packaged, 'lib', 'node_modules', 'npm')
    if (existsSync(posixNpm)) {
      return
    }
    throw new Error(
      `[after-pack] node_runtime has no npm at all.\n` +
        `  looked for : ${source}\n` +
        `           and: ${posixNpm}\n` +
        `  Run \`bun run prebuild:fetch-node <arch>\` before packaging.`,
    )
  }

  cpSync(source, target, { recursive: true, verbatimSymlinks: true })
  const cli = path.join(target, 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(cli)) {
    throw new Error(`[after-pack] restored node_modules but npm entry is missing: ${cli}`)
  }
  console.log(`[after-pack] restored node_runtime/node_modules (electron-builder drops root node_modules)`)
}

function requireAmphiBundle(resourcesDir, platform) {
  const binDir = path.join(resourcesDir, 'bin')
  const launcherNames = platform === 'win32' ? AMPHI_BIN_NAMES_WIN : AMPHI_BIN_NAMES_POSIX
  const internalDir = path.join(binDir, '_internal')
  if (
    !launcherNames.every((name) => {
      const launcher = path.join(binDir, name)
      return existsSync(launcher) && lstatSync(launcher).isFile()
    }) ||
    !existsSync(internalDir) ||
    !lstatSync(internalDir).isDirectory()
  ) {
    throw new Error(
      `[after-pack] incomplete Amphi onedir bundle under ${binDir}; ` +
        `expected ${launcherNames.join(', ')} and _internal/. ` +
        `Run prebuild:fetch-amphi first.`,
    )
  }
  return binDir
}

/**
 * Assert the third-party compliance set actually reached the packaged app.
 *
 * This is the tripwire for the whole license pipeline. Without it, breaking the
 * chain is silent and total: drop the `extraResources` entries, or drop the
 * `licenses` step out of the `build` script, and every artifact ships with no
 * third-party notices whatsoever — while the build stays green and nothing in
 * the repo looks wrong. That is precisely the failure this file set exists to
 * fix: a NOTICE citing a generated THIRD-PARTY-LICENSES.txt that no build had
 * ever produced, which went unnoticed long enough to be deleted as redundant.
 *
 * It lives here rather than in CI on purpose — afterPack runs on every package
 * build including local ones, and local `dist:mac` is the usual release path.
 */
function requireComplianceDocuments(resourcesDir) {
  for (const name of ['THIRD-PARTY-LICENSES.txt', 'LICENSE', 'NOTICE']) {
    const target = path.join(resourcesDir, name)
    const stat = existsSync(target) ? lstatSync(target) : null
    if (stat === null || !stat.isFile() || stat.size === 0) {
      throw new Error(
        `[after-pack] missing or empty ${name} under ${resourcesDir}. ` +
          'It is staged by scripts/gen-third-party-licenses.ts as part of `bun run build` ' +
          'and shipped through extraResources in electron-builder.yml — check both.',
      )
    }
  }

  // Non-empty is not the same as complete. The generator skips any payload
  // directory that was not populated when it ran, silently — so running
  // `bun run build` BEFORE `prebuild:fetch-amphi`, then packaging without a
  // rebuild, yields a perfectly well-formed file that happens to omit all 120
  // Python packages. Cross-check the sections against what is actually here.
  const manifest = readFileSync(path.join(resourcesDir, 'THIRD-PARTY-LICENSES.txt'), 'utf-8')
  const expectedSections = [
    { when: path.join(resourcesDir, 'bin', '_internal'), section: 'Bundled Python packages' },
    { when: path.join(resourcesDir, 'node_runtime'), section: 'Bundled runtimes' },
  ]
  for (const { when, section } of expectedSections) {
    if (existsSync(when) && !manifest.includes(section)) {
      throw new Error(
        `[after-pack] ${when} ships in this package but THIRD-PARTY-LICENSES.txt has no ` +
          `"${section}" section. The manifest was generated before that payload existed — ` +
          're-run `bun run build` after the prebuild:fetch-* steps.',
      )
    }
  }

  // The JavaScript section gets a COUNT check, not just a presence check.
  // It is the only section derived from sourcemaps, so building main without
  // the renderer (`bun run build:main`) still emits a well-formed heading —
  // just one missing react, mermaid, katex and every other renderer dependency.
  // "Section exists" would wave that through exactly like "file is non-empty"
  // waved through a manifest with no Python packages at all.
  const jsCount = /^Bundled JavaScript packages \((\d+)\)$/m.exec(manifest)
  if (jsCount === null) {
    throw new Error(
      '[after-pack] THIRD-PARTY-LICENSES.txt has no "Bundled JavaScript packages" section. ' +
        'Every build bundles JavaScript, so this manifest is not from a complete build.',
    )
  }
  const MIN_EXPECTED_JS = 100
  if (Number(jsCount[1]) < MIN_EXPECTED_JS) {
    throw new Error(
      `[after-pack] THIRD-PARTY-LICENSES.txt lists only ${jsCount[1]} JavaScript packages; ` +
        `a complete build has well over ${MIN_EXPECTED_JS}. The renderer bundle was probably ` +
        'not built before the manifest was generated — run `bun run build`, not `build:main`.',
    )
  }
  console.log('[after-pack] compliance set present and covers every bundled payload')
}

/** @param {{ appOutDir: string, packager: { appInfo: { productFilename: string } }, electronPlatformName: string }} context */
exports.default = async function afterPack(context) {
  const resourcesDir = resourcesRoot(context)
  restoreNodeModules(resourcesDir)
  requireComplianceDocuments(resourcesDir)
  const binDir = requireAmphiBundle(resourcesDir, context.electronPlatformName)
  const uvBinDir = path.join(resourcesDir, 'uv_runtime', 'bin')
  const pythonRuntimeDir = path.join(resourcesDir, 'python_runtime')
  const nodeRuntimeDir = path.join(resourcesDir, 'node_runtime')
  if (context.electronPlatformName !== 'win32') {
    chmodPosixBinaries(binDir, AMPHI_BIN_NAMES_POSIX)
  }
  if (existsSync(uvBinDir) && context.electronPlatformName !== 'win32') {
    chmodPosixBinaries(uvBinDir, UV_BIN_NAMES_POSIX)
  }
  if (existsSync(pythonRuntimeDir) && context.electronPlatformName !== 'win32') {
    chmodPythonRuntime(pythonRuntimeDir)
  }
  if (existsSync(nodeRuntimeDir) && context.electronPlatformName !== 'win32') {
    chmodNodeRuntime(nodeRuntimeDir)
  }

  if (context.electronPlatformName !== 'darwin') {
    return
  }

  // Whole-tree, not just the launcher: `amphi` ships as a PyInstaller ONEDIR
  // bundle, so Resources/bin also holds `_internal/` with the Python runtime's
  // .so/.dylib files. Under `hardenedRuntime: true` an unsigned Mach-O cannot
  // be loaded, so signing only the launcher would fail at first dlopen.
  signMacMachOTree(binDir)
  if (existsSync(uvBinDir)) {
    signMacBinaries(uvBinDir, UV_BIN_NAMES_POSIX)
  }
  if (existsSync(pythonRuntimeDir)) {
    signMacMachOTree(pythonRuntimeDir)
  }
  // Unsigned Mach-O binaries cannot launch under `hardenedRuntime: true`, so
  // the bundled node must be signed or the Playwright CDP driver and npm-based
  // Skills die at spawn time in a packaged build.
  if (existsSync(nodeRuntimeDir)) {
    signMacMachOTree(nodeRuntimeDir)
  }
}

function resourcesRoot(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
    )
  }
  return path.join(context.appOutDir, 'resources')
}

function chmodPosixBinaries(binDir, names) {
  for (const name of names) {
    const p = path.join(binDir, name)
    if (existsSync(p)) {
      chmodSync(p, 0o755)
      console.log(`[after-pack] chmod +x ${p}`)
    }
  }
}

function chmodPythonRuntime(rootDir) {
  walkDir(rootDir, (filePath, name, st) => {
    if (!st.isFile() || !/^python(?:3(?:\.\d+)?)?$/.test(name)) {
      return
    }
    chmodSync(filePath, 0o755)
    console.log(`[after-pack] chmod +x ${filePath}`)
  })
}

function chmodNodeRuntime(rootDir) {
  walkDir(rootDir, (filePath, name, st) => {
    if (!st.isFile() || !NODE_RUNTIME_EXECUTABLES.test(name)) {
      return
    }
    chmodSync(filePath, 0o755)
    console.log(`[after-pack] chmod +x ${filePath}`)
  })
}

/** Sign every Mach-O binary under `rootDir`, deepest path first. */
function signMacMachOTree(rootDir) {
  const targets = []
  walkDir(rootDir, (filePath, _name, st) => {
    if (st.isFile() && isMachO(filePath)) {
      targets.push({ filePath, executable: (st.mode & 0o111) !== 0 })
    }
  })
  targets
    .sort((a, b) => pathDepth(b.filePath) - pathDepth(a.filePath))
    .forEach(({ filePath, executable }) => {
      signMacPath(filePath, { entitlements: executable })
    })
}

function isMachO(filePath) {
  const buffer = Buffer.allocUnsafe(4)
  let fd
  try {
    fd = openSync(filePath, 'r')
    if (readSync(fd, buffer, 0, 4, 0) !== 4) return false
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return new Set([
    0xfeedface,
    0xfeedfacf,
    0xcefaedfe,
    0xcffaedfe,
    0xcafebabe,
    0xbebafeca,
  ]).has(buffer.readUInt32BE(0))
}

function walkDir(dir, visit) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = lstatSync(full)
    if (st.isSymbolicLink()) {
      continue
    }
    if (st.isDirectory()) {
      visit(full, entry, st)
      walkDir(full, visit)
      continue
    }
    visit(full, entry, st)
  }
}

function pathDepth(targetPath) {
  return targetPath.split(path.sep).length
}

function signMacBinaries(binDir, names) {
  for (const name of names) {
    const p = path.join(binDir, name)
    if (!existsSync(p)) continue
    signMacPath(p)
  }
}

function signMacPath(targetPath, options = {}) {
  const identity =
    process.env.APPLE_SIGNING_IDENTITY ||
    process.env.CSC_NAME ||
    process.env.CSC_IDENTITY ||
    null

  if (!identity) {
    console.warn(`[after-pack] no Apple identity, ad-hoc signing ${targetPath}`)
    const r = spawnSync(
      'codesign',
      ['--sign', '-', '--force', '--timestamp=none', targetPath],
      { stdio: 'inherit' },
    )
    if (r.status !== 0) {
      console.warn(`[after-pack] ad-hoc codesign failed for ${targetPath}`)
    }
    return
  }

  console.log(`[after-pack] codesign ${targetPath} with identity "${identity}"`)
  const args = ['--sign', identity, '--force', '--options', 'runtime']
  if (options.entitlements !== false) {
    args.push(
      '--entitlements',
      path.join(__dirname, '..', 'resources', 'entitlements.mac.plist'),
    )
  }
  args.push('--timestamp', targetPath)
  execFileSync(
    'codesign',
    args,
    { stdio: 'inherit' },
  )
}

void UV_BIN_NAMES_WIN
