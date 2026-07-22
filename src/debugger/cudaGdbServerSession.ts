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
import { logger, OutputEvent, TerminatedEvent } from '@vscode/debugadapter';
import { EventEmitter } from 'node:events';
import { CudaGdbSession, CudaGdbBackend } from './cudaGdbSession';
import { type ClientChannel } from 'ssh2';
import { validateGdbServerArgs } from './cudaGdbServerConfig';
import { startGDBServerGeneric, type CudaTargetAttachRequestArguments, type CudaTargetLaunchRequestArguments, type CudaTargetLaunchArguments } from './cudaGdbServerAutostart';

class CudaGdbServerBackend extends CudaGdbBackend {
    async spawn(args: CudaTargetAttachRequestArguments): Promise<void> {
        await super.spawn(args);
    }
}

export class CudaGdbServerSession extends CudaGdbSession {
    private readonly gdbTargetDebugSession: GDBTargetDebugSession = new GDBTargetDebugSession();

    protected gdbserver?: ChildProcess;
    #sshChannel?: ClientChannel;

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        await (this.gdbTargetDebugSession as any).setBreakPointsRequest.call(this, response, args);
    }

    protected createBackend(): GDBBackend {
        const backend: CudaGdbBackend = new CudaGdbServerBackend(this);
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
        return (this.gdbTargetDebugSession as any).setupCommonLoggerAndHandlers.call(this, args);
    }

    /**
     * It is intentional that this function overrides the base class implementation
     */

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: CudaTargetLaunchRequestArguments): Promise<void> {
        logger.verbose('Executing launch request');

        this.initializeLogger(args);

        let ok = await this.validateLinuxPlatform(response);
        if (!ok) {
            // Error response sent within validateLinuxPlatform
            return;
        }

        const cdtLaunchArgs: CudaTargetAttachRequestArguments = { ...args };

        // Assume false for isQNX in the generic server session
        const isQNX = false;

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

        // we want to call cdtLaunchArgs because they have all the information we need from args in a type can be used cdt-gdn-adapter's launchRequest
        logger.verbose('Calling launch request in super class');
        await (this.gdbTargetDebugSession as any).launchRequest.call(this, response, cdtLaunchArgs);
    }

    protected async startGDBServer(args: CudaTargetLaunchRequestArguments): Promise<void> {
        const validated = validateGdbServerArgs(args, {
            defaultPort: '2345',
            requireRemoteHost: false,
            platform: 'linux',
            validAutostartModes: ['local', 'linux-remote', 'linux-remote-upload'] as const
        });

        // Assign validated values back to args
        args.target = validated.target as CudaTargetLaunchArguments;
        args.args = validated.programArgs!;
        args.autostart = args.autostart ?? {};
        args.autostart.sshPort = validated.sshPort;

        // Local autostart: delegate to cdt-gdb-adapter to spawn locally
        if (args.autostart?.mode === 'local') {
            args.target.server = args.target.server ?? 'cuda-gdbserver';
            args.target.serverParameters = ['--once', `:${args.target.port}`, args.program, ...args.args];
            await (this.gdbTargetDebugSession as any).startGDBServer.call(this, args);
            return;
        }

        // Remote autostart over SSH
        const { sshChannel } = await startGDBServerGeneric(args);
        this.#sshChannel = sshChannel;
    }

    protected attachOrLaunchRequest(response: DebugProtocol.Response, request: 'launch' | 'attach', args: CudaTargetLaunchRequestArguments): Promise<void> {
        return (this.gdbTargetDebugSession as any).attachOrLaunchRequest.call(this, response, request, args, true);
    }

    protected async startGDBAndAttachToTarget(response: DebugProtocol.AttachResponse | DebugProtocol.LaunchResponse, args: CudaTargetAttachRequestArguments): Promise<void> {
        await (this.gdbTargetDebugSession as any).startGDBAndAttachToTarget.call(this, response, args);
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
