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

import { CudaQnxTargetLaunchRequestArguments, CudaTargetLaunchRequestArguments, type CudaTargetLaunchArguments } from './cudaGdbServerAutostart';

interface GdbServerValidationOptions {
    defaultPort: string;
    requireRemoteHost: boolean;
    platform: 'linux' | 'qnx';
    validAutostartModes: readonly string[];
}

interface ValidatedGdbServerArgs {
    sshPort: string;
    target: CudaTargetLaunchArguments;
    programArgs?: string[];
}

export function parseProgramArgs(args?: string | string[]): string[] {
    if (Array.isArray(args)) {
        return args;
    } else if (typeof args === 'string' && args.trim().length > 0) {
        return [args];
    } else {
        return [];
    }
}

export function validateGdbServerArgs(args: CudaQnxTargetLaunchRequestArguments | CudaTargetLaunchRequestArguments, options: GdbServerValidationOptions): ValidatedGdbServerArgs {
    const target = args.target ?? {};

    const host = target.host ?? 'localhost';
    if (options.requireRemoteHost && (host === 'localhost' || host === '127.0.0.1' || host === '::1')) {
        throw new Error(`${options.platform.toUpperCase()} debugging requires a remote host. Please specify target.host in your launch configuration.`);
    }

    const sshPort = args.autostart?.sshPort ?? '22';
    if (!sshPort || Number.isNaN(Number(sshPort)) || Number(sshPort) <= 0) {
        throw new Error(`Invalid SSH port: ${sshPort}`);
    }

    target.port = target.port ?? options.defaultPort;
    if (!target.port || Number.isNaN(Number(target.port)) || Number(target.port) <= 0) {
        throw new Error(`Invalid cuda-gdbserver port: ${target.port}`);
    }

    if (!args.autostart?.mode || !options.validAutostartModes.includes(args.autostart?.mode)) {
        throw new Error(`Invalid autostart.mode: ${args.autostart?.mode}. Expected one of: ${options.validAutostartModes.join(', ')}`);
    }
    const result: ValidatedGdbServerArgs = { sshPort, target };

    // Parse program arguments for Linux. For QNX, this is handled in CudaQnxGdbServerSession.launchRequest().
    if (options.platform === 'linux') {
        result.programArgs = parseProgramArgs(args.args);
    }

    return result;
}
