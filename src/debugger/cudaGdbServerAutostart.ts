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

import { type ClientChannel } from 'ssh2';
import path from 'node:path';
import { gatherSSHCredentials } from './ssh/sshClient';
import { transferFile } from './ssh/fileTransfer';
import { queryRemoteTmpDir, executeRemoteCommand } from './ssh/remoteExecution';
import { escapeShellArg } from './utils';
import { type CudaLaunchRequestArguments } from './cudaGdbSession';

interface ImageAndSymbolArguments {
    symbolFileName?: string;
    symbolOffset?: string;
    imageFileName?: string;
    imageOffset?: string;
}

interface CudaTargetAttachArguments {
    type?: string;
    parameters?: string[];
    host?: string;
    port?: string;
    connectCommands?: string[];
}

export interface CudaTargetLaunchArguments extends CudaTargetAttachArguments {
    serverParameters?: string[];
    server?: string;
    serverPortRegExp?: string;
    cwd?: string;
    serverStartupDelay?: number;
}

export interface CudaTargetAttachRequestArguments extends CudaLaunchRequestArguments {
    server?: string;
    target?: CudaTargetAttachArguments;
    imageAndSymbols?: ImageAndSymbolArguments;
    preRunCommands?: string[];
    serverParameters?: string[];
    sysroot?: string;
}

export interface CudaTargetLaunchRequestArguments extends CudaTargetAttachRequestArguments {
    autostart?: {
        sshPort?: string;
        sshUsername?: string;
        sshKeyPath?: string;
        mode?: 'local' | 'linux-remote' | 'linux-remote-upload';
        remoteExecutable?: string;
    };
    target?: CudaTargetLaunchArguments;
}

export interface CudaQnxTargetLaunchRequestArguments extends CudaTargetAttachRequestArguments {
    autostart?: {
        localCudaGdbServerPath?: string;
        sshPort?: string;
        sshUsername?: string;
        sshKeyPath?: string;
        mode?: 'qnx-remote' | 'qnx-remote-upload';
        remoteUploadPath?: string;
        serverEnvironment?: Array<{ name: string; value: string }>;
    };
    target?: CudaTargetLaunchArguments;
    executableUploadPath?: string;
    sysroot?: string;
}

// Generic implementation for starting cuda-gdbserver over SSH (used for both Linux and QNX)
export async function startGDBServerGeneric(args: CudaQnxTargetLaunchRequestArguments | CudaTargetLaunchRequestArguments): Promise<{ sshChannel: ClientChannel; remoteWorkingDir: string }> {
    const host = args.target!.host ?? 'localhost';
    const target = args.target!;

    // Gather SSH credentials (priority: launch config > SSH config > user input)
    const connectConfig = await gatherSSHCredentials(host, args.autostart?.sshPort, args.autostart?.sshUsername, args.autostart?.sshKeyPath);

    // Use resolved hostname for GDB connection (replaces SSH alias with actual hostname from SSH config if available)
    target.host = connectConfig.host;

    // Determine remote directory: use remoteUploadPath if provided, otherwise query TMPDIR with fallback to /tmp
    const qnxArgs = args as CudaQnxTargetLaunchRequestArguments;
    const remoteWorkingDir = qnxArgs.autostart?.remoteUploadPath ?? (await queryRemoteTmpDir(connectConfig));

    // Set executableUploadPath for QNX so that cdt-gdb-adapter has a remote path to upload the debuggee executable to
    // (For Linux, the executable is either already on target or uploaded by transferFile function below)
    if (args.autostart?.mode?.includes('qnx')) {
        qnxArgs.executableUploadPath = `${remoteWorkingDir}/${path.basename(args.program)}`;
    }

    // Build remote command (cuda-gdbserver)
    const { remoteCmd, uploadSpec } = buildRemoteCommand(args, remoteWorkingDir, connectConfig.host!);

    // Transfer file if needed (rsync, falls back to sftp)
    if (uploadSpec) {
        await transferFile({
            connectConfig,
            localPath: uploadSpec.local,
            remoteDir: uploadSpec.remoteDir
        });
    }

    const { sshChannel } = await executeRemoteCommand({
        connectConfig,
        remoteCmd,
        serverReadyPattern: target.serverPortRegExp,
        serverStartupDelay: target.serverStartupDelay
    });

    return { sshChannel, remoteWorkingDir };
}

// Build remote command for all 4 remote autostart workflows (Linux and QNX)
function buildRemoteCommand(args: CudaTargetLaunchRequestArguments | CudaQnxTargetLaunchRequestArguments, remoteWorkingDir: string, resolvedHostname: string): { remoteCmd: string; uploadSpec?: { local: string; remoteDir: string } } {
    const autostartMode = args.autostart!.mode;
    const serverBinary = args.target!.server ?? 'cuda-gdbserver';
    const target = args.target!;
    const programArgs = args.args! as string[];

    let remoteCmd = '';
    let uploadSpec: { local: string; remoteDir: string } | undefined;

    switch (autostartMode) {
        case 'linux-remote': {
            // Linux: Remote executable already on target
            const linuxArgs = args as CudaTargetLaunchRequestArguments;
            if (!linuxArgs.autostart?.remoteExecutable) {
                throw new Error('autostart.remoteExecutable is required for autostart.mode "linux-remote".');
            }
            const escapedArgs = programArgs.map((arg) => escapeShellArg(arg)).join(' ') ?? '';
            remoteCmd = `${escapeShellArg(serverBinary)} ${escapeShellArg(`${resolvedHostname}:${target.port}`)} ${escapeShellArg(linuxArgs.autostart.remoteExecutable)} ${escapedArgs}`.trim();
            break;
        }

        case 'linux-remote-upload': {
            // Linux: Upload local executable to target
            const linuxArgs = args as CudaTargetLaunchRequestArguments;
            const localExecutable = linuxArgs.program;
            if (!localExecutable || localExecutable.trim().length === 0) {
                throw new Error('Local path to the program to debug must be specified.');
            }
            const basename = path.basename(localExecutable);
            const remotePath = `${remoteWorkingDir}/${basename}`;
            uploadSpec = { local: localExecutable, remoteDir: remoteWorkingDir };
            const escapedArgs = programArgs?.map((arg) => escapeShellArg(arg)).join(' ') ?? '';
            remoteCmd = `chmod +x ${escapeShellArg(remotePath)} && ${escapeShellArg(serverBinary)} ${escapeShellArg(`${resolvedHostname}:${target.port}`)} ${escapeShellArg(remotePath)} ${escapedArgs}`.trim();
            break;
        }

        case 'qnx-remote': {
            // QNX: Use existing cuda-gdbserver on target
            // Debuggee will be uploaded by GDB itself
            const qnxArgs = args as CudaQnxTargetLaunchRequestArguments;
            const remoteCudaGdbServerPath = target.server ?? 'cuda-gdbserver';
            remoteCmd = buildQnxRemoteCommand({ serverPath: remoteCudaGdbServerPath, workingDir: remoteWorkingDir, port: target.port!, serverEnvironment: qnxArgs.autostart?.serverEnvironment });
            break;
        }

        case 'qnx-remote-upload': {
            // QNX: Upload cuda-gdbserver binary to target
            // Debuggee will be uploaded by GDB itself
            const qnxArgs = args as CudaQnxTargetLaunchRequestArguments;
            const localServerPath = qnxArgs.autostart?.localCudaGdbServerPath ?? '/usr/local/cuda/bin/cuda-gdbserver';
            const remoteCudaGdbServerPath = `${remoteWorkingDir}/${path.basename(localServerPath)}`;

            uploadSpec = { local: localServerPath, remoteDir: remoteWorkingDir };
            remoteCmd = buildQnxRemoteCommand({ serverPath: remoteCudaGdbServerPath, workingDir: remoteWorkingDir, port: target.port!, serverEnvironment: qnxArgs.autostart?.serverEnvironment, chmodServer: true });
            break;
        }

        default: {
            throw new Error(`Unknown autostart.mode: ${autostartMode}`);
        }
    }

    return { remoteCmd, uploadSpec };
}

// Build QNX remote command with optional environment variables
function buildQnxRemoteCommand(params: { serverPath: string; workingDir: string; port: string; serverEnvironment?: Array<{ name: string; value: string }>; chmodServer?: boolean }): string {
    const { serverPath, workingDir, port, serverEnvironment, chmodServer } = params;

    // Build environment variable string
    const envVars = serverEnvironment ? serverEnvironment.map(({ name, value }) => `${name}=${escapeShellArg(value)}`).join(' ') : '';

    // Build command parts
    const chmodCmd = chmodServer ? `chmod +x ${serverPath} &&` : '';
    const slayCmd = 'slay -9 -f cuda-gdbserver || true';
    const cdCmd = `cd ${workingDir}`;
    const serverCmd = `${envVars} ${serverPath} ${port}`;

    return `${chmodCmd} ${slayCmd} && ${cdCmd} && ${serverCmd}`;
}
