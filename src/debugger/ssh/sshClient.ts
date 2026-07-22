/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2025, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { type ConnectConfig, utils as ssh2Utils } from 'ssh2';
import { logger } from '@vscode/debugadapter';
import SSHConfig from 'ssh-config';
import { expandTilde } from '../utils';

export interface ExtendedConnectConfig extends ConnectConfig {
    privateKeyPath?: string;
}

interface ParsedSSHConfig {
    hostname?: string;
    user?: string;
    port?: string;
    identityFile?: string;
}

/**
 * Gather SSH credentials and build connection configuration for establishing an SSH session.
 *
 * This function handles the authentication phase by gathering credentials from
 * multiple sources in priority order, checking if keys are encrypted, and prompting for passwords
 * or passphrases only when necessary.
 *
 * High-level flow:
 * 1. Parse ~/.ssh/config for the target host (if available)
 * 2. Determine username: launch config > SSH config > local OS username
 * 3. Determine SSH key: launch config > SSH config > auto-discovered default keys (~/.ssh/id_*)
 * 4. If key found:
 *    - Read the private key file
 *    - Check if encrypted (requires passphrase)
 *    - Prompt for passphrase only if needed
 * 5. If no key found:
 *    - Fall back to password authentication
 *    - Prompt user for password
 * 6. Return connection config that can be used to establish the SSH session
 *
 * This enables a "zero-prompt" experience when default keys exist and are not encrypted.
 */
export async function gatherSSHCredentials(host: string, sshPort: string | undefined, sshUsername?: string, sshKeyPath?: string): Promise<ExtendedConnectConfig> {
    // Get SSH config values (if available)
    const sshConfig = parseSSHConfigForHost(host);

    const resolvedHostname = sshConfig?.hostname || host;
    const resolvedPort = sshPort || sshConfig?.port || '22';

    const localUsername = os.userInfo().username;
    const username = sshUsername || sshConfig?.user || localUsername;

    const resolvedKeyPath = sshKeyPath || (sshConfig?.identityFile ? expandTilde(sshConfig.identityFile) : undefined) || findDefaultSshKey();

    let credentials: { password?: string; privateKey?: Buffer; passphrase?: string; privateKeyPath?: string };
    if (resolvedKeyPath) {
        logger.verbose(`[ssh] Using key-based authentication with key: ${resolvedKeyPath}`);
        const privateKey = fs.readFileSync(resolvedKeyPath);

        const parsedKey = ssh2Utils.parseKey(privateKey);
        const isEncrypted = parsedKey instanceof Error;

        const passphrase = isEncrypted ? await promptForPassphrase(resolvedKeyPath) : undefined;
        credentials = { privateKey, passphrase, privateKeyPath: resolvedKeyPath };
    } else {
        logger.verbose('[ssh] No SSH key found, falling back to password authentication');
        const password = await promptForPassword(username, resolvedHostname);
        credentials = { password };
    }

    return buildConnectConfig(resolvedHostname, resolvedPort, username, credentials);
}

// SSH Connection Configuration
function buildConnectConfig(host: string, port: string | undefined, username: string, credentials: { password?: string; privateKey?: Buffer; passphrase?: string; privateKeyPath?: string }): ExtendedConnectConfig {
    const baseConfig: any = { host, username };
    if (port !== undefined) {
        baseConfig.port = Number(port);
    }

    if (credentials.password) {
        return { ...baseConfig, password: credentials.password };
    }

    if (credentials.privateKey) {
        const keyConfig = credentials.passphrase ? { ...baseConfig, privateKey: credentials.privateKey, passphrase: credentials.passphrase } : { ...baseConfig, privateKey: credentials.privateKey };
        if (credentials.privateKeyPath) {
            keyConfig.privateKeyPath = credentials.privateKeyPath;
        }
        return keyConfig;
    }

    throw new Error('Invalid credentials provided');
}

// SSH Config Parsing
function parseSSHConfigForHost(host: string): ParsedSSHConfig | undefined {
    try {
        const configPath = path.join(os.homedir(), '.ssh', 'config');
        if (!fs.existsSync(configPath)) {
            logger.verbose(`[ssh-config] SSH config file not found at ${configPath}`);
            return undefined;
        }

        const configContent = fs.readFileSync(configPath, 'utf8');
        const config = SSHConfig.parse(configContent);

        // Compute config for this host (handle wildcards, Host *, etc.)
        const computed = config.compute(host);

        const result: ParsedSSHConfig = {
            hostname: Array.isArray(computed.HostName) ? computed.HostName[0] : computed.HostName,
            user: Array.isArray(computed.User) ? computed.User[0] : computed.User,
            port: computed.Port ? (Array.isArray(computed.Port) ? computed.Port[0].toString() : computed.Port.toString()) : undefined,
            identityFile: Array.isArray(computed.IdentityFile) ? computed.IdentityFile[0] : computed.IdentityFile
        };

        logger.verbose(`[ssh-config] Parsed config for ${host}: user=${result.user}, port=${result.port}, identityFile=${result.identityFile}`);
        return result;
    } catch (error: any) {
        logger.verbose(`[ssh-config] Failed to parse SSH config: ${error.message}`);
        return undefined;
    }
}

// User Prompting Functions (SSH Credentials)

async function promptForPassword(username: string, host: string): Promise<string> {
    const password = await vscode.window.showInputBox({
        title: 'SSH Password',
        prompt: `Enter password for ${username}@${host}`,
        password: true,
        ignoreFocusOut: true
    });
    if (!password) {
        throw new Error('SSH password is required.');
    }
    return password;
}

async function promptForPassphrase(keyPath: string): Promise<string> {
    const passphrase = await vscode.window.showInputBox({
        title: 'SSH Key Passphrase Required',
        prompt: `Enter passphrase for encrypted key: ${path.basename(keyPath)}`,
        password: true,
        ignoreFocusOut: true
    });
    if (!passphrase || passphrase.length === 0) {
        throw new Error('SSH key passphrase is required for encrypted keys.');
    }
    return passphrase;
}

// Find default SSH key if it exists
function findDefaultSshKey(): string | undefined {
    const home = os.homedir();
    const defaultKeyPaths = [path.join(home, '.ssh', 'id_rsa'), path.join(home, '.ssh', 'id_ed25519'), path.join(home, '.ssh', 'id_ecdsa'), path.join(home, '.ssh', 'id_dsa')];

    for (const keyPath of defaultKeyPaths) {
        if (fs.existsSync(keyPath)) {
            logger.verbose(`[ssh] Auto-discovered SSH key: ${keyPath}`);
            return keyPath;
        }
    }

    logger.verbose('[ssh] No default SSH key found in ~/.ssh/');
    return undefined;
}
