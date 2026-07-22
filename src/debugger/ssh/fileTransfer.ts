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

import path from 'node:path';
import { Client as SSHClient } from 'ssh2';
import { logger } from '@vscode/debugadapter';
import { spawn } from 'node:child_process';
import { type ExtendedConnectConfig } from './sshClient';

interface FileTransferOptions {
    connectConfig: ExtendedConnectConfig;
    localPath: string;
    remoteDir: string;
}

export async function transferFile(options: FileTransferOptions): Promise<void> {
    // Try rsync first
    try {
        await transferFileViaRsync(options);
        return;
    } catch (rsyncError: any) {
        const errorMessage = rsyncError.message || '';

        // Check if rsync failed because it's not available on remote
        const isRsyncNotAvailable = errorMessage.includes('cannot execute') || errorMessage.includes('No such file or directory') || errorMessage.includes('command not found') || errorMessage.includes('rsync: not found');

        if (isRsyncNotAvailable) {
            logger.verbose(`[transfer] rsync not available on remote, falling back to SFTP: ${errorMessage}`);
            // Fall back to SFTP
            try {
                await transferFileViaSFTP(options);
                return;
            } catch (sftpError: any) {
                throw new Error(`File transfer failed. rsync error: ${errorMessage}. SFTP error: ${sftpError.message}`);
            }
        } else {
            // rsync failed for another reason
            throw rsyncError;
        }
    }
}

async function transferFileViaRsync(options: FileTransferOptions): Promise<void> {
    const { connectConfig, localPath, remoteDir } = options;
    const { host, port, username, passphrase, password, privateKeyPath } = connectConfig;

    const sshPort = port || 22;
    const filename = path.basename(localPath);
    const remotePath = `${remoteDir}/${filename}`;

    logger.verbose(`[rsync] Transferring ${localPath} to ${username}@${host}:${remotePath} (port ${sshPort})`);

    let command: string;
    let args: string[];

    // Construct rsynccommand and arguments
    if (password) {
        logger.verbose(`[rsync] Using password authentication via sshpass`);
        const sshOptions = `ssh -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
        command = 'sshpass';
        args = ['-p', password, 'rsync', '-az', '-e', sshOptions, localPath, `${username}@${host}:${remotePath}`];
    } else if (privateKeyPath) {
        logger.verbose(`[rsync] Using key-based authentication with ${privateKeyPath}`);
        const sshOptions = `ssh -p ${sshPort} -i ${privateKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;

        if (passphrase) {
            logger.verbose(`[rsync] Key has passphrase, using sshpass`);
            const passphraseStr = typeof passphrase === 'string' ? passphrase : passphrase.toString('utf8');
            command = 'sshpass';
            args = ['-P', 'passphrase', '-p', passphraseStr, 'rsync', '-az', '-e', sshOptions, localPath, `${username}@${host}:${remotePath}`];
        } else {
            command = 'rsync';
            args = ['-az', '-e', sshOptions, localPath, `${username}@${host}:${remotePath}`];
        }
    } else {
        throw new Error('No authentication method available. Either password or privateKeyPath must be provided.');
    }

    // Execute
    await new Promise<void>((resolve, reject) => {
        const rsyncProcess = spawn(command, args);

        let stderr = '';

        rsyncProcess.stdout.on('data', (data: Buffer) => {
            logger.verbose(`[rsync][stdout] ${data.toString()}`);
        });

        rsyncProcess.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
            logger.verbose(`[rsync][stderr] ${data.toString()}`);
        });

        rsyncProcess.on('error', (error: Error) => {
            if (command === 'sshpass') {
                reject(new Error(`Failed to execute sshpass: ${error.message}. ` + `sshpass is required for password/passphrase authentication with rsync. ` + `Please install sshpass or use SSH key-based authentication without passphrase.`));
            } else {
                reject(new Error(`Failed to execute rsync: ${error.message}. Ensure rsync is installed on your system.`));
            }
        });

        rsyncProcess.on('close', (code: number) => {
            if (code === 0) {
                logger.verbose(`[rsync] Transfer completed successfully`);
                resolve();
            } else {
                reject(new Error(`rsync failed with exit code ${code}. stderr: ${stderr}`));
            }
        });
    });
}

async function transferFileViaSFTP(options: FileTransferOptions): Promise<void> {
    const { connectConfig, localPath, remoteDir } = options;
    const { host } = connectConfig;

    const ssh = new SSHClient();
    const filename = path.basename(localPath);
    const remotePath = `${remoteDir}/${filename}`;

    logger.verbose(`[sftp] Transferring ${localPath} to ${remotePath} on ${host}`);

    return new Promise<void>((resolve, reject) => {
        ssh.on('ready', () => {
            ssh.sftp((err, sftp) => {
                if (err) {
                    ssh.end();
                    reject(err);
                    return;
                }

                sftp.fastPut(localPath, remotePath, (uploadErr) => {
                    sftp.end();
                    ssh.end();
                    if (uploadErr) {
                        reject(new Error(`SFTP upload failed: ${uploadErr.message}`));
                    } else {
                        logger.verbose(`[sftp] Transfer completed successfully`);
                        resolve();
                    }
                });
            });
        });

        ssh.on('error', (error: Error) => {
            reject(error);
        });

        ssh.connect(connectConfig);
    });
}
