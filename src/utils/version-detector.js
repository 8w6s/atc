import { execSync } from 'child_process';
import { platform, homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import { config } from '../config.js';

const FALLBACK_USER_AGENT_VERSION = process.env.FALLBACK_ANTIGRAVITY_VERSION || '2.28.2';
const MIN_DETECTED_USER_AGENT_VERSION = '2.0.3';
const FALLBACK_CLIENT_VERSION = process.env.ANTIGRAVITY_CLIENT_VERSION_FALLBACK || '2.28.2';

/*
 * Known (version -> Piper changelist) pairs verified from official releases.
 * Never attach a changelist from one Hub build onto a different overridden
 * version string: mismatched (version, cl) tuples are self-contradictory.
 */
const KNOWN_VERSION_CHANGELISTS = {
    '2.28.2': '1009437749'
};

let cachedUserAgent = null;
let cachedClientVersion = null;
let cachedInstallMeta = undefined;
let loggedVersionInfo = false;

function isVersionHigher(v1, v2) {
    const parts1 = String(v1).split('.').map(Number);
    const parts2 = String(v2).split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return true;
        if (p1 < p2) return false;
    }
    return false;
}

function getResourceDirs() {
    const os = platform();
    const dirs = [];

    if (os === 'darwin') {
        dirs.push('/Applications/Antigravity.app/Contents/Resources');
        dirs.push(join(homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources'));
    } else if (os === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        if (localAppData) {
            dirs.push(join(localAppData, 'Programs', 'Antigravity', 'resources'));
        }
        dirs.push(join(programFiles, 'Antigravity', 'resources'));
    } else {
        dirs.push('/usr/share/antigravity/resources');
        dirs.push('/opt/antigravity/resources');
        dirs.push('/opt/Antigravity/resources');
        dirs.push(join(homedir(), '.local', 'share', 'antigravity', 'resources'));
        dirs.push('/snap/antigravity/current/resources');
    }

    return dirs;
}

/*
 * Antigravity 2.x bundles metadata inside resources/app.asar rather than a
 * flat resources/app/product.json. Parse the Chromium Pickle header directly
 * so startup reads a few kilobytes without unpacking the archive or spawning
 * PowerShell.
 */
function readJsonFromAsar(asarPath, entryName) {
    let fd = null;
    try {
        if (!existsSync(asarPath)) return null;
        fd = openSync(asarPath, 'r');
        const pre = Buffer.alloc(16);
        if (readSync(fd, pre, 0, 16, 0) < 16) return null;

        const headerSize = pre.readUInt32LE(4);
        const jsonLength = pre.readUInt32LE(12);
        if (jsonLength <= 0 || jsonLength > 32 * 1024 * 1024) return null;

        const headerBuf = Buffer.alloc(jsonLength);
        if (readSync(fd, headerBuf, 0, jsonLength, 16) < jsonLength) return null;

        const tree = JSON.parse(headerBuf.toString('utf8'));
        const entry = tree?.files?.[entryName];
        if (!entry || typeof entry.size !== 'number' || entry.offset === undefined) return null;

        const fileOffset = 8 + headerSize + Number(entry.offset);
        const fileBuf = Buffer.alloc(entry.size);
        if (readSync(fd, fileBuf, 0, entry.size, fileOffset) < entry.size) return null;

        return JSON.parse(fileBuf.toString('utf8'));
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try { closeSync(fd); } catch {}
        }
    }
}

function extractChangelistFromBinary(binPath) {
    let fd = null;
    try {
        if (!existsSync(binPath)) return null;
        fd = openSync(binPath, 'r');
        const chunkSize = 2 * 1024 * 1024;
        const overlap = 96;
        const buf = Buffer.allocUnsafe(chunkSize + overlap);
        let position = 0;
        let carryLen = 0;
        const re = /googlefile:\/google_src\/files\/(\d{8,12})\/depot\//;

        while (true) {
            const bytesRead = readSync(fd, buf, carryLen, chunkSize, position);
            if (bytesRead <= 0) break;

            const totalLen = carryLen + bytesRead;
            const text = buf.subarray(0, totalLen).toString('latin1');
            const match = re.exec(text);
            if (match) {
                return match[1];
            }

            if (bytesRead < chunkSize) break;
            position += bytesRead;
            carryLen = Math.min(overlap, totalLen);
            buf.copy(buf, 0, totalLen - carryLen, totalLen);
        }
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try { closeSync(fd); } catch {}
        }
    }
    return null;
}

function getLocalInstallMeta() {
    if (cachedInstallMeta !== undefined) return cachedInstallMeta;

    const binName = platform() === 'win32' ? 'language_server.exe' : 'language_server';

    for (const resDir of getResourceDirs()) {
        const asarPkg = readJsonFromAsar(join(resDir, 'app.asar'), 'package.json');
        if (asarPkg?.version) {
            const cl = extractChangelistFromBinary(join(resDir, 'bin', binName));
            cachedInstallMeta = {
                version: String(asarPkg.version),
                ideVersion: String(asarPkg.ideVersion || asarPkg.version),
                changelist: cl,
                source: 'app.asar'
            };
            return cachedInstallMeta;
        }

        const productPath = join(resDir, 'app', 'product.json');
        try {
            if (existsSync(productPath)) {
                const product = JSON.parse(readFileSync(productPath, 'utf8'));
                if (product && (product.version || product.ideVersion)) {
                    const cl = extractChangelistFromBinary(join(resDir, 'bin', binName));
                    cachedInstallMeta = {
                        version: String(product.ideVersion || product.version),
                        ideVersion: String(product.ideVersion || product.version),
                        changelist: cl,
                        source: 'product.json'
                    };
                    return cachedInstallMeta;
                }
            }
        } catch {
            // Try next candidate directory
        }
    }

    cachedInstallMeta = null;
    return null;
}

function logVersionInfo(version, source) {
    if (loggedVersionInfo) return;
    loggedVersionInfo = true;

    import('./logger.js').then(({ logger }) => {
        logger.debug(`Antigravity version resolved: ${version} (source: ${source})`);
    }).catch(() => {});
}

export function resolveClientVersion({ envVersion, configVersion, productVersion } = {}) {
    if (envVersion) return { version: envVersion, source: 'env' };
    if (configVersion) return { version: String(configVersion), source: 'config' };
    if (productVersion) return { version: productVersion, source: 'product.json' };
    return { version: FALLBACK_CLIENT_VERSION, source: 'fallback' };
}

export function getClientVersion() {
    if (cachedClientVersion) return cachedClientVersion;

    const meta = getLocalInstallMeta();
    const { version, source } = resolveClientVersion({
        envVersion: process.env.ANTIGRAVITY_CLIENT_VERSION,
        configVersion: config?.antigravityClientVersion,
        productVersion: meta?.version
    });
    cachedClientVersion = version;
    logVersionInfo(cachedClientVersion, meta?.source || source);
    return cachedClientVersion;
}

export function resolveUserAgentVersion({ productVersion, localVersion } = {}) {
    if (productVersion && isVersionHigher(productVersion, MIN_DETECTED_USER_AGENT_VERSION)) {
        return { version: productVersion, source: 'product.json' };
    }
    if (localVersion && isVersionHigher(localVersion, MIN_DETECTED_USER_AGENT_VERSION)) {
        return { version: localVersion, source: 'local' };
    }
    return { version: FALLBACK_USER_AGENT_VERSION, source: 'fallback' };
}

function getUserAgentVersionConfig() {
    if (process.env.FALLBACK_ANTIGRAVITY_VERSION) {
        return { version: process.env.FALLBACK_ANTIGRAVITY_VERSION, changelist: null, source: 'env' };
    }

    if (config?.antigravityIdeVersion) {
        return { version: String(config.antigravityIdeVersion), changelist: null, source: 'config' };
    }

    const meta = getLocalInstallMeta();
    const fromInstall = resolveUserAgentVersion({ productVersion: meta?.ideVersion });
    if (fromInstall.source !== 'fallback') {
        return {
            version: fromInstall.version,
            changelist: meta?.changelist || null,
            source: meta?.source || fromInstall.source
        };
    }

    const os = platform();
    let localVersion = null;
    try {
        if (os === 'darwin') {
            localVersion = getVersionMacos();
        } else if (os === 'win32') {
            localVersion = getVersionWindows();
        }
    } catch {
        // Fall through to default
    }

    const resolved = resolveUserAgentVersion({ localVersion });
    return { version: resolved.version, changelist: null, source: resolved.source };
}

function resolveGoPlatform() {
    const os = platform();
    const arch = process.arch;

    const goOs = os === 'win32' ? 'windows' : (os === 'darwin' ? 'darwin' : 'linux');
    let goArch = arch;
    if (arch === 'x64') goArch = 'amd64';
    else if (arch === 'ia32') goArch = '386';

    return { goOs, goArch };
}

export function generateSmartUserAgent() {
    if (cachedUserAgent) return cachedUserAgent;

    const { version, changelist } = getUserAgentVersionConfig();
    const { goOs, goArch } = resolveGoPlatform();

    const explicitCl = process.env.ANTIGRAVITY_CHANGELIST || config?.antigravityChangelist || '';
    const resolvedCl = explicitCl || changelist || KNOWN_VERSION_CHANGELISTS[version] || '';
    const clPart = resolvedCl ? `; cl=${resolvedCl}` : '';

    cachedUserAgent = `antigravity/hub/${version} (aidev_client; os_type=${goOs}; arch=${goArch}${clPart})`;
    return cachedUserAgent;
}

export function resetVersionCache() {
    cachedUserAgent = null;
    cachedClientVersion = null;
    cachedInstallMeta = undefined;
}

function getVersionMacos() {
    const plistPath = '/Applications/Antigravity.app/Contents/Info.plist';
    if (!existsSync(plistPath)) return null;

    try {
        const version = execSync(`plutil -extract CFBundleShortVersionString raw "${plistPath}"`, { encoding: 'utf8' }).trim();
        if (/^\d+\.\d+\.\d+/.test(version)) {
            return version;
        }
    } catch {
        // Ignore
    }
    return null;
}

function getVersionWindows() {
    try {
        const localAppData = process.env.LOCALAPPDATA;
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const possiblePaths = [];
        if (localAppData) {
            possiblePaths.push(join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'));
        }
        possiblePaths.push(join(programFiles, 'Antigravity', 'Antigravity.exe'));

        for (const exePath of possiblePaths) {
            if (existsSync(exePath)) {
                const cmd = `powershell -NoProfile -Command "(Get-Item '${exePath}').VersionInfo.FileVersion"`;
                const version = execSync(cmd, { encoding: 'utf8' }).trim();
                const match = version.match(/^(\d+\.\d+\.\d+)/);
                if (match) return match[1];
            }
        }
    } catch {
        // Ignore
    }
    return null;
}
