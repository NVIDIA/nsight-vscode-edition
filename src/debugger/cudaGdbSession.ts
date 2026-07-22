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

import {
    type AttachRequestArguments,
    type CDTDisassembleArguments,
    type FrameVariableReference,
    GDBBackend,
    GDBDebugSession,
    type LaunchRequestArguments,
    type MIBreakpointInfo,
    type MIDataDisassembleResponse,
    type MIResponse,
    type ObjectVariableReference,
    type RegisterVariableReference,
    sendBreakDelete,
    sendBreakList,
    sendDataDisassemble,
    sendExecContinue,
    sendExecFinish,
    sendThreadInfoRequest
} from 'cdt-gdb-adapter';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { BreakpointEvent, ContinuedEvent, ErrorDestination, Event, ExitedEvent, InvalidatedEvent, logger, OutputEvent, Scope, TerminatedEvent, Thread, Variable } from '@vscode/debugadapter';
import { type DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'node:fs';
import { realpath } from 'node:fs/promises';
import which from 'which';
import { CudaDebugProtocol } from './cudaDebugProtocol';
import cudaBuiltins, { type CudaBuiltinsVariableReference } from './cudaBuiltins';
import { tokenizeMiCommand } from './miCommandTokenizer';
import * as types from './types';
import * as utils from './utils';

const CUDA_THREAD = {
    ID: -1,
    NAME: '(CUDA)'
};

// Work around inability to use top-level await when transpiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function deviceRegisterGroups() {
    return (await import('./deviceRegisterGroups.json')).deviceRegisterGroups;
}

function validatePid(input: string | number): string {
    const text = String(input).trim();
    // Canonical positive decimal integer only.
    if (!/^[1-9][0-9]*$/.test(text)) {
        throw new TypeError('invalid process ID');
    }
    const pid = Number(text);
    if (!Number.isSafeInteger(pid)) {
        throw new TypeError('invalid process ID');
    }

    return text;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : `${error}`;
}

class ChangedCudaFocusEvent extends Event implements CudaDebugProtocol.ChangedCudaFocusEvent {
    body: {
        focus?: types.CudaFocus;
    };

    public constructor(focus?: types.CudaFocus) {
        super(CudaDebugProtocol.Event.changedCudaFocus);

        this.body = {
            focus
        };
    }
}

class SystemInfoEvent extends Event implements CudaDebugProtocol.SystemInfoEvent {
    body: {
        systemInfo?: types.SystemInfo;
    };

    public constructor(systemInfo?: types.SystemInfo) {
        super(CudaDebugProtocol.Event.systemInfo);

        this.body = {
            systemInfo
        };
    }
}

export type APIErrorOption = 'stop' | 'hide' | 'ignore';

type Environment = {
    name: string;
    value: string;
};

type CudaGdbPathResult = {
    kind: 'exists';
    path: string;
};

type NoCudaGdbResult = {
    kind: 'doesNotExist';
};

type SetupCommands = {
    text: string;
    description: string;
    ignoreFailures: boolean;
};

type CudaGdbExists = CudaGdbPathResult | NoCudaGdbResult;

type RequestType = 'LaunchRequest' | 'AttachRequest';

export class RegisterData {
    registerGroups: RegisterGroup[];

    constructor(registerGroups: RegisterGroup[]) {
        this.registerGroups = registerGroups;
    }
}

export interface CudaRegisterVariableReference extends RegisterVariableReference {
    type: 'registers';
    isCuda?: boolean;
    registerData?: RegisterData | undefined;
    registerGroup?: RegisterGroup | undefined;
    register?: Register | undefined;
}

export interface ContainerObjectReference extends ObjectVariableReference {
    children?:
        | {
              name: string;
              reference: string | number;
              value: string;
              type: string;
          }[]
        | undefined;
}

export interface CudaLaunchOrAttachCommonRequestArguments {
    debuggerPath?: string;
    miDebuggerPath?: string;
    program: string;
    args?: string | string[];
    miDebuggerArgs?: string | string[];
    verboseLogging?: boolean;
    breakOnLaunch?: boolean;
    onAPIError?: APIErrorOption;
    sysroot?: string;
    additionalSOLibSearchPath?: string;
    environment?: Environment[];
    testMode?: boolean;
    setupCommands?: SetupCommands[];
}

export interface CudaLaunchRequestArguments extends LaunchRequestArguments, CudaLaunchOrAttachCommonRequestArguments {
    type?: string;
    envFile?: string;
    stopAtEntry?: boolean;
}

export interface CudaAttachRequestArguments extends AttachRequestArguments, CudaLaunchOrAttachCommonRequestArguments {
    processId: string;
    port: number;
    address: string;
}

interface RegisterNameValuePair {
    number: string;
    value: string;
}

interface MICudaInfoDevicesResponse extends MIResponse {
    InfoCudaDevicesTable: {
        body: Array<{
            current: string;
            name: string;
            description: string;
            sm_type: string;
        }>;
    };
}

interface MICudaFocusResponse extends MIResponse {
    CudaFocus?: {
        device: string;
        sm: string;
        warp: string;
        lane: string;
        kernel: string;
        grid: string;
        blockIdx: string;
        threadIdx: string;
    };
}

interface MICudaInfoPtxSpecialRegistersResponse extends MIResponse {
    'ptx-special-registers'?: Array<{
        name: string;
        value: string;
    }>;
}

export class CudaGdbBackend extends GDBBackend {
    static readonly eventCudaGdbExit: string = 'cudaGdbExit';

    readonly session: CudaGdbSession;

    /* The most recent sendCommand invocation, if there is one, otherwise a resolved promise.
     * Used to synchronize between concurrent sendCommand calls.
     */
    private lastSendCommandPromise: Promise<any> = Promise.resolve();

    #lastFocus: types.CudaFocus | undefined;

    constructor(session: CudaGdbSession) {
        super();
        this.session = session;
    }

    async sendCommand<T>(command: string): Promise<T> {
        /*
         * We need to ensure that two sendCommand calls can never interleave, otherwise additional commands
         * that we inject to change CUDA focus may end up applying to the wrong gdb command. To do so, for
         * each command, as soon as the promise for it is created, it is stashed away in lastSendCommandPromise,
         * and as soon as the body of that promise starts executing, it awaits on the _previous_ value of
         * lastSendCommandPromise (i.e. on the previous sendCommand call). Thus, if additional calls happen
         * while one is already ongoing, they will form an await chain, and all calls will always execute in
         * sequence without interleaving.
         */

        const lastPromise = this.lastSendCommandPromise;
        const thisPromise = (async () => {
            try {
                await lastPromise;
            } catch {
                // We don't care if the last command failed or not. We just want to wait for it to complete.
            }
            if (command.startsWith('-')) {
                return await this.sendMICommand<T>(command);
            }
            this.#lastFocus = undefined;
            return await super.sendCommand<T>(command);
        })();

        this.lastSendCommandPromise = thisPromise;
        return await thisPromise;
    }

    private async sendMICommand<T>(command: string): Promise<T> {
        /*
         * Parse MI commands and patch them up as needed before sending them to cuda-gdb.
         */

        const tokens = tokenizeMiCommand(command);

        if (tokens[0] === '-break-insert') {
            tokens.splice(1, 0, '-f');
        }

        const lastFocus = this.#lastFocus;
        this.#lastFocus = undefined;

        /* If this command has --thread, it is directed at a specific thread and possibly at a specific frame.
         * If that is a regular CPU thread, we don't need to do anything special. But if it is our dummy CUDA
         * thread, we need to inject additional commands to set the CUDA focus and select a frame accordingly,
         * and then patch up the original command to remove --thread and --frame so it uses the selection.
         * This cannot be done in a single command because there is no equivalent of --thread for CUDA threads
         * in cuda-gdb at present, and --frame cannot be used without --thread.
         */
        const threadPos = tokens.indexOf('--thread');
        if (threadPos >= 0) {
            const threadId = Number.parseInt(tokens[threadPos + 1], 10);
            if (threadId === CUDA_THREAD.ID) {
                tokens.splice(threadPos, 2);

                const focus = this.session.cudaFocus;
                if (focus === undefined) {
                    throw new Error('No CUDA thread in focus.');
                }

                const framePos = tokens.indexOf('--frame');
                let frameId: string | undefined;
                if (framePos >= 0) {
                    frameId = tokens[framePos + 1];
                    tokens.splice(framePos, 2);
                }

                if (!utils.equalsCudaFocus(focus, lastFocus)) {
                    const setFocusCommand: string = utils.formatSetFocusCommand(focus);
                    await super.sendCommand(setFocusCommand);
                    if (frameId !== undefined) {
                        await super.sendCommand(`-stack-select-frame ${frameId}`);
                    }
                }

                this.#lastFocus = focus;
            }
        }

        command = tokens.join(' ');
        return await super.sendCommand<T>(command);
    }

    async spawn(requestArgs: CudaLaunchRequestArguments | CudaAttachRequestArguments): Promise<void> {
        await super.spawn(requestArgs);

        if (this.proc) {
            this.proc.on('exit', (code: number, signal: string) => {
                const emitter: EventEmitter = this as unknown as EventEmitter;
                emitter.emit(CudaGdbBackend.eventCudaGdbExit, code, signal);
            });
        }

        if (requestArgs.sysroot) {
            requestArgs.initCommands?.push(`set sysroot ${requestArgs.sysroot}`);
        }

        if (requestArgs.additionalSOLibSearchPath) {
            requestArgs.initCommands?.push(`set solib-search-path ${requestArgs.additionalSOLibSearchPath}`);
        }

        if (requestArgs.miDebuggerArgs) {
            requestArgs.gdbArguments = typeof requestArgs.miDebuggerArgs === 'string' ? [requestArgs.miDebuggerArgs] : (requestArgs.gdbArguments = requestArgs.miDebuggerArgs);
        }
    }
}

interface LaunchEnvVarSpec {
    type: 'set' | 'unset';
    name: string;
    value?: string;
}

class RegisterGroup {
    groupName: string;

    groupPattern: RegExp;

    isPredicate: boolean;

    isHidden: boolean;

    registers: Register[];

    constructor(groupName: string, groupPattern: string, isPredicate: boolean, isHidden: boolean) {
        this.groupName = groupName;
        this.groupPattern = new RegExp(groupPattern);
        this.isPredicate = isPredicate;
        this.isHidden = isHidden;
        this.registers = [];
    }
}

class Register {
    ordinal: number;

    name: string;

    group: RegisterGroup;

    constructor(ordinal: number, name: string, group: RegisterGroup) {
        this.ordinal = ordinal;
        this.name = name;
        this.group = group;
    }
}

export class CudaGdbSession extends GDBDebugSession {
    static readonly codeModuleNotFound: number = 127;

    /* cuda-gdb does not treat GPU threads as first-class objects like CPU threads; but in DAP,
     * all frame object must belong to some DAP thread object. Thus we maintain a single dummy
     * DAP thread that corresponds to the GPU thread currently in focus.
     */
    private readonly cudaThread: Thread = new Thread(CUDA_THREAD.ID, CUDA_THREAD.NAME);

    protected clientInitArgs: DebugProtocol.InitializeRequestArguments | undefined;

    protected stopAtEntry = false;

    protected testMode = false;

    protected telemetryInfoSent = false;

    protected instructionBreakpoints = new Set<string>();

    // Tracks whether the client has been told the inferior is stopped, so we can
    // pair every StoppedEvent with a matching ContinuedEvent when cuda-gdb resumes
    // on its own. See handleGDBAsync for context.
    //
    // Any user-initiated resume handler must reset this before delegating,
    // else handleGDBAsync emits a duplicate ContinuedEvent. Currently:
    // next/stepIn/stepOut/continue.
    private clientThinksStopped = false;

    private _cudaFocus: types.CudaFocus | undefined;

    public get cudaFocus(): types.CudaFocus | undefined {
        return this._cudaFocus;
    }

    private set cudaFocus(newFocus) {
        if (!utils.equalsCudaFocus(newFocus, this._cudaFocus)) {
            this._cudaFocus = newFocus;
            this.sendEvent(new ChangedCudaFocusEvent(newFocus));
        }
    }

    private hasValidFocus(): boolean {
        return utils.isCudaFocusValid(this.cudaFocus);
    }

    protected createBackend(): GDBBackend {
        const backend: CudaGdbBackend = new CudaGdbBackend(this);
        const emitter: EventEmitter = backend as unknown as EventEmitter;

        emitter.on(CudaGdbBackend.eventCudaGdbExit, (code: number, signal: string) => {
            if (code === CudaGdbSession.codeModuleNotFound) {
                this.sendEvent(new OutputEvent('Failed to find cuda-gdb or a dependent library.'));
                this.sendEvent(new TerminatedEvent());
            }
        });

        return backend;
    }

    public start(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream): void {
        // Defined for debugging
        super.start(inStream, outStream);
    }

    public shutdown(): void {
        // Defined for debugging
        super.shutdown();
    }

    public sendEvent(event: DebugProtocol.Event): void {
        // Defined for debugging
        super.sendEvent(event);
    }

    public sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): void {
        // Defined for debugging
        super.sendRequest(command, args, timeout, cb);
    }

    public sendResponse(response: DebugProtocol.Response): void {
        // Defined for debugging
        super.sendResponse(response);
    }

    protected sendErrorResponse(response: DebugProtocol.Response, codeOrMessage: number | DebugProtocol.Message, format?: string, variables?: any, dest: ErrorDestination = ErrorDestination.User): void {
        // Defined for debugging
        super.sendErrorResponse(response, codeOrMessage, format, variables, dest);
    }

    protected dispatchRequest(request: DebugProtocol.Request): void {
        super.dispatchRequest(request);
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {
        switch (command) {
            case CudaDebugProtocol.Request.changeCudaFocus: {
                this.changeCudaFocusRequest(response as CudaDebugProtocol.ChangeCudaFocusResponse, args);
                break;
            }
            default: {
                super.customRequest(command, response, args);
                break;
            }
        }
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: CudaLaunchRequestArguments): Promise<void> {
        logger.verbose('Executing launch request');

        this.initializeLogger(args);

        let ok = await this.validateLinuxPlatform(response);
        if (!ok) {
            // Error response sent within validateLinuxPlatform
            return;
        }

        const cdtLaunchArgs: LaunchRequestArguments = { ...args };

        // Remove the cast - type is now part of CudaLaunchRequestArguments
        const isQNX = args.type === 'cuda-qnx-gdbserver';

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

        this.testMode = args.testMode ?? false;

        logger.verbose('Calling launch request in super class');
        await super.launchRequest(response, cdtLaunchArgs);
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: CudaAttachRequestArguments): Promise<void> {
        logger.verbose('Executing attach request');
        this.isAttach = true;
        // Handles rare case that the process picker is not used and the user manually enters the pid
        // Or it's hardcoded in the launch.json config
        let pid = String(args.processId);
        let processExecName = '';

        if (typeof args.processId === 'string') {
            logger.verbose(`Process ID ${args.processId} was given as a string. Further processing needed.`);
            // Split pid:label format
            const separatorIndex = pid.indexOf(':');
            if (separatorIndex !== -1) {
                processExecName = pid.slice(separatorIndex + 1);
                pid = pid.slice(0, separatorIndex);
            }
        }
        try {
            pid = validatePid(pid);
            // realpath resolves symlink to the canonical absolute path and detects "(deleted)"
            const programPath = await realpath(`/proc/${pid}/exe`);
            args.processId = pid;
            args.program = programPath;
            logger.verbose('processed process ID as string');
        } catch (error) {
            response.success = false;
            const processNameString = processExecName ? ` (process name: ${processExecName})` : '';
            response.message = `Unable to attach to pid ${pid}${processNameString}: ${getErrorMessage(error)}`;
            logger.verbose(`Failed to obtain PID with error ${response.message}`);
            this.sendErrorResponse(response, 1, response.message);

            return;
        }

        this.initializeLogger(args);

        let ok = await this.validateLinuxPlatform(response);
        if (!ok) {
            // Error response sent within validateLinuxPlatform
            return;
        }

        // 0 is requires for cuda-gdb to attach to non-children
        const ptraceScopeFile = '/proc/sys/kernel/yama/ptrace_scope';

        if (fs.existsSync(ptraceScopeFile)) {
            const ptraceScope = fs.readFileSync(ptraceScopeFile, 'ascii');
            const ptraceLocked = ptraceScope.trim() !== '0';

            if (ptraceLocked) {
                response.success = false;
                response.message = 'Please try running echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope ';
                logger.verbose(response.message);
                this.sendErrorResponse(response, 1, response.message);

                return;
            }
        }

        if (!args.port) {
            const defaultPort = 5858;
            args.port = defaultPort;
        }

        if (args.address === 'localhost') {
            const defaultAddress = '127.0.0.1';
            args.address = defaultAddress;
        }

        const cdtAttachArgs: AttachRequestArguments = { ...args };

        const isQNX = args.debuggerPath?.endsWith('cuda-qnx-gdb') ?? false;

        ok = await this.runConfigureLaunch(response, args, cdtAttachArgs, 'AttachRequest');
        if (!ok) {
            // Error response sent within runConfigureLaunch
            return;
        }

        // Rename call site
        ok = await this.validateAndSetCudaGdbPath(response, cdtAttachArgs, isQNX);
        if (!ok) {
            // Error response sent within validateAndSetCudaGdbPath
            return;
        }

        logger.verbose('Attach request completed');
        await super.attachRequest(response, cdtAttachArgs);
    }

    protected async configureLaunch(args: CudaAttachRequestArguments | CudaLaunchRequestArguments, cdtArgs: AttachRequestArguments | LaunchRequestArguments, requestType: RequestType): Promise<void> {
        if (args.verboseLogging !== undefined) {
            cdtArgs.verbose = args.verboseLogging;
        }

        if (!cdtArgs.initCommands) {
            cdtArgs.initCommands = [];
        }

        await this.configureSetupCommands(args, cdtArgs);

        if ('cwd' in args && args.cwd) {
            cdtArgs.initCommands.push(`set cwd ${args.cwd}`);
        }

        if (args.breakOnLaunch) {
            cdtArgs.initCommands.push('set cuda break_on_launch application');
        }

        if (args.onAPIError) {
            cdtArgs.initCommands.push(`set cuda api_failures ${args.onAPIError}`);
        }

        if (args.environment) {
            setEnvVars(args.environment);
        }

        configureEnvfile(args, cdtArgs);

        if (requestType === 'LaunchRequest' && hasDebuggeeArguments(args.args)) {
            (cdtArgs as CudaLaunchRequestArguments).arguments = parseArgs(args.args);
        }

        cdtArgs.gdb = args.miDebuggerPath || args.debuggerPath;

        if ('stopAtEntry' in args && args.stopAtEntry && requestType === 'LaunchRequest') {
            this.stopAtEntry = true;
        }
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): Promise<void> {
        if (this.stopAtEntry) {
            try {
                await this.gdb.sendCommand('start');
                this.sendResponse(response);
            } catch (error) {
                this.sendErrorResponse(response, 100, (error as Error).message);
            }
        } else {
            super.configurationDoneRequest(response, args);
        }
    }

    /*
     * Three workarounds for cuda-gdb 13.2 attach-flow behavior, all fixed in
     * cuda-gdb 13.3+ and removable once that is the minimum supported version:
     *   (1) drop the malformed empty *stopped emitted during libcudadebugger
     *       fork-detach;
     *   (2) tag reasonless *stopped during the post-attach interrupt window so
     *       the parent's signal-received suppression catches it;
     *   (3) emit a ContinuedEvent when cuda-gdb resumes itself after (1), since
     *       cdt-gdb-adapter only signals continues via the response to a request
     *       and not for unsolicited resumes (per DAP convention).
     * See each block below for more details.
     */
    protected async handleGDBAsync(resultClass: string, resultData: any): Promise<void> {
        let cudaFocusRecord: any = undefined;
        if (resultClass === 'stopped') {
            // cuda-gdb emits an empty *stopped (no thread-id, no reason) during post-attach
            // internal thread switching and resumes itself moments later. Forwarding it as a
            // DAP StoppedEvent gives {threadId:null, reason:"generic"} and desynchronizes
            // VSCode from cuda-gdb.
            if (!resultData['thread-id'] && !resultData.reason && !resultData.CudaFocus) {
                return;
            }

            // cuda-gdb 13.2 sometimes leaves the `reason` field off the *stopped
            // it sends in response to our -exec-interrupt during post-attach. The
            // parent only suppresses these when reason is 'signal-received', so
            // without help they get forwarded as stopped events with reason="generic".
            // Set the reason ourselves so the parent treats it normally.
            if (this.waitPaused && !resultData.reason) {
                resultData.reason = 'signal-received';
            }

            /*
             * If the event occurred on a GPU thread, MI record will have CudaFocus field with fields like:
             *
             *     blockIdx:'(0,0,0)'
             *     device:'0'
             *     grid:'1'
             *     kernel:'0'
             *     lane:'0'
             *     sm:'0'
             *     threadIdx:'(0,0,0)'
             *     warp:'0'
             *
             * thread-id field is also present in the record, but does not correspond to anything meaningful
             * because GPU threads do not have IDs in cuda-gdb.
             */
            cudaFocusRecord = resultData.CudaFocus;
            if (cudaFocusRecord !== undefined) {
                /* Make it look like it came from our dummy CUDA DAP thread before delegating event processing
                 * to GDBDebugSession.
                 */
                resultData['thread-id'] = this.cudaThread.id.toString();

                this.cudaFocus = {
                    type: 'software',
                    blockIdx: utils.parseCudaDim(resultData.CudaFocus.blockIdx),
                    threadIdx: utils.parseCudaDim(resultData.CudaFocus.threadIdx)
                };
            } else {
                this.cudaFocus = undefined;
            }
        }

        const wasRunning = this.isRunning;
        super.handleGDBAsync(resultClass, resultData);

        // cuda-gdb 13.2 may resume the inferior on its own after the silent stop
        // suppressed above (no user request triggered it). cdt-gdb-adapter signals
        // continues via the response to a continue/step request, not via
        // ContinuedEvent, so unsolicited resumes leave VSCode's UI stuck in the
        // previous stopped state. The next user command then fails with "Cannot
        // execute this command while the selected thread is running".
        if (resultClass === 'running' && this.isInitialized && !wasRunning && this.isRunning && this.clientThinksStopped) {
            this.clientThinksStopped = false;
            const allThreadsContinued = !this.gdb.isNonStopMode() || resultData['thread-id'] === 'all';
            const threadId = allThreadsContinued ? (this.threads[0]?.id ?? this.cudaThread.id) : Number.parseInt(resultData['thread-id'], 10);
            this.sendEvent(new ContinuedEvent(threadId, allThreadsContinued));
        }

        if (cudaFocusRecord !== undefined && !this.telemetryInfoSent) {
            this.telemetryInfoSent = true;
            const systemInfo = await getSystemInfo(this.gdb);
            this.sendEvent(new SystemInfoEvent(systemInfo));
        }
    }

    protected sendStoppedEvent(reason: string, threadId: number, allThreadsStopped?: boolean): void {
        this.clientThinksStopped = true;
        super.sendStoppedEvent(reason, threadId, allThreadsStopped);
    }

    protected handleGDBNotify(notifyClass: string, notifyData: any): void {
        switch (notifyClass) {
            case 'breakpoint-modified': {
                const miBreakpoint: MIBreakpointInfo = notifyData.bkpt as MIBreakpointInfo;
                this.updateBreakpointLocation(miBreakpoint);
                return;
            }
            case 'thread-group-exited': {
                const exitCode = notifyData['exit-code'];
                if (exitCode !== undefined) {
                    this.sendEvent(new ExitedEvent(exitCode));
                }
                break;
            }
            default:
        }

        super.handleGDBNotify(notifyClass, notifyData);
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        this.clientInitArgs = args;
        this.forceBreakpointConditions = true;

        response.body = response.body || {};
        response.body.supportsInstructionBreakpoints = true;

        super.initializeRequest(response, args);
    }

    protected updateBreakpointLocation(miBreakpoint: MIBreakpointInfo): void {
        try {
            // Check if breakpoint is pending (address not yet valid).
            // Useful for CUDA kernels, which get loaded into memory at runtime.
            const isPending = miBreakpoint.addr === '<PENDING>' || miBreakpoint.addr === undefined;

            const breakpoint: DebugProtocol.Breakpoint = {
                id: Number.parseInt(miBreakpoint.number, 10),
                verified: !isPending
            };
            if (miBreakpoint.line) {
                breakpoint.line = Number.parseInt(miBreakpoint.line, 10);
            }
            this.sendEvent(new BreakpointEvent('changed', breakpoint));
        } catch (error) {
            const message = `Failed to update breakpoint location: ${(error as Error).message}`;
            logger.error(message);
        }
    }

    /**
     * Handle instruction breakpoints (address-based breakpoints).
     *
     * WARNING: This function has significant code overlap with setBreakPointsRequest
     * (in GDBDebugSession). If you're changing this function, you probably need to change
     * setBreakPointsRequest as well to maintain consistency.
     */
    protected async setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments): Promise<void> {
        return this.withWaitPausedMutex(() => this.setInstructionBreakpointsRequestLocked(response, args));
    }

    private async setInstructionBreakpointsRequestLocked(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments): Promise<void> {
        this.waitPausedNeeded = this.isRunning;
        if (this.waitPausedNeeded) {
            // Need to pause first
            const waitPromise = new Promise<void>((resolve) => {
                this.waitPaused = resolve;
            });
            this.waitPausedSurfacesToUser = false;
            if (this.gdb.isNonStopMode()) {
                const threadInfo = await sendThreadInfoRequest(this.gdb, {});
                this.waitPausedThreadId = Number.parseInt(threadInfo['current-thread-id'], 10);
                this.gdb.pause(this.waitPausedThreadId);
            } else {
                this.gdb.pause();
            }
            await waitPromise;
        }
        try {
            // Get the list of current GDB instruction breakpoints
            const result = await sendBreakList(this.gdb);
            const gdbbps = result.BreakpointTable.body.filter((gdbbp) => {
                // Ignore "children" breakpoint of <MULTIPLE> entries
                if (gdbbp.number.includes('.')) {
                    return false;
                }
                if (!gdbbp['original-location']) {
                    return false;
                }
                // Ignore non-instruction (non-address-based) breakpoints
                if (!gdbbp['original-location'].startsWith('*')) {
                    return false;
                }
                return true;
            });

            // Calculate the actual target address from instructionReference + offset
            const calculateTargetAddress = (bp: DebugProtocol.InstructionBreakpoint): string => {
                const baseAddr = BigInt(bp.instructionReference);
                const offset = BigInt(bp.offset || 0);
                const targetAddr = baseAddr + offset;
                return '0x' + targetAddr.toString(16);
            };
            // Normalize addresses for comparison (remove * prefix, handle case)
            const normalizeAddress = (addr: string): string => addr.replace(/^\*/, '').toLowerCase();

            const { resolved, deletes } = this.resolveBreakpoints(args.breakpoints || [], gdbbps, (vsbp, gdbbp) => {
                // Calculate the target address VS Code wants
                const vsbpAddr = normalizeAddress(calculateTargetAddress(vsbp));
                // Extract the address from GDB's original-location (format: "*0x1234")
                const gdbbpAddr = normalizeAddress(gdbbp['original-location'] || '');
                if (vsbpAddr !== gdbbpAddr) {
                    return false;
                }
                // Always invalidate hit conditions (they have one-way mapping to GDB ignore/temporary)
                if (vsbp.hitCondition) {
                    return false;
                }
                // Ensure we can compare undefined and empty strings
                const vsbpCond = vsbp.condition || undefined;
                const gdbbpCond = gdbbp.cond || undefined;
                return vsbpCond === gdbbpCond;
            });
            // Delete before insert to avoid breakpoint clashes
            if (deletes.length > 0) {
                await sendBreakDelete(this.gdb, { breakpoints: deletes });
                for (const bpId of deletes) {
                    this.instructionBreakpoints.delete(bpId);
                }
            }
            const createState = (vsbp: DebugProtocol.InstructionBreakpoint, gdbbp: MIBreakpointInfo): DebugProtocol.Breakpoint => {
                // Check if breakpoint is pending (address not yet valid).
                // Useful for CUDA kernels, which get loaded into memory at runtime.
                const isPending = gdbbp.addr === '<PENDING>' || gdbbp.addr === undefined;
                const result: DebugProtocol.Breakpoint = {
                    id: Number.parseInt(gdbbp.number, 10),
                    verified: !isPending,
                    instructionReference: vsbp.instructionReference
                };
                if (vsbp.offset !== undefined) {
                    result.offset = vsbp.offset;
                }
                return result;
            };
            const actual: DebugProtocol.Breakpoint[] = [];
            for (const bp of resolved) {
                if (bp.gdbbp) {
                    this.instructionBreakpoints.add(bp.gdbbp.number);
                    actual.push(createState(bp.vsbp, bp.gdbbp));
                    continue;
                }
                let temporary = false;
                let ignoreCount: number | undefined;
                const vsbp = bp.vsbp;
                if (vsbp.hitCondition !== undefined) {
                    const ignoreCountRegex = /^\d+$/;
                    ignoreCount = Number.parseInt(vsbp.hitCondition.replace(ignoreCountRegex, ''), 10);
                    if (Number.isNaN(ignoreCount)) {
                        this.sendEvent(new OutputEvent(`Unable to decode expression: ${vsbp.hitCondition}`));
                        continue;
                    }
                    // Allow hit condition continuously above the count
                    temporary = !vsbp.hitCondition.startsWith('>');
                    if (temporary) {
                        // The expression is not 'greater than', decrease ignoreCount to match
                        ignoreCount--;
                    }
                }

                try {
                    const targetAddress = calculateTargetAddress(vsbp);
                    const gdbbp = await this.insertAddressBreakpoint(targetAddress, temporary, ignoreCount, vsbp.condition);

                    this.instructionBreakpoints.add(gdbbp.number);
                    actual.push(createState(vsbp, gdbbp));
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    const errorBp: DebugProtocol.Breakpoint = {
                        verified: false,
                        instructionReference: vsbp.instructionReference,
                        message: errorMsg
                    };
                    if (vsbp.offset !== undefined) {
                        errorBp.offset = vsbp.offset;
                    }
                    actual.push(errorBp);
                }
            }
            response.body = {
                breakpoints: actual
            };
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, 1, error instanceof Error ? error.message : String(error));
        }
        if (this.waitPausedNeeded) {
            await (this.gdb.isNonStopMode() ? sendExecContinue(this.gdb, this.waitPausedThreadId) : sendExecContinue(this.gdb));
        }
    }

    /**
     * Insert an address-based breakpoint directly using GDB MI commands.
     * This bypasses cdt-gdb-adapter's sendBreakInsert because it would format the address incorrectly.
     */
    private async insertAddressBreakpoint(address: string, temporary: boolean, ignoreCount: number | undefined, condition: string | undefined): Promise<MIBreakpointInfo> {
        // Construct the GDB -break-insert command with address syntax
        const breakInsertCommand = [
            temporary ? '-t' : '',
            this.gdb.isUseHWBreakpoint() ? '-h' : '',
            ignoreCount ? `-i ${ignoreCount}` : '',
            '-f', // Pending breakpoints are useful for CUDA kernels loaded at runtime
            `*${address}`
        ]
            .filter(Boolean)
            .join(' ');

        const rawResult = await this.gdb.sendCommand<{ bkpt: MIBreakpointInfo | MIBreakpointInfo[] }>(`-break-insert ${breakInsertCommand}`);

        // Handle the response - GDB may return an array if multiple breakpoints are created
        let bkpt = rawResult.bkpt;
        if (Array.isArray(bkpt)) {
            bkpt = bkpt[0];
        }
        const gdbbp = bkpt as MIBreakpointInfo;

        if (condition) {
            const forceConditionArg = this.forceBreakpointConditions ? '--force ' : '';
            await this.gdb.sendCommand(`-break-condition ${forceConditionArg}${gdbbp.number} ${condition}`);
        }

        return gdbbp;
    }

    protected handleGDBStopped(result: any): void {
        // Check if this is an instruction breakpoint hit.
        // Instruction breakpoints are handled here because we want to avoid changing the cdt-gdb-adapter code.
        if (result.reason === 'breakpoint-hit' && this.instructionBreakpoints.has(result.bkptno)) {
            const getThreadId = (resultData: any): number => Number.parseInt(resultData['thread-id'], 10);
            const getAllThreadsStopped = (resultData: any): boolean => !!resultData['stopped-threads'] && resultData['stopped-threads'] === 'all';

            this.sendStoppedEvent('instruction breakpoint', getThreadId(result), getAllThreadsStopped(result));
            return;
        }

        // Let the base class handle all other cases
        super.handleGDBStopped(result);
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        try {
            await this.updateThreadList();

            // Create a copy of the thread list and add our fake CUDA thread to the end
            const augmentedThreads: DebugProtocol.Thread[] = [...this.threads, this.cudaThread];

            response.body = {
                threads: augmentedThreads
            };

            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, 1, error instanceof Error ? error.message : String(error));
        }
    }

    protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
        this.clientThinksStopped = false;
        await super.nextRequest(response, args);
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
        this.clientThinksStopped = false;
        await super.stepInRequest(response, args);
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
        this.clientThinksStopped = false;
        try {
            await sendExecFinish(this.gdb, args.threadId);
            this.sendResponse(response);
        } catch (error) {
            /* In the case where stepping out results in "Error: "finish" not meaningful in the outermost frame."
            we do not throw an error because that might be misleading for users. */
            if (String(error).trim() !== 'Error: "finish" not meaningful in the outermost frame.') {
                this.sendErrorResponse(response, 1, error instanceof Error ? error.message : String(error));
            }
        }
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
        this.clientThinksStopped = false;
        await super.continueRequest(response, args);
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        /*
         * In contexts other than Debug Console (i.e. watch or hover), running arbitrary gdb commands
         * on "evaluate" requests is useless and potentially dangerous since timing of such requests
         * is unpredictable.
         */
        if (args.context === 'repl') {
            const { mi, command } = /^\s*(`|-exec|(?<mi>-mi))\s*(?<command>.*)/.exec(args.expression)?.groups ?? {};
            if (command !== undefined) {
                const result = await this.gdb.sendCommand(command);
                if (mi !== undefined) {
                    this.sendEvent(new OutputEvent(JSON.stringify(result)));
                }
                this.sendResponse(response);

                // This command may have changed CUDA focus; if so, we can find out by using -cuda-focus-query.
                const setFocusResponse = (await this.gdb.sendCommand('-cuda-focus-query block thread')) as MICudaFocusResponse;
                const queriedFocus = setFocusResponse.CudaFocus;
                if (queriedFocus !== undefined) {
                    const blockIdx = queriedFocus.blockIdx;
                    const threadIdx = queriedFocus.threadIdx;
                    if (blockIdx !== undefined && threadIdx !== undefined) {
                        const newFocus: types.CudaFocus = {
                            type: 'software',
                            blockIdx: utils.parseCudaDim(blockIdx),
                            threadIdx: utils.parseCudaDim(threadIdx)
                        };
                        if (utils.isCudaFocusValid(newFocus)) {
                            this.cudaFocus = newFocus;
                        }
                    }
                }

                return;
            }
        }

        await super.evaluateRequest(response, args);
    }

    /* There are some DAP requests such as StackTraceRequest that are only valid when debuggee is
     * stopped. Clients are not supposed to issue them for running threads, but due to inherent
     * asynchrony of DAP, VSCode sometimes does so anyway. GDBDebugSession makes the necessary
     * checks and responds with an error response in that case, but VSCode then displays those
     * error messages to the user, which is undesirable. So, for those requests, we instead return
     * an empty but successful response (which is discarded by VSCode). This decorator handles it
     * in a generic manner.
     */
    protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
        if (this.isRunning) {
            response.body = { scopes: [] };
            this.sendResponse(response);
            return;
        }

        const frame: FrameVariableReference = {
            type: 'frame',
            frameHandle: args.frameId
        };

        const registers: RegisterVariableReference = {
            type: 'registers',
            frameHandle: args.frameId
        };

        const scopes: DebugProtocol.Scope[] = [new Scope('Local', this.variableHandles.create(frame), false), new Scope('Registers', this.variableHandles.create(registers), true)];

        const frameRef = this.frameHandles.get(args.frameId);
        const isCudaDeviceFrame = frameRef?.threadId === CUDA_THREAD.ID && this.cudaFocus !== undefined;
        if (isCudaDeviceFrame) {
            const cudaBuiltinsRef: CudaBuiltinsVariableReference = {
                type: 'object',
                frameHandle: args.frameId,
                varobjName: cudaBuiltins.CUDA_BUILTINS_VAROBJ,
                container: cudaBuiltins.CUDA_BUILTINS_CONTAINER
            };
            scopes.push(new Scope('CUDA Built-ins', this.variableHandles.create(cudaBuiltinsRef), false));
        }

        response.body = { scopes };
        this.sendResponse(response);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        if (this.isRunning || (args.threadId === CUDA_THREAD.ID && this.cudaFocus === undefined)) {
            response.body = { totalFrames: 0, stackFrames: [] };
            this.sendResponse(response);
            return;
        }

        await super.stackTraceRequest(response, args);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        if (this.isRunning) {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }

        const varRef = this.variableHandles.get(args.variablesReference);
        if (cudaBuiltins.isCudaBuiltinsRef(varRef)) {
            await this.cudaBuiltinsRequest(response, args, varRef);
            return;
        }
        if (varRef?.type === 'registers') {
            const frameRef = this.frameHandles.get(varRef.frameHandle);
            if (frameRef?.threadId === CUDA_THREAD.ID) {
                const cudaRegRef = {
                    ...varRef,
                    isCuda: true
                };
                await this.cudaRegistersRequest(response, args, cudaRegRef);
                return;
            }
        }

        // Expand CUDA built-in vector-like containers (threadIdx/blockIdx/blockDim/gridDim)
        if (cudaBuiltins.isCudaDimRef(varRef)) {
            await this.cudaDimRequest(response, args, varRef);
            return;
        }

        // Expand PTX Special Registers subgroup
        if (cudaBuiltins.isCudaPtxSpecialsRef(varRef)) {
            await this.cudaPtxSpecialRegistersRequest(response, args, varRef);
            return;
        }

        await super.variablesRequest(response, args);
    }

    protected async cudaBuiltinsRequest(response: DebugProtocol.VariablesResponse, _args: DebugProtocol.VariablesArguments, reference: CudaBuiltinsVariableReference): Promise<void> {
        const frameRef = this.frameHandles.get(reference.frameHandle);
        const frameId = reference.frameHandle;
        const threadId = frameRef?.threadId ?? CUDA_THREAD.ID;

        const createDimNode = async (name: 'threadIdx' | 'blockIdx' | 'blockDim' | 'gridDim'): Promise<DebugProtocol.Variable> => {
            const childRef: ObjectVariableReference = {
                type: 'object',
                frameHandle: frameId,
                varobjName: cudaBuiltins.CUDA_DIM_PREFIX + name
            };
            const handle = this.variableHandles.create(childRef as any);
            const formattedValue = await cudaBuiltins.evaluateDimFormatted(this.gdb, name, frameId, threadId);
            return new Variable(name, formattedValue, handle);
        };

        const createPtxGroupNode = (): DebugProtocol.Variable => {
            const childRef: ObjectVariableReference = { type: 'object', frameHandle: frameId, varobjName: cudaBuiltins.PTX_REGS_VAROBJ };
            const handle = this.variableHandles.create(childRef as any);
            return new Variable('PTX Special Registers', '', handle);
        };

        const variables: DebugProtocol.Variable[] = [
            await createDimNode('threadIdx'),
            await createDimNode('blockIdx'),
            await createDimNode('blockDim'),
            await createDimNode('gridDim'),
            new Variable('warpSize', await cudaBuiltins.evaluateScalar(this.gdb, 'warpSize', frameId, threadId)),
            createPtxGroupNode()
        ];

        response.body = { variables };
        this.sendResponse(response);
    }

    protected async cudaDimRequest(response: DebugProtocol.VariablesResponse, _args: DebugProtocol.VariablesArguments, reference: ObjectVariableReference): Promise<void> {
        const frameHandle = reference.frameHandle as number;
        const frameRef = this.frameHandles.get(frameHandle);
        const threadId = frameRef?.threadId ?? CUDA_THREAD.ID;
        const dimName = (reference as any).varobjName.slice(cudaBuiltins.CUDA_DIM_PREFIX.length);

        const children = await Promise.all(
            (['x', 'y', 'z'] as const).map(async (component) => {
                const value = await cudaBuiltins.evaluateComponent(this.gdb, dimName, component, frameHandle, threadId);
                return new Variable(component, value);
            })
        );
        response.body = { variables: children };
        this.sendResponse(response);
    }

    protected async cudaPtxSpecialRegistersRequest(response: DebugProtocol.VariablesResponse, _args: DebugProtocol.VariablesArguments, reference: ObjectVariableReference): Promise<void> {
        const frameHandle = reference.frameHandle as number;
        const frameRef = this.frameHandles.get(frameHandle);
        const threadId = frameRef?.threadId ?? CUDA_THREAD.ID;

        let variables: DebugProtocol.Variable[] = [];

        // Try the MI command first
        try {
            const miResp = await this.gdb.sendCommand<MICudaInfoPtxSpecialRegistersResponse>(`-cuda-info-ptx-special-registers`);

            const entries = miResp['ptx-special-registers'];
            if (Array.isArray(entries)) {
                variables = entries
                    .map(({ name, value }) => {
                        const displayName = name.startsWith('$') ? `%${name.slice(1)}` : name;

                        if (value.includes('<error')) {
                            logger.verbose(`PTX special register ${displayName} not available: ${value}`);
                            return undefined;
                        }

                        logger.verbose(`PTX special register ${displayName} value: ${value}`);
                        return new Variable(displayName, value);
                    })
                    .filter((v): v is DebugProtocol.Variable => v !== undefined);
            }
        } catch (error) {
            logger.verbose(`-cuda-info-ptx-special-registers not available, using fallback. Error: ${String(error)}`);
        }

        // Fallback: evaluate each token from the fallback list individually
        if (variables.length === 0) {
            logger.verbose('Using fallback PTX special register evaluation');
            const resolved = await Promise.all(
                cudaBuiltins.ptxSpecialRegisterNamesFallback.map(async (registerName) => {
                    const value = await cudaBuiltins.evaluateToken(this.gdb, registerName, frameHandle, threadId);
                    logger.verbose(`PTX special register ${registerName} value: ${value}`);
                    return value !== undefined ? new Variable(registerName, value) : undefined;
                })
            );
            variables = resolved.filter((v): v is DebugProtocol.Variable => v !== undefined);
        }

        response.body = { variables };
        this.sendResponse(response);
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
        const varRef = this.variableHandles.get(args.variablesReference);
        if (cudaBuiltins.isCudaBuiltinsRef(varRef) || cudaBuiltins.isCudaDimRef(varRef)) {
            this.sendErrorResponse(response, 1, 'CUDA built-in variables are read-only');
            return;
        }
        if (cudaBuiltins.isCudaPtxSpecialsRef(varRef)) {
            this.sendErrorResponse(response, 1, 'PTX special registers are read-only');
            return;
        }

        await super.setVariableRequest(response, args);

        /* In cuda-gdb, assigning to a variable on the GPU thread corrupts the variable object, so we need
         * to force a refresh.
         */
        this.variableHandles.reset();

        /* The edited variable could be an alias of another variable (e.g. a pointer deref); let the client
         * know that it needs to refresh all vars.
         */
        this.sendEvent(new InvalidatedEvent(['variables']));
    }

    protected async cudaRegistersRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, reference: CudaRegisterVariableReference): Promise<void> {
        response.body = { variables: [] };

        if (reference.registerGroup !== undefined) {
            const group = reference.registerGroup;

            const registerValuesMap = new Map<number, string>();

            try {
                const registersToFetch = group.registers.map((r) => r.ordinal.toString());
                const registerValuesResp: any = await this.gdb.sendCommand(`-data-list-register-values x ${registersToFetch.join(' ')}`);

                const registerValues = registerValuesResp['register-values'] as RegisterNameValuePair[];

                for (const pair of registerValues) {
                    registerValuesMap.set(Number.parseInt(pair.number), pair.value);
                }
            } catch {
                // If there is an error in getting the value of a register localize the error so other registers are shown.
                for (let i = 0; i < group.registers.length; i += 1) {
                    const reg = group.registers[i];

                    try {
                        const registerValueResp: any = await this.gdb.sendCommand(`-data-list-register-values x ${reg.ordinal}`);

                        const registerValue = registerValueResp['register-values'] as RegisterNameValuePair[];

                        for (const pair of registerValue) {
                            registerValuesMap.set(Number.parseInt(pair.number), pair.value);
                        }
                    } catch {
                        registerValuesMap.set(reg.ordinal, 'N/A');
                    }
                }
            }

            for (const reg of group.registers) {
                const rawRegisterValue = registerValuesMap.get(reg.ordinal);

                if (rawRegisterValue) {
                    const numericalValue = Number.parseInt(rawRegisterValue);

                    if (Number.isNaN(numericalValue)) {
                        response.body.variables.push(new Variable(reg.name, rawRegisterValue));
                    } else if (group?.isPredicate === true) {
                        response.body.variables.push(new Variable(reg.name, numericalValue.toString()));
                    } else {
                        response.body.variables.push(new Variable(reg.name, formatRegister(numericalValue, group)));
                    }
                }
            }
        } else {
            const registerGroupDefinitions = reference.isCuda ? await deviceRegisterGroups() : undefined;
            // else: We can add definitions here for machine registers and possibly allow reading the
            // register definitions for machine registers from a JSON file specified by the user.

            if (registerGroupDefinitions) {
                if (!reference.registerData) {
                    const parsedRegNamesAll: any = await this.gdb.sendCommand('-data-list-register-names');

                    const parsedRegNames: string[] = parsedRegNamesAll['register-names'];

                    const registerGroups: RegisterGroup[] = registerGroupDefinitions.map((def) => new RegisterGroup(def.groupName, def.groupPattern, def.isPredicate === true, def.isHidden === true));

                    const recordedRegisterNames = new Set<string>();

                    for (const [ordinal, registerName] of parsedRegNames.entries()) {
                        // Ignore registers with an empty name
                        if (registerName.length === 0) {
                            continue;
                        }

                        if (reference.isCuda) {
                            if (recordedRegisterNames.has(registerName)) {
                                // If cuda-gdb returns repeated register names, that is a bug.
                                continue;
                            }

                            recordedRegisterNames.add(registerName);
                        }

                        const matchingGroup = registerGroups.find((group) => registerName.match(group.groupPattern));
                        if (matchingGroup) {
                            const register = new Register(ordinal, registerName, matchingGroup);
                            matchingGroup.registers.push(register);
                        }
                    }

                    reference.registerData = new RegisterData(registerGroups);
                }

                for (const group of reference.registerData.registerGroups) {
                    if (group.registers.length > 0 && !group.isHidden) {
                        const groupRef: CudaRegisterVariableReference = {
                            type: 'registers',
                            isCuda: reference.isCuda,
                            frameHandle: reference.frameHandle,
                            registerData: reference.registerData,
                            registerGroup: group
                        };

                        const handle = this.variableHandles.create(groupRef);

                        response.body.variables.push(new Variable(group.groupName, '', handle, 0, group.registers.length));
                    }
                }
            } else {
                // If there no register definitions, just display the registers in a default flat format.
                const parsedRegNamesResp: any = await this.gdb.sendCommand('-data-list-register-names');
                const parsedRegNames: string[] = parsedRegNamesResp['register-names'];

                const registerValuesResp: any = await this.gdb.sendCommand('-data-list-register-values x');
                const registerValues = registerValuesResp['register-values'] as RegisterNameValuePair[];

                for (const pair of registerValues) {
                    const regNum = Number.parseInt(pair.number);
                    const regName = parsedRegNames[regNum];
                    response.body.variables.push(new Variable(regName, pair.value));
                }
            }
        }

        this.sendResponse(response);
    }

    // disassemble-request implementation
    //
    // The response returned by disassembleRequest must (_exactly_) meet the requested the args.instructionOffset and
    // args.instructionCount. As such, we disassemble backward and forward until the count of both the preceding and
    // following instructions are met. If these instructions do not exist, the instructions array is prepended/appended
    // with instances of a "dummy" instruction to meet these counts.
    //
    // To easier understand the the code, ponder the following 3 scenarios (These scenarios are merely examples. They
    // are based on the requests VS code sends at the time of this writing, but the code makes no assumption limiting
    // incoming requests to these scenarios (and nor should the reader)):
    //
    // - Initial request: args.instructionOffset is -200, args.instructionCount is 400, which means get the current
    //   instruction, 200 instructions before it and 199 instructions after.
    //
    // - Scroll down: args.instructionOffset is 1, instructionCount is 50, which means give me 50 instructions after
    //   args.memoryReference (the address of the last instruction in the array backing the graphical view) excluding
    //   the instruction at args.memoryReference (because args.instructionOffset is 1).
    //
    // - Scroll up: args.instructionOffset is -50, args.instructionCount is 50, which means give me 50 instructions
    //   before args.memoryReference (the address of the first instruction in the array backing the graphical view).

    protected async getSassInstructionSize(): Promise<number | undefined> {
        // We intentionally do not cache this as we could switch GPUs in between stop events.

        const gpuInfo = await getDevicesInfo(this.gdb);
        const currentDevice = gpuInfo.find((d) => d?.current?.includes('*'));
        if (!currentDevice?.smType?.startsWith('sm_')) {
            return;
        }

        const majorArch = Number.parseInt(currentDevice.smType.slice('sm_'.length, -1));
        return majorArch >= 7 ? 16 : 8;
    }

    static readonly invalidAddress = '??';

    static readonly dummyInstruction: DebugProtocol.DisassembledInstruction = {
        address: this.invalidAddress,
        instruction: '??'
    } as DebugProtocol.DisassembledInstruction;

    protected getInstructionSizeEstimate(): Promise<number | undefined> {
        if (this.hasValidFocus()) {
            return this.getSassInstructionSize();
        }

        // TODO: We need to set the correct estimate for other architectures (esp. AArch64) here.
        const instructionSizeEstimate = 4;
        return Promise.resolve(instructionSizeEstimate);
    }

    // Disassemble-backward relies on "-data-disassemble -a". It iteratively goes back until it finds an address belonging to
    // a known function (i.e. a function with debug information). Once we have this address, we use "-data-disassemble -a" to
    // disassemble the function.
    //
    // - The number of bytes disassemble-backward walks back every iteration is called the "step size" and is determined by
    //   <#instructions to rewind> * <bytes per instruction>. This is calculated by getBackwardDisassembleStepSize() below.
    //
    // - The number of iterations is determined by numberOfBackwardDisassembleSteps below.

    protected async getBackwardDisassembleStepSize(): Promise<number | undefined> {
        if (this.hasValidFocus()) {
            const instructionsToRewind = 16;
            const sassInstructionSize = await this.getSassInstructionSize();
            return sassInstructionSize ? sassInstructionSize * instructionsToRewind : undefined;
        }

        // TODO: We need to adjust instructionsToRewind for other architectures (than x86_64) here.
        const instructionsToRewind = 16;
        const instructionSizeEstimate = await this.getInstructionSizeEstimate();
        return instructionSizeEstimate ? instructionsToRewind * instructionSizeEstimate : undefined;
    }

    static readonly numberOfBackwardDisassembleSteps = 16;

    protected async disassembleBackward(instructions: DebugProtocol.DisassembledInstruction[], address: string, backwardDisassembleStepSize: number): Promise<void> {
        let result: MIDataDisassembleResponse | undefined;
        for (let i = 1; i <= CudaGdbSession.numberOfBackwardDisassembleSteps; i += 1) {
            const addressToTry = `(${address})-${i * backwardDisassembleStepSize}`;
            try {
                result = await sendDataDisassemble(this.gdb, addressToTry);
                logger.verbose(`[Disassemble backward] Succeeded with address ${addressToTry}`);
                break;
            } catch (error) {
                const errorString = error instanceof Error ? error.message : String(error);
                logger.verbose(`[Disassemble backward] Failed at address: ${addressToTry}, Error: ${errorString}`);
            }
        }

        if (result) {
            this.flattenDisassembledInstructions(result.asm_insns, instructions, 0);

            const lastInstructionFetched = instructions.at(-1)?.address;

            if (lastInstructionFetched !== undefined) {
                try {
                    logger.verbose(`[Disassemble backward] Attempting to retrieve instructions in the interim range [${lastInstructionFetched}, ${address}).`);
                    result = await sendDataDisassemble(this.gdb, { startAddress: lastInstructionFetched, endAddress: address });
                } catch (error) {
                    const errorString = error instanceof Error ? error.message : String(error);
                    logger.verbose(`[Disassemble backward] Failed to fetch the disassembly between ${lastInstructionFetched} and ${address}, Error: ${errorString}`);
                    result = undefined;
                }

                if (result) {
                    this.flattenDisassembledInstructions(result.asm_insns, instructions, 1);
                }
            }
        } else {
            logger.verbose('[Disassemble backward] Failed.');
        }
    }

    protected async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: CDTDisassembleArguments): Promise<void> {
        logger.verbose(`[Disassemble request] Parameters: ${JSON.stringify(args)}`);

        if (this.hasValidFocus()) {
            args.excludeRawOpcodes = true;
        }

        if (args.offset) {
            this.sendErrorResponse(response, 1, 'Unsupported argument "Offset"');
            return;
        }

        if (args.memoryReference === CudaGdbSession.invalidAddress) {
            logger.verbose(`[Disassemble request] Invalid initial address. Returning ${args.instructionCount} dummy instructions.`);
            response.body = { instructions: Array.from({ length: args.instructionCount }, () => CudaGdbSession.dummyInstruction) };
            this.sendResponse(response);
            return;
        }

        let currentInstruction: DebugProtocol.DisassembledInstruction;

        try {
            const startAddress = `(${args.memoryReference})+${args.offset ?? 0}`;
            const endAddress = `(${args.memoryReference})+${(args.offset ?? 0) + 1}`;

            const result = await sendDataDisassemble(this.gdb, { startAddress, endAddress });

            const instructions: DebugProtocol.DisassembledInstruction[] = [];
            this.flattenDisassembledInstructions(result.asm_insns, instructions, 0);

            const [first] = instructions;
            if (!first) {
                logger.error('[Disassemble request] Disassembly at the initial address returned no instructions');
                this.sendErrorResponse(response, 1, 'No instructions returned for the given address');
                return;
            }
            currentInstruction = first;
        } catch (error) {
            const errorString = error instanceof Error ? error.message : String(error);

            logger.error(`[Disassemble request] Disassembly at the initial address failed: ${errorString}`);

            this.sendErrorResponse(response, 1, errorString);
            return;
        }

        let instructions: DebugProtocol.DisassembledInstruction[] = [];

        try {
            const result = await sendDataDisassemble(this.gdb, currentInstruction.address);
            this.flattenDisassembledInstructions(result.asm_insns, instructions, 0);

            logger.verbose(`[Disassemble request] "-data-disassemble -a ${currentInstruction.address}" succeeded.`);
        } catch {
            logger.error(`[Disassemble request] "-data-disassemble -a ${currentInstruction.address}" failed. Falling back to disassembling from current instruction.`);
            instructions = [currentInstruction];
        }

        const indexOfCurrentInsn = instructions.findIndex((i) => i.address === currentInstruction.address);

        if (indexOfCurrentInsn < 0) {
            logger.error(`[Disassemble request] Unable to locate the initial memory reference in the disassembled instructions.`);

            this.sendErrorResponse(response, 1, 'Reference address not found.');
            return;
        }

        const instructionOffset = args.instructionOffset ?? 0;
        const indexOfSplice = indexOfCurrentInsn + instructionOffset;

        let lastAddressRead = instructions.at(-1)?.address;
        if (lastAddressRead === undefined) {
            return;
        }

        let instructionsToSkip = 0;

        if (indexOfSplice < 0) {
            let instructionDeficit = -indexOfSplice;

            logger.verbose(`[Disassemble request] Need ${instructionDeficit} instructions at the beginning.`);

            const backwardDisassembleStepSize = await this.getBackwardDisassembleStepSize();

            if (!backwardDisassembleStepSize) {
                logger.error(`[Disassemble request] Backward disassemble step size: ${backwardDisassembleStepSize}`);

                this.sendErrorResponse(response, 1, 'Unable to determine the machine instruction size.');
                return;
            }

            logger.verbose(`[Disassemble request] Backward disassemble step size: ${backwardDisassembleStepSize}`);

            while (instructionDeficit > 0) {
                logger.verbose(`[Disassemble request] Attempting to disassemble backward. Instruction deficit: ${instructionDeficit}`);

                const priorInstructions: DebugProtocol.DisassembledInstruction[] = [];
                await this.disassembleBackward(priorInstructions, instructions[0].address, backwardDisassembleStepSize);
                if (priorInstructions.length === 0) {
                    logger.verbose(`[Disassemble request] Disassemble backward failed. Prepending ${instructionDeficit} dummy instruction(s) to the instructions array.`);
                    instructions = [...Array.from({ length: instructionDeficit }, () => CudaGdbSession.dummyInstruction), ...instructions];
                    break;
                }
                if (priorInstructions.length <= instructionDeficit) {
                    instructions = [...priorInstructions, ...instructions];
                    instructionDeficit -= priorInstructions.length;

                    logger.verbose(`[Disassemble request] Disassemble backward returned ${priorInstructions.length} instruction(s). New instruction deficit: ${instructionDeficit}.`);
                } else {
                    logger.verbose(`[Disassemble request] Disassemble backward returned ${priorInstructions.length} > ${instructionDeficit} instruction(s).`);

                    instructions = [...priorInstructions.slice(-instructionDeficit), ...instructions];
                    break;
                }
            }

            logger.verbose('[Disassemble request] Finished disassembling backward.');
        } else {
            logger.verbose(`[Disassemble request] Dropping ${indexOfSplice} instructions from the beginning. Requested instruction offset: ${instructionOffset}, Actual instruction offset: ${indexOfCurrentInsn}`);

            if (indexOfSplice < instructions.length) {
                instructions.splice(0, indexOfSplice);
            } else {
                instructionsToSkip = indexOfSplice - instructions.length;
                instructions = [];
            }
        }

        if (instructions.length > args.instructionCount) {
            logger.verbose(`[Disassemble request] Dropping ${instructions.length - args.instructionCount} instructions from the end. Requested #instructions: ${args.instructionCount}`);

            instructions.splice(args.instructionCount);
        } else if (instructions.length < args.instructionCount) {
            logger.verbose(`[Disassemble request] Need more instructions to meet the requested instruction count (${args.instructionCount}).`);

            const machineInstructionSize = await this.getInstructionSizeEstimate();
            if (!machineInstructionSize) {
                logger.verbose(`[Disassemble request] Unable to determine the machine instruction size.`);

                this.sendErrorResponse(response, 1, 'Unable to determine the machine instruction size.');
                return;
            }

            while (lastAddressRead !== undefined) {
                let result2: MIDataDisassembleResponse | undefined;

                // Never take too few instructions
                const instructionsToFetch = Math.max(args.instructionCount - instructions.length, 8);
                const fetchSize = machineInstructionSize * instructionsToFetch;

                const startAddress = lastAddressRead;
                const endAddress = `(${startAddress})+${fetchSize}`;

                logger.verbose(`[Disassemble request] Disassemble forward. Instruction deficit: ${args.instructionCount - instructions.length}, Start address: ${startAddress}, End address: ${endAddress}`);

                try {
                    result2 = await sendDataDisassemble(this.gdb, { startAddress, endAddress });
                } catch (error) {
                    const errorString = error instanceof Error ? error.message : String(error);
                    logger.error(`[Disassemble request] Disassemble forward: Error while trying to retrieve instructions following address ${startAddress}. Fetch size: ${fetchSize}, Error: ${errorString}`);

                    logger.verbose(`[Disassemble request] Disassemble forward: Appending the instructions array with ${args.instructionCount - instructions.length} dummy instruction(s).`);
                    instructions = [...instructions, ...Array.from({ length: args.instructionCount - instructions.length }, () => CudaGdbSession.dummyInstruction)];
                    break;
                }

                const skippedInstructions: DebugProtocol.DisassembledInstruction[] = [];
                const { instructionsSkipped, instructionsWritten } = this.flattenDisassembledInstructions(result2.asm_insns, instructions, instructionsToSkip + 1, args.instructionCount - instructions.length, skippedInstructions);
                instructionsToSkip -= instructionsSkipped - 1;

                if (!instructionsWritten && !instructionsSkipped) {
                    logger.error(`[Disassemble request] Disassemble forward: No instructions returned while trying to retrieve instructions following address ${startAddress}. Fetch size: ${fetchSize}`);
                    logger.verbose(`[Disassemble request] Disassemble forward: Appending the instructions array with ${args.instructionCount - instructions.length} dummy instruction(s).`);
                    instructions = [...instructions, ...Array.from({ length: args.instructionCount - instructions.length }, () => CudaGdbSession.dummyInstruction)];
                    break;
                }

                if (instructions.length >= args.instructionCount) {
                    logger.verbose(`[Disassemble request] Disassemble forward: Instruction count is now at ${instructions.length}. Stopping and splicing at ${args.instructionCount}`);
                    instructions.splice(args.instructionCount);
                    break;
                } else {
                    lastAddressRead = instructions.at(-1)?.address ?? skippedInstructions.at(-1)?.address;
                }
            }

            logger.verbose('[Disassemble request] Disassemble forward completed.');
        }

        const performDisassembleSanityChecks = this.testMode;

        if (performDisassembleSanityChecks) {
            const assert = (cond: boolean, msg?: string): void => {
                if (!cond) {
                    throw new Error(msg ? `Assertion failed: ${msg}` : 'Assertion failed.');
                }
            };

            const instructionLength = (inst: DebugProtocol.DisassembledInstruction): number => (inst.instructionBytes?.replace(/\s/g, '') ?? '').length / 2;

            const follows = (inst1: DebugProtocol.DisassembledInstruction, inst2: DebugProtocol.DisassembledInstruction): boolean => {
                // Javascript's "number" is double-precision floating point so it can't handle 64-bit address arithmetic with precision.
                // However, it does support 32-bit bitwise arithmetic, which we use below.
                const hexDigitsIn32Bits = 8;
                let addr1 = Number.parseInt(inst1.address.slice(-hexDigitsIn32Bits), 16);
                const addr2 = Number.parseInt(inst2.address.slice(-hexDigitsIn32Bits), 16);
                assert(!Number.isNaN(addr1), `Invalid address: ${inst1.address}`);
                assert(!Number.isNaN(addr2), `Invalid address: ${inst2.address}`);

                addr1 += instructionLength(inst1);

                // Truncate addr1 to 32 bits and compare.
                return addr1 >>> 0 === addr2;
            };

            if (args.instructionOffset === 1) {
                const firstInstruction = instructions.at(0);
                if (firstInstruction !== undefined && firstInstruction.address !== CudaGdbSession.invalidAddress) {
                    assert(follows(currentInstruction, firstInstruction), 'Scroll down condition not met.');
                }
            }

            if (args.instructionOffset && args.instructionOffset < 0 && args.instructionCount === -args.instructionOffset) {
                const lastInstruction = instructions.at(-1);
                if (lastInstruction !== undefined && lastInstruction.address !== CudaGdbSession.invalidAddress) {
                    assert(follows(lastInstruction, currentInstruction), 'Scroll up condition not met.');
                }
            }

            for (let i = 0; i < instructions.length - 1; i += 1) {
                if (instructions[i].address !== CudaGdbSession.invalidAddress && instructions[i + 1].address !== CudaGdbSession.invalidAddress) {
                    assert(follows(instructions[i], instructions[i + 1]), `${instructions[i].address}+${instructionLength(instructions[i])} != ${instructions[i + 1].address}`);
                }
            }
        }

        if (args.excludeRawOpcodes) {
            for (const instr of instructions) {
                instr.instructionBytes = undefined;
            }
        }

        response.body = { instructions };
        this.sendResponse(response);

        logger.verbose(`[Disassemble request] Response sent with ${instructions.length} instruction(s).`);
    }

    private async changeCudaFocusRequest(response: CudaDebugProtocol.ChangeCudaFocusResponse, args: CudaDebugProtocol.ChangeCudaFocusArguments): Promise<void> {
        const typedArgs = args as CudaDebugProtocol.ChangeCudaFocusArguments;
        let newFocus = typedArgs.focus as types.CudaFocus;

        if (newFocus.type === 'software') {
            const currentFocus = this.cudaFocus?.type === 'software' ? this.cudaFocus : undefined;
            const coalesceDim = (newDim?: types.CudaDim, currentDim?: types.CudaDim): types.CudaDim => ({
                x: newDim?.x ?? currentDim?.x,
                y: newDim?.y ?? currentDim?.y,
                z: newDim?.z ?? currentDim?.z
            });
            newFocus = {
                type: 'software',
                blockIdx: coalesceDim(newFocus.blockIdx, currentFocus?.blockIdx),
                threadIdx: coalesceDim(newFocus.threadIdx, currentFocus?.threadIdx)
            };
        } else if (newFocus.type === 'hardware') {
            const currentFocus = this.cudaFocus?.type === 'hardware' ? this.cudaFocus : undefined;
            newFocus = {
                type: 'hardware',
                sm: newFocus.sm ?? currentFocus?.sm ?? 0,
                warp: newFocus.warp ?? currentFocus?.warp ?? 0,
                lane: newFocus.lane ?? currentFocus?.lane ?? 0
            };
        }

        if (!utils.isCudaFocusValid(newFocus)) {
            this.sendErrorResponse(response, 1, 'Mixing hardware and software coordinates to change focus is not supported.');
            return;
        }

        /* We don't actually need to change gdb focus here because it will be done by CudaGdbBackend automatically
         * for gdb commands that need it right before they are sent. However, executing this command allows us to
         * validate the new focus.
         */
        const setFocusCommand = utils.formatSetFocusCommand(newFocus);
        try {
            await this.gdb.sendCommand(setFocusCommand);
        } catch (error) {
            this.sendErrorResponse(response, 1, (error as Error).message);
            return;
        }

        this.cudaFocus = newFocus;
        response.body = { focus: newFocus };
        this.sendResponse(response);
        this.sendEvent(new InvalidatedEvent(['stacks', 'variables'], this.cudaThread.id));
    }

    protected async configureSetupCommands(args: CudaAttachRequestArguments | CudaLaunchRequestArguments, cdtArgs: AttachRequestArguments | LaunchRequestArguments): Promise<void> {
        if (args.setupCommands) {
            // Ensure initCommands exists and is an array
            cdtArgs.initCommands = cdtArgs.initCommands ?? [];
            for (const setupCommand of args.setupCommands) {
                // Push the raw command text as an object with the ignoreFailures flag.
                // The underlying GDBBackend.sendCommand should handle console vs MI commands.
                cdtArgs.initCommands.push({
                    text: setupCommand.text, // Use the raw text directly
                    ignoreFailures: setupCommand.ignoreFailures
                });
            }
        }
    }

    protected initializeLogger(args: CudaLaunchRequestArguments): void {
        let logFilePath = args.logFile;
        if (logFilePath && !path.isAbsolute(logFilePath)) {
            logFilePath = path.resolve(logFilePath);
        }

        // Logger setup is handled in the base class
        logger.init((outputEvent: OutputEvent) => this.sendEvent(outputEvent), logFilePath, true);
        logger.verbose('Logger successfully initialized');
    }

    protected async runConfigureLaunch(
        response: DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse,
        args: CudaLaunchRequestArguments | CudaAttachRequestArguments,
        cdtArgs: LaunchRequestArguments | AttachRequestArguments,
        requestType: RequestType
    ): Promise<boolean> {
        try {
            await this.configureLaunch(args, cdtArgs, requestType);
            return true;
        } catch (error) {
            response.success = false;
            response.message = (error as Error).message;
            logger.verbose(`Failed in configureLaunch() with error "${response.message}"`);
            this.sendErrorResponse(response, 1, response.message);
            // Although we sent an error response, we return false to signal failure to the caller.
            return false;
        }
    }

    protected async validateAndSetCudaGdbPath(response: DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse, cdtArgs: LaunchRequestArguments | AttachRequestArguments, isQNX: boolean): Promise<boolean> {
        const cudaGdbPath = await checkCudaGdb(cdtArgs.gdb, isQNX);

        if (cudaGdbPath.kind === 'doesNotExist') {
            response.success = false;
            response.message = `Unable to find cuda-gdb. ${cdtArgs.gdb ? 'The specified path is incorrect.' : 'The path to cuda-gdb is not defined. Ensure you have cuda-gdb installed and the path is correct.'}`;
            logger.verbose(`Failed with error ${response.message}`);
            this.sendErrorResponse(response, 1, response.message);

            return false;
        }

        logger.verbose('cuda-gdb found and accessible');
        setCudaGdbPath(cdtArgs, cudaGdbPath.path);

        return true;
    }

    protected async validateLinuxPlatform(response: DebugProtocol.LaunchResponse | DebugProtocol.AttachResponse): Promise<boolean> {
        if (process.platform !== 'linux') {
            response.success = false;
            response.message = 'Unable to launch cuda-gdb on non-Linux system';
            this.sendErrorResponse(response, 1, response.message);

            return false;
        }
        logger.verbose('Confirmed that we are on a Linux system');
        return true;
    }
}

// This function is simple for the time being and merely
// serves as a note that we can read the format (esp.
// decimal or hex) from the user preferences at some
// point down the road.
function formatRegister(value: number, registerGroup: RegisterGroup): string {
    return toFixedHex(value, 8);
}

function toFixedHex(value: number, width: number): string {
    const hexStr: string = value.toString(16);

    if (hexStr === 'NaN') {
        return hexStr;
    }

    const paddingSize = Math.max(0, width - hexStr.length);

    return `0x${'0'.repeat(paddingSize)}${hexStr}`;
}

export async function checkCudaGdb(pathName: string | undefined, isQNX = false): Promise<CudaGdbExists> {
    const binaryName = isQNX ? 'cuda-qnx-gdb' : 'cuda-gdb';

    if (pathName === undefined) {
        const res = which(binaryName)
            .then((cudaGdbPath: string) => {
                return { kind: 'exists', path: cudaGdbPath } as CudaGdbPathResult;
            })
            .catch((error: Error) => {
                // checks if cuda-gdb exists in the default location
                const defaultLocation = isQNX ? '/usr/local/cuda/bin/cuda-qnx-gdb' : '/usr/local/cuda/bin/cuda-gdb';

                if (fs.existsSync(defaultLocation)) {
                    return { kind: 'exists', path: defaultLocation } as CudaGdbPathResult;
                }
                logger.error(`Unable to find cuda-gdb, ${error}`);
                return { kind: 'doesNotExist' } as NoCudaGdbResult;
            });
        return res;
    }

    // the path.endsWith check is for the scenario that the user enters a valid path but one that does not contain cuda-gdb
    // checks that path is valid and path contains cuda-gdb
    const isCudaGdbPathValid = fs.existsSync(pathName) && pathName.endsWith(binaryName);
    if (isCudaGdbPathValid) {
        return { kind: 'exists', path: pathName } as CudaGdbPathResult;
    }

    return { kind: 'doesNotExist' } as NoCudaGdbResult;
}

export function setEnvVars(envVars: Environment[]): void {
    for (const envVarVal of envVars) {
        process.env[envVarVal.name] = envVarVal.value;
    }
}

export function getLaunchEnvVars(pathToEnvFile: string): LaunchEnvVarSpec[] {
    if (!path.isAbsolute(pathToEnvFile)) {
        pathToEnvFile = path.resolve(pathToEnvFile);
    }

    let envFileContents = '';
    try {
        envFileContents = fs.readFileSync(pathToEnvFile, { encoding: 'utf8', flag: 'r' });
    } catch (error) {
        throw new Error(`Unable to read launch environment variables file:\n${(error as Error).message}`);
    }

    const unsetString = 'unset';

    const envVarSpecs: LaunchEnvVarSpec[] = [];
    const envFileLines = envFileContents.split(/\r?\n/);
    for (let line of envFileLines) {
        line = line.trim();
        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }

        const eqIdx = line.indexOf('=');
        if (eqIdx >= 0) {
            const name = line.slice(0, eqIdx).trim();
            if (name.length > 0) {
                const value = line.slice(eqIdx + 1).trim();
                envVarSpecs.push({ type: 'set', name, value });
                continue;
            }
        } else if (line.startsWith(unsetString) && line.length > unsetString.length && line.slice(unsetString.length, unsetString.length + 1).trim().length === 0) {
            const name = line.slice(unsetString.length + 1).trim();
            if (name.length > 0) {
                envVarSpecs.push({ type: 'unset', name });
                continue;
            }
        }

        logger.warn(`Invalid environment variable specification: ${line}`);
    }

    return envVarSpecs;
}

export function parseArgs(args: string | string[]): string {
    const parsedArgs = typeof args === 'string' ? args : `"${args.join('" "')}"`;

    return parsedArgs;
}

function hasDebuggeeArguments(args?: string | string[]): args is string | string[] {
    return Array.isArray(args) ? args.length > 0 : !!args;
}

async function getDevicesInfo(gdb: GDBBackend): Promise<types.GpuInfo[]> {
    const devicesResponse = await gdb.sendCommand<MICudaInfoDevicesResponse>('-cuda-info-devices');
    const gpuInfo: types.GpuInfo[] = devicesResponse.InfoCudaDevicesTable?.body?.map((value) => {
        return {
            current: value?.current,
            name: value?.name,
            description: value?.description,
            smType: value?.sm_type
        };
    });

    return gpuInfo;
}

async function getSystemInfo(gdb: GDBBackend): Promise<types.SystemInfo> {
    const osInfo: types.OsInfo = await utils.readOsInfo();
    const gpuInfo = await getDevicesInfo(gdb);

    const systemInfo: types.SystemInfo = {
        os: osInfo,
        gpus: gpuInfo
    };

    return systemInfo;
}

function configureEnvfile(args: CudaAttachRequestArguments | CudaLaunchRequestArguments, cdtArgs: AttachRequestArguments | LaunchRequestArguments): void {
    if ('envFile' in args && args.envFile) {
        const envVarSpecs = getLaunchEnvVars(args.envFile);
        cdtArgs.initCommands?.unshift(...envVarSpecs.map((spec) => (spec.type === 'set' ? `set env ${spec.name}=${spec.value!}` : `unset env ${spec.name}`)));
    }
}

function setCudaGdbPath(cdtLaunchArgs: LaunchRequestArguments, path: string): void {
    cdtLaunchArgs.gdb = path;
}
