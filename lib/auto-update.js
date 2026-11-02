/**
 * Auto-update module for dsh-kiro-proxy.
 *
 * Checks GitHub releases for newer versions, downloads the tarball,
 * extracts it over the current installation, and signals the user to restart.
 *
 * @module dsh-kiro-proxy/auto-update
 */

import { createWriteStream } from 'node:fs'
import { mkdir, rm, readdir, copyFile, stat, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const GITHUB_REPO = 'liujiesmart/dsh-kiro-proxy'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

/** Current version from package.json */
let _currentVersion = null

/** Cached update check result */
let _cachedCheck = null
let _lastCheckTime = 0

/**
 * Parse a semver string into [major, minor, patch].
 * @param {string} version - e.g. "0.1.11" or "v0.1.11"
 * @returns {[number, number, number] | null}
 */
function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Compare two semver arrays. Returns -1, 0, or 1.
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

/**
 * Get the current plugin version from package.json.
 * @returns {Promise<string>}
 */
export async function getCurrentVersion() {
  if (_currentVersion) return _currentVersion
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  _currentVersion = pkg.version
  return _currentVersion
}

/**
 * Get the plugin installation directory.
 * @returns {string}
 */
export function getInstallDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Fetch the latest release from GitHub.
 * @param {string} [tag] - specific tag to fetch; omit for latest
 * @returns {Promise<object>} release info
 */
export async function fetchLatestRelease(tag) {
  const url = tag
    ? `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'dsh-kiro-proxy-updater',
    },
  })

  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}: ${await resp.text()}`)
  }

  return resp.json()
}

/**
 * Check if an update is available.
 * @returns {Promise<object>} check result
 */
export async function checkForUpdate() {
  const now = Date.now()
  if (_cachedCheck && (now - _lastCheckTime) < CHECK_INTERVAL_MS) {
    return _cachedCheck
  }

  const current = await getCurrentVersion()
  const currentParsed = parseSemver(current)

  if (!currentParsed) {
    return { error: `Cannot parse current version: ${current}` }
  }

  try {
    const release = await fetchLatestRelease()
    const latest = release.tag_name?.replace(/^v/, '') ?? ''
    const latestParsed = parseSemver(latest)

    if (!latestParsed) {
      return { error: `Cannot parse latest version: ${latest}` }
    }

    const cmp = compareSemver(currentParsed, latestParsed)
    const updateAvailable = cmp < 0

    _cachedCheck = {
      current,
      latest,
      updateAvailable,
      releaseUrl: release.html_url,
      releaseNotes: release.body,
      publishedAt: release.published_at,
      assets: release.assets?.map(a => ({ name: a.name, size: a.size, url: a.browser_download_url })) ?? [],
      tarballUrl: release.tarball_url,
      zipballUrl: release.zipball_url,
      checkedAt: new Date().toISOString(),
    }
    _lastCheckTime = now

    return _cachedCheck
  } catch (error) {
    return {
      current,
      error: error.message,
      checkedAt: new Date().toISOString(),
    }
  }
}

/**
 * Download and extract a release tarball to update the plugin.
 *
 * Flow:
 * 1. Download tarball to temp directory
 * 2. Extract to staging directory
 * 3. Copy files over current installation (preserving user data like settings)
 * 4. Return success with new version info
 *
 * @param {string} [tag] - specific tag; omit for latest
 * @param {(progress: object) => void} [onProgress] - progress callback
 * @returns {Promise<object>} result
 */
export async function applyUpdate(tag, onProgress) {
  const progress = (step, detail) => onProgress?.({ step, detail, time: new Date().toISOString() })

  const previousVersion = await getCurrentVersion()

  progress('check', 'Checking for updates...')
  const release = await fetchLatestRelease(tag)
  const tarballUrl = release.tarball_url

  if (!tarballUrl) {
    throw new Error('No tarball URL in release')
  }

  const installDir = getInstallDir()
  const tempDir = join(installDir, '.update-temp')
  const stagingDir = join(tempDir, 'staging')

  try {
    // Clean up any previous temp
    await rm(tempDir, { recursive: true, force: true })
    await mkdir(stagingDir, { recursive: true })

    progress('download', `Downloading ${release.tag_name}...`)

    // Download tarball (GitHub returns .tar.gz)
    const tarballPath = join(tempDir, 'release.tar.gz')
    const tarballResp = await fetch(tarballUrl, {
      headers: {
        'Accept': 'application/octet-stream',
        'User-Agent': 'dsh-kiro-proxy-updater',
      },
    })

    if (!tarballResp.ok) {
      throw new Error(`Download failed: ${tarballResp.status}`)
    }

    const fileStream = createWriteStream(tarballPath)
    await pipeline(Readable.fromWeb(tarballResp.body), fileStream)

    progress('extract', 'Extracting...')

    // Use Node's built-in tar via child_process (tar is available on all platforms with Git Bash)
    const { spawn } = await import('node:child_process')
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', tarballPath, '-C', stagingDir], {
        stdio: 'pipe',
        windowsHide: true,
      })
      tar.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)))
      tar.on('error', reject)
    })

    progress('install', 'Installing update...')

    // GitHub tarballs have a single top directory like "user-repo-sha/"
    const entries = await readdir(stagingDir)
    const extractedDir = join(stagingDir, entries[0])

    // Files to copy (from extracted to install dir)
    const filesToCopy = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'NOTICE.md']
    const dirsToCopy = ['lib', 'locale', 'docs']

    // Copy individual files
    for (const file of filesToCopy) {
      const src = join(extractedDir, file)
      const dst = join(installDir, file)
      try {
        await copyFile(src, dst)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
        // File might not exist in release, skip
      }
    }

    // Copy directories
    for (const dir of dirsToCopy) {
      const src = join(extractedDir, dir)
      const dst = join(installDir, dir)
      try {
        await rm(dst, { recursive: true, force: true })
        await copyDir(src, dst)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    }

    // Read new version
    const newPkg = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'))

    // Reset cached check
    _cachedCheck = null
    _lastCheckTime = 0
    _currentVersion = null

    progress('done', `Updated to ${newPkg.version}`)

    return {
      success: true,
      previousVersion,
      newVersion: newPkg.version,
      releaseNotes: release.body,
      restartRequired: true,
      message: `Updated from ${previousVersion} to ${newPkg.version}. Please restart DSH to apply changes.`,
    }
  } finally {
    // Clean up temp
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Recursively copy a directory.
 * @param {string} src
 * @param {string} dst
 */
async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const dstPath = join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath)
    } else {
      await copyFile(srcPath, dstPath)
    }
  }
}
