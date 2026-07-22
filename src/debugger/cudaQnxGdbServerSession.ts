/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */
import { type DebugProtocol } from '@vscode/debugprotocol';
import { GDBBackend, GDBTargetDebugSession } from 'cdt-gdb-adapter';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger, OutputEvent, TerminatedEvent } from '@vscode/debugadapter';
import { CudaGdbSession, CudaGdbBackend } from './cudaGdbSession';
import { startGDBServerGeneric, type CudaQnxTargetLaunchRequestArguments, type CudaTargetAttachRequestArguments } from './cudaGdbServerAutostart';
import { type ClientChannel } from 'ssh2';
import { parseProgramArgs, validateGdbServerArgs } from './cudaGdbServerConfig';
import { buildSolibSearchPath } from './utils';

class CudaQNXGdbServerBackend extends CudaGdbBackend {
    async spawn(args: CudaTargetAttachRequestArguments): Promise<void> {
        await super.spawn(args);
    }
}

export class CudaQnxGdbServerSession extends CudaGdbSession {
    private readonly gdbTargetDebugSession: GDBTargetDebugSession = new GDBTargetDebugSession();

    protected gdbserver?: ChildProcess;
    #sshChannel?: ClientChannel;

    protected isInitialized = false;

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        await (this.gdbTargetDebugSession as any).setBreakPointsRequest.call(this, response, args);
    }

    protected createBackend(): GDBBackend {
        const backend: CudaGdbBackend = new CudaQNXGdbServerBackend(this);
        const emitter: EventEmitter = backend as unknown as EventEmitter;

        emitter.on(CudaGdbBackend.eventCudaGdbExit, (code: number, signal: string) => {
            if (code === CudaGdbSession.codeModuleNotFound) {
                this.sendEvent(new OutputEvent('Failed to find cuda-gdb or a dependent library.'));
                this.sendEvent(new TerminatedEvent());
            }
        });

        return backend;
    }

    public async spawn(args: CudaTargetAttachRequestArguments): Promise<void> {
        await (this.gdbTargetDebugSession as any).spawn.call(this, args);
    }

    protected setupCommonLoggerAndHandlers(args: CudaTargetAttachRequestArguments): void {
        (this.gdbTargetDebugSession as any).setupCommonLoggerAndHandlers.call(this, args);
    }

    /**
     * It is intentional that this function overrides the base class implementation
     */

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: CudaQnxTargetLaunchRequestArguments): Promise<void> {
        logger.verbose('Executing launch request');

        this.initializeLogger(args);

        let ok = await this.validateLinuxPlatform(response);
        if (!ok) {
            // Error response sent within validateLinuxPlatform
            return;
        }

        const cdtLaunchArgs: CudaQnxTargetLaunchRequestArguments = { ...args };

        // Assume true for isQNX in the QNX server session
        const isQNX = true;

        ok = await this.runConfigureLaunch(response, args, cdtLaunchArgs, 'LaunchRequest');
        if (!ok) {
            // Error response sent within runConfigureLaunch
            return;
        }

        // This also sets the path if found
        ok = await this.validateAndSetCudaGdbPath(response, cdtLaunchArgs, isQNX);
        if (!ok) {
            // Error response sent within validateAndSetCudaGdbPath
            return;
        }

        if (!cdtLaunchArgs.sysroot || cdtLaunchArgs.sysroot.trim().length === 0) {
            this.sendErrorResponse(response, 1, 'sysroot parameter is required for QNX debugging workflows. Please specify the local directory containing copies of target libraries.');
            return;
        }

        cdtLaunchArgs.preRunCommands = cdtLaunchArgs.preRunCommands || [];

        // Handle debuggee CLI arguments for QNX: add "set args" command to preRunCommands
        // QNX cuda-gdbserver only accepts PORT (no executable/args on command line)
        const programArgs = parseProgramArgs(args.args);
        if (programArgs.length > 0) {
            const escapedArgs = programArgs.join(' ');
            const setArgsCommand = `set args ${escapedArgs}`;
            cdtLaunchArgs.preRunCommands.push(setArgsCommand);
            logger.verbose(`Adding preRunCommand: ${setArgsCommand}`);
        }

        logger.verbose('Calling launch request in super class');
        await (this.gdbTargetDebugSession as any).launchRequest.call(this, response, cdtLaunchArgs);
    }

    protected async startGDBServer(args: CudaQnxTargetLaunchRequestArguments): Promise<void> {
        // No autostart config: assume cuda-gdbserver is already running on the target.
        if (!args.autostart?.mode) {
            return;
        }

        const validated = validateGdbServerArgs(args, {
            defaultPort: '2346',
            requireRemoteHost: true,
            platform: 'qnx',
            validAutostartModes: ['qnx-remote', 'qnx-remote-upload'] as const
        });

        // Assign validated values back to args
        args.target = validated.target;
        args.autostart = args.autostart ?? {};
        args.autostart.sshPort = validated.sshPort;

        // Remote autostart over SSH
        const { sshChannel } = await startGDBServerGeneric(args);
        this.#sshChannel = sshChannel;
    }

    protected attachOrLaunchRequest(response: DebugProtocol.Response, request: 'launch' | 'attach', args: CudaQnxTargetLaunchRequestArguments): Promise<void> {
        return (this.gdbTargetDebugSession as any).attachOrLaunchRequest.call(this, response, request, args, true);
    }

    protected async startGDBAndAttachToTarget(response: DebugProtocol.AttachResponse | DebugProtocol.LaunchResponse, args: CudaQnxTargetLaunchRequestArguments): Promise<void> {
        args.preRunCommands = args.preRunCommands || [];

        const sysroot = args.sysroot!; // Already validated in launchRequest

        // Include the user-provided search path before all directories in the QNX sysroot.
        const solibSearchPath = buildSolibSearchPath(sysroot, args.additionalSOLibSearchPath);

        args.preRunCommands.push(`set sysroot ${sysroot}`, `set solib-search-path ${solibSearchPath}`);

        // executableUploadPath is set by startGDBServerGeneric in autostart modes.
        // In connect-only mode (no autostart) users may set it explicitly via executableUploadPath.
        if (args.executableUploadPath) {
            args.preRunCommands.push(`set nto-executable ${args.executableUploadPath}`);
        } else if (!args.autostart?.mode) {
            logger.warn('executableUploadPath not set in connect-only mode; shared-library resolution and backtraces may be incomplete. Set executableUploadPath to the remote path of the debuggee.');
        }

        await (this.gdbTargetDebugSession as any).startGDBAndAttachToTarget.call(this, response, args, true);
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): Promise<void> {
        try {
            if (this.#sshChannel) {
                logger.verbose('[ssh] Closing SSH channel');
                this.#sshChannel.close();
                this.#sshChannel = undefined;
            }

            // Call parent disconnect (which handles GDB exit and gdbserver cleanup)
            await (this.gdbTargetDebugSession as any).disconnectRequest.call(this, response, args);
        } catch (error) {
            logger.error(`Error during disconnect: ${error instanceof Error ? error.message : String(error)}`);
            this.sendErrorResponse(response, 1, error instanceof Error ? error.message : String(error));
        }
    }
}
