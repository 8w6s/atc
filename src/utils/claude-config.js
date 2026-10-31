/**
 * Claude CLI Configuration Utility
 *
 * Handles reading and writing to the global Claude CLI settings file.
 * Location: ~/.claude/settings.json (Windows: %USERPROFILE%\.claude\settings.json)
 *
 * When running as a system service (e.g. systemd), os.homedir() resolves to the
 * service user's home directory, not the actual user's. Set CLAUDE_CONFIG_PATH to
 * the real user's ~/.claude directory to fix this.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';
import { DEFAULT_PRESETS } from '../constants.js';

/**
 * Get the path to the global Claude CLI settings file.
 *
 * Resolution order:
 * 1. CLAUDE_CONFIG_PATH env var (path to .claude directory, e.g. /home/user/.claude)
 * 2. Default: os.homedir()/.claude/settings.json
 *
 * @returns {string} Absolute path to settings.json
 */
export function getClaudeConfigPath() {
    const configDir = process.env.CLAUDE_CONFIG_PATH;
    if (configDir) {
        return path.join(configDir, 'settings.json');
    }
    return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Read the global Claude CLI configuration
 * @returns {Promise<Object>} The configuration object or empty object if file missing
 */
export async function readClaudeConfig() {
    const configPath = getClaudeConfigPath();
    try {
        const content = await fs.readFile(configPath, 'utf8');
        if (!content.trim()) return { env: {} };
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn(`[ClaudeConfig] Config file not found at ${configPath}, returning empty default`);
            return { env: {} };
        }
        if (error instanceof SyntaxError) {
            logger.error(`[ClaudeConfig] Invalid JSON in config at ${configPath}. Returning safe default.`);
            return { env: {} };
        }
        logger.error(`[ClaudeConfig] Failed to read config at ${configPath}:`, error.message);
        throw error;
    }
}

/**
 * Update the global Claude CLI configuration
 * Performs a deep merge with existing configuration to avoid losing other settings.
 *
 * @param {Object} updates - The partial configuration to merge in
 * @returns {Promise<Object>} The updated full configuration
 */
export async function updateClaudeConfig(updates) {
    const configPath = getClaudeConfigPath();
    let currentConfig = {};

    // 1. Read existing config
    try {
        currentConfig = await readClaudeConfig();
    } catch (error) {
        // Ignore ENOENT, otherwise rethrow
        if (error.code !== 'ENOENT') throw error;
    }

    // 2. Deep merge updates
    const newConfig = deepMerge(currentConfig, updates);

    // 3. Ensure .claude directory exists
    const configDir = path.dirname(configPath);
    try {
        await fs.mkdir(configDir, { recursive: true });
    } catch (error) {
        // Ignore if exists
    }

    // 4. Write back to file
    try {
        await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
        logger.info(`[ClaudeConfig] Updated config at ${configPath}`);
        return newConfig;
    } catch (error) {
        logger.error(`[ClaudeConfig] Failed to write config:`, error.message);
        throw error;
    }
}

/**
 * Replace the global Claude CLI configuration entirely
 * Unlike updateClaudeConfig, this replaces the config instead of merging.
 *
 * @param {Object} config - The new configuration to write
 * @returns {Promise<Object>} The written configuration
 */
export async function replaceClaudeConfig(config) {
    const configPath = getClaudeConfigPath();

    // 1. Ensure .claude directory exists
    const configDir = path.dirname(configPath);
    try {
        await fs.mkdir(configDir, { recursive: true });
    } catch (error) {
        // Ignore if exists
    }

    // 2. Write config directly (no merge)
    try {
        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
        logger.info(`[ClaudeConfig] Replaced config at ${configPath}`);
        return config;
    } catch (error) {
        logger.error(`[ClaudeConfig] Failed to write config:`, error.message);
        throw error;
    }
}

/**
 * Simple deep merge for objects
 */
function deepMerge(target, source) {
    const output = { ...target };

    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }

    return output;
}

function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

// ==========================================
// Claude CLI Presets
// ==========================================

/**
 * Get the path to the presets file
 * @returns {string} Absolute path to claude-presets.json
 */
export function getPresetsPath() {
    return path.join(os.homedir(), '.config', 'atc', 'claude-presets.json');
}

/**
 * Read all Claude CLI presets
 * Creates the file with default presets if it doesn't exist.
 * @returns {Promise<Array>} Array of preset objects
 */
export async function readPresets() {
    const presetsPath = getPresetsPath();
    try {
        const content = await fs.readFile(presetsPath, 'utf8');
        if (!content.trim()) return DEFAULT_PRESETS;
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Create with defaults
            try {
                await fs.mkdir(path.dirname(presetsPath), { recursive: true });
                await fs.writeFile(presetsPath, JSON.stringify(DEFAULT_PRESETS, null, 2), 'utf8');
                logger.info(`[ClaudePresets] Created presets file with defaults at ${presetsPath}`);
            } catch (writeError) {
                logger.warn(`[ClaudePresets] Could not create presets file: ${writeError.message}`);
            }
            return DEFAULT_PRESETS;
        }
        if (error instanceof SyntaxError) {
            logger.error(`[ClaudePresets] Invalid JSON in presets at ${presetsPath}. Returning defaults.`);
            return DEFAULT_PRESETS;
        }
        logger.error(`[ClaudePresets] Failed to read presets at ${presetsPath}:`, error.message);
        throw error;
    }
}

/**
 * Save a preset (add or update)
 * @param {string} name - Preset name
 * @param {Object} config - Environment variables to save
 * @returns {Promise<Array>} Updated array of presets
 */
export async function savePreset(name, config) {
    const presetsPath = getPresetsPath();
    let presets = await readPresets();

    const existingIndex = presets.findIndex(p => p.name === name);
    const newPreset = { name, config: { ...config } };

    if (existingIndex >= 0) {
        presets[existingIndex] = newPreset;
        logger.info(`[ClaudePresets] Updated preset: ${name}`);
    } else {
        presets.push(newPreset);
        logger.info(`[ClaudePresets] Created preset: ${name}`);
    }

    try {
        await fs.mkdir(path.dirname(presetsPath), { recursive: true });
        await fs.writeFile(presetsPath, JSON.stringify(presets, null, 2), 'utf8');
    } catch (error) {
        logger.error(`[ClaudePresets] Failed to save preset:`, error.message);
        throw error;
    }

    return presets;
}

/**
 * Delete a preset by name
 * @param {string} name - Preset name to delete
 * @returns {Promise<Array>} Updated array of presets
 */
export async function deletePreset(name) {
    const presetsPath = getPresetsPath();
    let presets = await readPresets();

    const originalLength = presets.length;
    presets = presets.filter(p => p.name !== name);

    if (presets.length === originalLength) {
        logger.warn(`[ClaudePresets] Preset not found: ${name}`);
        return presets;
    }

    try {
        await fs.writeFile(presetsPath, JSON.stringify(presets, null, 2), 'utf8');
        logger.info(`[ClaudePresets] Deleted preset: ${name}`);
    } catch (error) {
        logger.error(`[ClaudePresets] Failed to delete preset:`, error.message);
        throw error;
    }

    return presets;
}

// ==========================================
// Claude Desktop Integration
// ==========================================

/**
 * Get path to Claude Desktop configuration file
 * @returns {string} Absolute path to claude_desktop_config.json
 */
export function getClaudeDesktopConfigPath() {
    if (process.env.CLAUDE_DESKTOP_CONFIG_PATH) {
        return process.env.CLAUDE_DESKTOP_CONFIG_PATH;
    }
    const home = os.homedir();
    const plat = process.platform;
    if (plat === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        return path.join(appData, 'Claude', 'claude_desktop_config.json');
    }
    if (plat === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    // linux / bsd
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(configHome, 'Claude', 'claude_desktop_config.json');
}

/**
 * Read Claude Desktop configuration
 * @returns {Promise<Object>}
 */
export async function readClaudeDesktopConfig() {
    const desktopPath = getClaudeDesktopConfigPath();
    try {
        const content = await fs.readFile(desktopPath, 'utf8');
        if (!content.trim()) return { mcpServers: {} };
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { mcpServers: {} };
        }
        if (error instanceof SyntaxError) {
            logger.warn(`[ClaudeDesktop] Invalid JSON in ${desktopPath}. Using empty default.`);
            return { mcpServers: {} };
        }
        throw error;
    }
}

/**
 * Update Claude Desktop configuration with deep merge
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateClaudeDesktopConfig(updates) {
    const desktopPath = getClaudeDesktopConfigPath();
    let current = {};
    try {
        current = await readClaudeDesktopConfig();
    } catch {
        current = { mcpServers: {} };
    }

    const merged = deepMerge(current, updates);
    const dir = path.dirname(desktopPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(desktopPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    logger.info(`[ClaudeDesktop] Synchronized configuration at ${desktopPath}`);
    return merged;
}

/**
 * Synchronize Claude Desktop integration:
 * - Registers atc MCP endpoint in claude_desktop_config.json
 * - Generates desktop launcher script with proxy environment variables
 *
 * @param {Object} params
 * @param {number} params.port - Proxy listen port
 * @param {string} params.apiKey - Local secret bearer key
 * @returns {Promise<{configPath: string, launcherPath: string, success: boolean}>}
 */
export async function syncClaudeDesktopIntegration({ port = 43128, apiKey = 'atc-local-key' } = {}) {
    const desktopPath = getClaudeDesktopConfigPath();
    const cliEntry = path.resolve(path.join(path.dirname(getClaudeConfigPath()), '..', '.config', 'atc', 'atc-desktop-bridge.js'));

    // 1. Sync MCP server configuration
    const mcpUpdates = {
        mcpServers: {
            atc: {
                command: 'node',
                args: ['-e', `
                    import('http').then(({ get }) => {
                        console.error('[ATC MCP] Bridge running for Claude Desktop on port ${port}');
                    });
                `],
                env: {
                    ANTHROPIC_BASE_URL: `http://localhost:${port}`,
                    ANTHROPIC_API_KEY: apiKey
                }
            }
        }
    };

    await updateClaudeDesktopConfig(mcpUpdates);

    // 2. Generate OS-specific Claude Desktop launcher script
    const atcConfigDir = path.join(os.homedir(), '.config', 'atc');
    await fs.mkdir(atcConfigDir, { recursive: true });

    let launcherPath = '';
    if (process.platform === 'win32') {
        launcherPath = path.join(atcConfigDir, 'launch-claude-desktop.cmd');
        const script = `@echo off\r\n` +
            `title Claude Desktop with atc Proxy\r\n` +
            `set ANTHROPIC_BASE_URL=http://localhost:${port}\r\n` +
            `set ANTHROPIC_API_KEY=${apiKey}\r\n` +
            `echo [atc] Starting Claude Desktop connected to http://localhost:${port}...\r\n` +
            `start "" "%LOCALAPPDATA%\\Programs\\Claude\\Claude.exe"\r\n`;
        await fs.writeFile(launcherPath, script, 'utf8');
    } else {
        launcherPath = path.join(atcConfigDir, 'launch-claude-desktop.sh');
        const script = `#!/bin/sh\n` +
            `export ANTHROPIC_BASE_URL="http://localhost:${port}"\n` +
            `export ANTHROPIC_API_KEY="${apiKey}"\n` +
            `echo "[atc] Launching Claude Desktop with ANTHROPIC_BASE_URL=http://localhost:${port}"\n` +
            `open -a "Claude" 2>/dev/null || claude-desktop 2>/dev/null || echo "Please launch Claude Desktop manually."\n`;
        await fs.writeFile(launcherPath, script, { mode: 0o755 });
    }

    return {
        configPath: desktopPath,
        launcherPath,
        success: true
    };
}

export function getClaudeDesktopLauncherPath() {
    const atcConfigDir = path.join(os.homedir(), '.config', 'atc');
    if (process.platform === 'win32') {
        return path.join(atcConfigDir, 'launch-claude-desktop.cmd');
    }
    return path.join(atcConfigDir, 'launch-claude-desktop.sh');
}

