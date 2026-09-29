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
 * PINs brick it), so a failure must never be retried by automation. Any jsign
 * failure writes WIN_SIGN_HALT_FILE, and while that file exists no build logs
 * in to the token at all. A human reads the log, fixes the cause, and deletes
 * the file. A single build cannot spend more than one attempt either: the first
 * failure aborts packaging before any other file is sent to the token.
 *
 * Environment:
 *   WIN_SIGN_PIN        token user PIN; its presence is what turns signing on
 *   WIN_SIGN_JAVA       java.exe used to run jsign
 *   WIN_SIGN_JSIGN_JAR  path to the jsign jar
 *   WIN_SIGN_ALIAS      key alias (the token's key container name)
 *   WIN_SIGN_HALT_FILE  marker that blocks signing after a failure; must survive
 *                       between runs, so it lives outside the job workspace
 */

const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
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
 * Drop files that already carry a valid, trusted signature — the Microsoft,
 * Python Software Foundation and OpenJS binaries among the bundled runtimes.
 * They are not blocked as they are, and re-signing would replace their
 * publisher's signature with ours.
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
      `Where-Object { (Get-AuthenticodeSignature -LiteralPath $_).Status -ne 'Valid' }`
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
  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    try {
      execFileSync(
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
          ...targets.slice(i, i + CHUNK_SIZE),
        ],
        { stdio: 'inherit', env: { ...process.env, WIN_SIGN_PIN: config.pin } },
      )
    } catch (error) {
      // Fail closed: from the exit code alone a wrong PIN is indistinguishable
      // from a timestamp outage, and guessing wrong costs a token attempt.
      writeFileSync(config.haltFile, `${new Date().toISOString()} jsign failed: ${error.message}\n`)
      throw error
    }
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
