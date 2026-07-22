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

import { Client as SSHClient, type ClientChannel } from 'ssh2';
import { logger } from '@vscode/debugadapter';
import { type ExtendedConnectConfig } from './sshClient';

interface RemoteCommandOptions {
    connectConfig: ExtendedConnectConfig;
    remoteCmd: string;
    serverReadyPattern?: string;
    serverStartupDelay?: number;
}

interface RemoteCommandResult {
    sshClient: SSHClient;
    sshChannel: ClientChannel;
}

export async function queryRemoteTmpDir(connectConfig: ExtendedConnectConfig): Promise<string> {
    const ssh = new SSHClient();
    const host = connectConfig.host;

    return new Promise<string>((resolve, reject) => {
        ssh.on('ready', () => {
            logger.verbose(`[ssh] Querying TMPDIR on ${host}`);
            ssh.exec('echo ${TMPDIR:-/tmp}', (err, stream) => {
                if (err) {
                    ssh.end();
                    reject(err);
                    return;
                }
                let output = '';
                stream.on('data', (data: Buffer) => {
                    output += data.toString();
                });
                stream.on('close', () => {
                    ssh.end();
                    const tmpdir = output.trim();
                    logger.verbose(`[ssh] Resolved TMPDIR: ${tmpdir || '/tmp'}`);
                    resolve(tmpdir || '/tmp');
                });
                stream.stderr.on('data', (data: Buffer) => {
                    logger.verbose(`[ssh] stderr: ${data.toString()}`);
                });
            });
        });

        ssh.on('error', (error: Error) => {
            reject(error);
        });

        const portInfo = connectConfig.port ? `:${connectConfig.port}` : '';
        logger.verbose(`[ssh] Connecting to SSH ${host}${portInfo} to query TMPDIR...`);
        ssh.connect(connectConfig);
    });
}

export async function executeRemoteCommand(options: RemoteCommandOptions): Promise<RemoteCommandResult> {
    const { connectConfig, remoteCmd, serverReadyPattern = 'Listening on|Remote debugging|cuda-gdbserver initialized|cuda-gdbserver started', serverStartupDelay = 15_000 } = options;

    const ssh = new SSHClient();
    const host = connectConfig.host;

    return new Promise<RemoteCommandResult>((resolve, reject) => {
        let resolved = false;

        const onError = (error: Error): void => {
            if (!resolved) {
                resolved = true;
                reject(error);
            }
        };

        const runCommand = (): void => {
            logger.verbose(`[ssh] Executing remote command: ${remoteCmd}`);
            ssh.exec(remoteCmd, { pty: true }, (err: Error | undefined, stream: ClientChannel) => {
                if (err) {
                    onError(err);
                    ssh.end();
                    return;
                }

                let serverReady = false;
                const serverOutput: string[] = [];

                const checkForReady = (): void => {
                    const fullOutput = serverOutput.join('');
                    const regex = new RegExp(serverReadyPattern);
                    if (regex.test(fullOutput) && !serverReady) {
                        serverReady = true;
                        if (!resolved) {
                            resolved = true;
                            resolve({ sshClient: ssh, sshChannel: stream });
                        }
                    }
                };

                const startupTimeout = setTimeout(() => {
                    if (!serverReady && !resolved) {
                        onError(new Error(`Timed out waiting for cuda-gdbserver to start. Output: ${serverOutput.join('')}`));
                        ssh.end();
                    }
                }, serverStartupDelay);

                stream.on('close', () => {
                    clearTimeout(startupTimeout);
                    if (!resolved) {
                        onError(new Error(`cuda-gdbserver exited unexpectedly. Output: ${serverOutput.join('')}`));
                        ssh.end();
                    } else {
                        logger.verbose('[ssh] cuda-gdbserver session ended');
                    }
                });

                stream.stderr.on('data', (data: Buffer) => {
                    const text = data.toString();
                    logger.verbose(`[ssh][stderr] ${text}`);
                    serverOutput.push(text);
                    checkForReady();
                });
                stream.on('data', (data: Buffer) => {
                    const text = data.toString();
                    logger.verbose(`[ssh][stdout] ${text}`);
                    serverOutput.push(text);
                    checkForReady();
                });
            });
        };

        ssh.on('ready', () => {
            const portInfo = connectConfig.port ? `:${connectConfig.port}` : '';
            logger.verbose(`[ssh] SSH connection established to ${host}${portInfo}`);
            runCommand();
        });

        ssh.on('error', onError);
        const portInfo = connectConfig.port ? `:${connectConfig.port}` : '';
        logger.verbose(`[ssh] Connecting to SSH ${host}${portInfo} as ${connectConfig.username}...`);
        ssh.connect(connectConfig);
    });
}
