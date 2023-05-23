/* eslint-disable no-param-reassign */
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
/* eslint-disable max-classes-per-file */
import { DebugProtocol } from '@vscode/debugprotocol';
import { GDBBackend, GDBTargetDebugSession } from 'cdt-gdb-adapter';
import { resolve, isAbsolute } from 'path';
import { ChildProcess } from 'child_process';
import { logger, OutputEvent, TerminatedEvent } from '@vscode/debugadapter';
import { EventEmitter } from 'events';
import { CudaGdbSession, checkCudaGdb, CudaLaunchRequestArguments, CudaGdbBackend } from './cudaGdbSession';

export interface ImageAndSymbolArguments {
    symbolFileName?: string;
    symbolOffset?: string;
    imageFileName?: string;
    imageOffset?: string;
}

export interface CudaTargetAttachArguments {
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
    server?: string;
    target?: CudaTargetLaunchArguments;
    imageAndSymbols?: ImageAndSymbolArguments;
    preRunCommands?: string[];
    serverParameters?: string[];
    sysroot?: string;
}

class CudaGdbServerBackend extends CudaGdbBackend {
    async spawn(args: CudaTargetAttachRequestArguments): Promise<void> {
        await super.spawn(args);
    }
}

export class CudaGdbServerSession extends CudaGdbSession {
    private readonly gdbTargetDebugSession: GDBTargetDebugSession = new GDBTargetDebugSession();

    protected gdbserver?: ChildProcess;

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        await (this.gdbTargetDebugSession as any).setBreakPointsRequest.call(this, response, args);
    }

    protected createBackend(): GDBBackend {
        const backend: CudaGdbBackend = new CudaGdbServerBackend();
        const emitter: EventEmitter = backend as EventEmitter;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
        let logFilePath = args.logFile;
        if (logFilePath && !isAbsolute(logFilePath)) {
            logFilePath = resolve(logFilePath);
        }
        // Logger setup is handled in the base class
        logger.init((outputEvent: OutputEvent) => this.sendEvent(outputEvent), logFilePath, true);

        if (process.platform !== 'linux') {
            response.success = false;
            response.message = 'Unable to launch cuda-gdb on non-Linux system';
            this.sendErrorResponse(response, 1, response.message);
            await super.launchRequest(response, args);

            return;
        }

        const cdtLaunchArgs: CudaTargetAttachRequestArguments = { ...args };

        cdtLaunchArgs.gdb = args.debuggerPath;

        try {
            CudaGdbSession.configureLaunch(args, cdtLaunchArgs);
        } catch (error: any) {
            response.success = false;
            response.message = error.message;
            logger.verbose(`Failed in configureLaunch() with error ${response.message}`);
            this.sendErrorResponse(response, 1, response.message);
            await super.launchRequest(response, args);

            return;
        }

        if (args.args === undefined) {
            cdtLaunchArgs.arguments = args.args;
        }

        const cudaGdbPath = await checkCudaGdb(cdtLaunchArgs.gdb);

        if (cudaGdbPath.kind === 'doesNotExist') {
            response.success = false;
            response.message = `Unable to find cuda-gdb in ${cdtLaunchArgs.gdb}`;
            logger.verbose(`Failed with error ${response.message}`);
            this.sendErrorResponse(response, 1, response.message);

            return;
        }

        logger.verbose('cuda-gdb found and accessible');

        cdtLaunchArgs.gdb = cudaGdbPath.path;

        if (args.stopAtEntry) {
            this.stopAtEntry = true;
        }

        // we want to call cdtLaunchArgs because they have all the information we need from args in a type can be used cdt-gdn-adapter's launchRequest
        await (this.gdbTargetDebugSession as any).launchRequest.call(this, response, cdtLaunchArgs);
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */
    // eslint-disable-next-line class-methods-use-this
    protected async startGDBServer(args: CudaTargetLaunchRequestArguments): Promise<void> {
        // This function will be implemented later when we support autostart
        // For now this function is defined so that we do not inadvertently call cdt-gdb-adapter's implementation of this function
    }
    /* eslint-enable @typescript-eslint/no-unused-vars */

    protected attachOrLaunchRequest(response: DebugProtocol.Response, request: 'launch' | 'attach', args: CudaTargetLaunchRequestArguments): Promise<void> {
        return (this.gdbTargetDebugSession as any).attachOrLaunchRequest.call(this, response, request, args, true);
    }

    protected async startGDBAndAttachToTarget(response: DebugProtocol.AttachResponse | DebugProtocol.LaunchResponse, args: CudaTargetAttachRequestArguments): Promise<void> {
        await (this.gdbTargetDebugSession as any).startGDBAndAttachToTarget.call(this, response, args);
    }
}

/* eslint-enable max-classes-per-file */
/* eslint-enable no-param-reassign */
