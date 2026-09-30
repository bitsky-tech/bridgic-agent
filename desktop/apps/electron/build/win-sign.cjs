/**
 * Windows Authenticode signing through the SafeNet eToken that holds the
 * code-signing key.
 *
 * jsign talks to the token over PKCS#11 and takes the PIN from the environment.
 * signtool cannot be used unattended here: the token's CSP ignores the
 * `/kc "[{{PIN}}]=container"` form and raises a PIN dialog on every signature,
 * which nobody is there to answer on a CI runner. Verified on the signing
 * machine (SafeNet Authentication Client 10.8 R9) on 2026-09-29.
 *
 * Signing is skipped, not failed, when WIN_SIGN_PIN is unset, so local and fork
 * builds keep working without the token. Shipping an unsigned file is caught
 * after packaging instead, by the signature audit in package.yml.
 *
 * The token allows 5 wrong PINs before it locks for good (and 5 wrong admin
 * PINs brick it), so a failure that may be a wrong PIN must never be retried by
 * automation. Such a failure writes WIN_SIGN_HALT_FILE, and while that file
 * exists no build logs in to the token at all; a human reads the log, fixes the
 * cause, and deletes the file. A failure after the token has accepted the PIN
 * (see haltUnlessLoginProven) cannot cost an attempt and writes no halt. A
 * single build cannot spend more than one attempt either: the first failure
 * aborts packaging before any other file is sent to the token.
 *
 * Environment:
 *   WIN_SIGN_PIN        token user PIN; its presence is what turns signing on
 *   WIN_SIGN_JAVA       java.exe used to run jsign
 *   WIN_SIGN_JSIGN_JAR  path to the jsign jar
 *   WIN_SIGN_ALIAS      key alias (the token's key container name)
 *   WIN_SIGN_HALT_FILE  marker that blocks signing after a possible PIN failure; must survive
 *                       between runs, so it lives outside the job workspace
 */

const { execFileSync, spawnSync } = require('node:child_process')
const {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TIMESTAMP_URL = 'http://timestamp.globalsign.com/tsa/r6advanced1'
// One jsign process per chunk: a single JVM start and token login per chunk,
// while staying far below Windows' 32767-character command-line limit.
const CHUNK_SIZE = 100

function signingConfig() {
  // Trimmed: a newline pasted into the secret would otherwise cost a PIN attempt.
  const pin = (process.env.WIN_SIGN_PIN || '').trim()
  if (!pin) {
    return null
  }
  const missing = ['WIN_SIGN_JAVA', 'WIN_SIGN_JSIGN_JAR', 'WIN_SIGN_ALIAS', 'WIN_SIGN_HALT_FILE'].filter(
    (name) => !process.env[name],
  )
  if (missing.length > 0) {
    throw new Error(`[win-sign] WIN_SIGN_PIN is set but ${missing.join(', ')} is not`)
  }
  return {
    pin,
    java: process.env.WIN_SIGN_JAVA,
    jar: process.env.WIN_SIGN_JSIGN_JAR,
    alias: process.env.WIN_SIGN_ALIAS,
    haltFile: process.env.WIN_SIGN_HALT_FILE,
    pkcs11: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'eTPKCS11.dll'),
  }
}

/**
 * Keep only files with no signature at all. Files already signed by their
 * publisher — the Microsoft, Python Software Foundation and OpenJS binaries
 * among the bundled runtimes — keep that signature, even when this machine
 * cannot confirm it as Valid (under the runner's service account the chain
 * check can fail offline). Re-signing them is not just unwanted: jsign rejects
 * the existing certificate table of Microsoft's VCRUNTIME140.dll outright.
 * A signature that is genuinely broken is still caught by the audit step.
 */
function withoutValidSignature(files) {
  if (files.length === 0) {
    return []
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'win-sign-'))
  try {
    const list = path.join(dir, 'files.txt')
    writeFileSync(list, files.join('\n'), 'utf-8')
    // 'Stop' turns any error into a non-zero exit, which throws below. Without
    // it a failed check prints an error, exits 0 and reports "nothing to sign".
    const script =
      `$ErrorActionPreference = 'Stop'; ` +
      `Get-Content -LiteralPath '${list}' -Encoding UTF8 | ` +
      `Where-Object { (Get-AuthenticodeSignature -LiteralPath $_).Status -eq 'NotSigned' }`
    // Under a pwsh 7 parent (every CI step), the inherited PSModulePath points
    // Windows PowerShell 5.1 at pwsh 7's modules, and Get-AuthenticodeSignature
    // then fails to load. Dropping it lets 5.1 use its own default path.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
    )
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      env,
    })
    return output.split(/\r?\n/).filter(Boolean)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Clear a certificate-table entry that points past the end of the file.
 *
 * The VCRUNTIME140*.dll copies in the PyInstaller bundle arrive cut off exactly
 * where Microsoft's signature began, while the header still points at it
 * (size 103936, table at 103936 + 20608). Windows reads that as NotSigned and
 * jsign refuses the file outright ("Invalid data directory (index=4)"). The
 * entry is excluded from the Authenticode digest and ignored by the loader, so
 * zeroing it turns the file into a plain unsigned PE without changing what it
 * does. A file whose table is intact is never touched.
 */
function dropDanglingCertificateTable(file) {
  const bytes = readFileSync(file)
  if (bytes.length < 0x40 || bytes.toString('latin1', 0, 2) !== 'MZ') return
  const pe = bytes.readUInt32LE(0x3c)
  if (pe + 0x18 + 2 > bytes.length || bytes.toString('latin1', pe, pe + 4) !== 'PE\0\0') return
  const optionalHeader = pe + 0x18
  const pe32Plus = bytes.readUInt16LE(optionalHeader) === 0x20b
  // Data directory index 4 (IMAGE_DIRECTORY_ENTRY_SECURITY): file offset, size.
  const entry = optionalHeader + (pe32Plus ? 112 : 96) + 4 * 8
  if (entry + 8 > bytes.length) return
  const offset = bytes.readUInt32LE(entry)
  const size = bytes.readUInt32LE(entry + 4)
  if (size === 0 || offset + size <= bytes.length) return
  bytes.fill(0, entry, entry + 8)
  writeFileSync(file, bytes)
  console.log(`[win-sign] cleared a certificate table past the end of ${file}`)
}

/**
 * Proof that the token accepted the PIN earlier in this CI job. A job signs in
 * several separate jsign runs (the PyInstaller bundle, then one run per .exe
 * during packaging), all with the same PIN from the same secret, so one
 * success vouches for the PIN for the rest of the job. RUNNER_TEMP is emptied
 * at the start of every job, so the proof never outlives it; outside CI there
 * is none and every failure is judged on its own.
 */
const PIN_ACCEPTED_MARKER = process.env.RUNNER_TEMP
  ? path.join(process.env.RUNNER_TEMP, 'win-sign-pin-accepted')
  : null

function recordPinAccepted() {
  if (PIN_ACCEPTED_MARKER !== null) {
    writeFileSync(PIN_ACCEPTED_MARKER, `${new Date().toISOString()}\n`)
  }
}

/**
 * Decide whether a failed jsign run may have spent a PIN attempt.
 *
 * The PIN is proven right when the token accepted it earlier in this job, or
 * when any file of the failed chunk is signed now — a successful login also
 * resets the token's wrong-PIN counter — so a retry cannot lock it and no halt
 * is needed. Otherwise the failure may be a wrong PIN, and the halt file is
 * written. The error text is deliberately not parsed: a PIN error worded in a
 * way nobody anticipated would read as "safe" and let every later run spend
 * another attempt. Signed-or-not is observable; wording is not. The output is
 * still kept in the halt file, so the cause can be read on the machine even
 * when the job log never reaches GitHub.
 */
function haltUnlessLoginProven(haltFile, chunk, output) {
  let loginProven = PIN_ACCEPTED_MARKER !== null && existsSync(PIN_ACCEPTED_MARKER)
  if (!loginProven) {
    try {
      const unsigned = new Set(withoutValidSignature(chunk))
      loginProven = chunk.some((file) => !unsigned.has(file))
    } catch {
      // Could not tell: treat it as a possible PIN failure.
    }
  }
  if (loginProven) {
    recordPinAccepted()
    console.warn('[win-sign] the token accepted the PIN earlier; no halt written')
    return
  }
  const tail = output.split(/\r?\n/).filter(Boolean).slice(-40).join('\n')
  writeFileSync(haltFile, `${new Date().toISOString()} jsign failed:\n${tail}\n`)
}

/** Sign every file in `files` that is not validly signed yet. */
function signFiles(files) {
  const config = signingConfig()
  if (config === null) {
    console.warn(`[win-sign] WIN_SIGN_PIN not set, leaving ${files.length} file(s) unsigned`)
    return
  }
  if (existsSync(config.haltFile)) {
    throw new Error(
      `[win-sign] signing is halted by ${config.haltFile}: an earlier signing attempt failed. ` +
        'Find out why from that run, fix it, then delete the file. Do NOT just re-run — ' +
        'if the PIN is wrong, every run spends one of the token\'s 5 attempts.',
    )
  }
  const targets = withoutValidSignature(files)
  console.log(`[win-sign] ${targets.length} of ${files.length} file(s) need signing`)
  targets.forEach(dropDanglingCertificateTable)
  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE)
    const result = spawnSync(
      config.java,
      [
        '-jar', config.jar,
        '--storetype', 'ETOKEN',
        '--keystore', config.pkcs11,
        // `env:` makes jsign read the PIN itself, keeping it off the command line.
        '--storepass', 'env:WIN_SIGN_PIN',
        '--alias', config.alias,
        '--alg', 'SHA-256',
        '--tsaurl', TIMESTAMP_URL,
        '--tsmode', 'RFC3161',
        '--replace',
        ...chunk,
      ],
      {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, WIN_SIGN_PIN: config.pin },
      },
    )
    // Captured rather than inherited so a failure's output can go into the halt file.
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `${result.error.message}\n` : ''}`
    process.stdout.write(output)
    if (result.status !== 0) {
      haltUnlessLoginProven(config.haltFile, chunk, output)
      throw new Error(`[win-sign] jsign exited with ${result.status ?? result.signal ?? 'an error'}`)
    }
    recordPinAccepted()
  }
}

/**
 * electron-builder custom sign hook (`win.signtoolOptions.sign`). It is called
 * once per executable: the app exe after its resources are edited, every .exe
 * copied through extraResources, the uninstaller, and the installer itself.
 */
exports.default = async function sign(configuration) {
  signFiles([configuration.path])
}

exports.signFiles = signFiles
exports.dropDanglingCertificateTable = dropDanglingCertificateTable

// CLI: `node win-sign.cjs <dir>` signs every PE image under <dir>. CI uses it on
// the PyInstaller bundle, which has to be signed before its smoke test runs.
if (require.main === module) {
  const root = path.resolve(process.argv[2] || '')
  const files = readdirSync(root, { recursive: true })
    .map((relative) => path.join(root, relative))
    .filter((file) => /\.(?:exe|dll|pyd|node)$/i.test(file) && statSync(file).isFile())
  signFiles(files)
}
