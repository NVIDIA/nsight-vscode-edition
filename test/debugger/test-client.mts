import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { type Readable, type Writable, Transform, Duplex, duplexPair } from 'node:stream';
import { CudaGdbSession as DapServer } from '../../src/debugger/cudaGdbSession.ts';
import { ProtocolClient } from '@vscode/debugadapter-testsupport/lib/protocolClient.js';
import { type DebugProtocol } from '@vscode/debugprotocol';
import JSON5 from 'json5';
import { EventEmitter } from 'node:events';
import waitForExpect from 'wait-for-expect';

interface DebugConfig {
    name: string;
    type: string;
    request: 'launch' | 'attach';
}

interface CudaGdbCommonDebugConfig extends DebugConfig {
    type: 'cuda-gdb';
    debuggerPath?: string;
    miDebuggerPath?: string;
    miDebuggerArgs?: string | string[];
    verboseLogging?: boolean;
    logFile?: string;
    breakOnLaunch?: boolean;
    onAPIError?: 'stop' | 'hide' | 'ignore';
    sysroot?: string;
    additionalSOLibSearchPath?: string;
    testMode?: boolean;
    envFile?: string;
    environment?: {
        name: string;
        value: string;
    }[];
    setupCommands?: {
        text: string;
        description: string;
        ignoreFailures: boolean;
    }[];
}

interface CudaGdbLaunchDebugConfig extends CudaGdbCommonDebugConfig {
    request: 'launch';
    program: string;
    args?: string | string[];
    stopAtEntry?: boolean;
}

interface CudaGdbAttachDebugConfig extends CudaGdbCommonDebugConfig {
    request: 'attach';
    processId: string;
    port: number;
    address: string;
}

type CudaGdbDebugConfig = CudaGdbLaunchDebugConfig | CudaGdbAttachDebugConfig;

interface FunctionBreakpointOptions {
    name: string;
    isEnabled?: boolean;
    condition?: string;
    hitCondition?: string;
}

interface LineBreakpointOptions {
    line: number | string;
    isEnabled?: boolean;
    condition?: string;
    hitCondition?: string;
}

export function usingWorkspace(folderPath: string, callback: (workspace: Workspace) => Promise<void>): Promise<void>;
export function usingWorkspace(callback: (workspace: Workspace) => Promise<void>): Promise<void>;

export async function usingWorkspace(...args: [callback: (workspace: Workspace) => Promise<void>] | [folderPath: string, callback: (workspace: Workspace) => Promise<void>]): Promise<void> {
    const [folderPath, callback] = args.length === 2 ? args : ['projects', args[0]];
    const workspace = new Workspace(folderPath);
    try {
        await callback(workspace);
    } finally {
        await workspace.dispose();
    }
}

interface WorkspaceEvents {
    disposed: [];
    debugSessionCreated: [DebugSession];
    debugSessionDisposed: [DebugSession];
    break: [Breakpoint[]];
}

/**
 * A simulated VSCode workspace corresponding to a single directory on disk.
 */
export class Workspace extends EventEmitter<WorkspaceEvents> implements AsyncDisposable {
    readonly path: string;

    #breakpoints: Breakpoint[] = [];

    #debugSessions: DebugSession[] = [];

    constructor(folderPath: string) {
        super({ captureRejections: true });
        const workspacesRoot = path.resolve(import.meta.dirname, '..');
        this.path = path.resolve(workspacesRoot, folderPath);

        this.on('debugSessionCreated', (session: DebugSession) => {
            this.#debugSessions.push(session);
        });

        this.on('debugSessionDisposed', (session: DebugSession) => {
            this.#debugSessions = this.#debugSessions.filter((s) => s !== session);
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }

    async dispose(): Promise<void> {
        for (const session of this.debugSessions) {
            await session.dispose();
        }
        await waitForExpect(() => {
            expect(this.#debugSessions).toBeEmpty();
        });
    }

    get breakpoints(): Breakpoint[] {
        return [...this.#breakpoints];
    }

    get debugSessions(): DebugSession[] {
        return [...this.#debugSessions];
    }

    get debugSession(): DebugSession {
        expect(this.#debugSessions).toHaveLength(1);
        return this.#debugSessions[0];
    }

    /**
     * Returns a file in the workspace.
     * @param path The path to the file relative to the workspace root.
     */
    file(filePath: string): WorkspaceFile {
        return new WorkspaceFile(this, path.resolve(this.path, filePath));
    }

    /**
     * Given a JSON object, substitutes ${...} variable references inside strings with their actual values recursively
     * throughout the object graph, including all nested objects and arrays.
     */
    substituteVariables<T>(value: T): T {
        const variables = {
            workspaceFolder: () => this.path
        };
        if (typeof value === 'string') {
            return value.replaceAll(/\$\{(.*?)\}/g, (_, name) => {
                expect(Object.keys(variables)).toContain(name);
                return variables[name as keyof typeof variables]();
            }) as T;
        }
        if (Array.isArray(value)) {
            return value.map((v) => this.substituteVariables(v)) as T;
        }
        if (typeof value === 'object' && value !== null) {
            return Object.fromEntries(
                Object.entries(value).map(([key, val]) => {
                    return [key, this.substituteVariables(val)];
                })
            ) as T;
        }
        return value;
    }

    /**
     * Loads a named debug configuration from .vscode/launch.json.
     */
    async getDebugConfig(name: string): Promise<CudaGdbDebugConfig> {
        const file = this.file('.vscode/launch.json');
        const text = await file.readAllText();
        const json = JSON5.parse(text);
        const configs = json.configurations as DebugConfig[];
        const config = configs.find((c: any) => c.name === name);
        expect(config).toBeDefined();
        expect(config).toEqual(
            expect.objectContaining({
                name: expect.any(String),
                type: 'cuda-gdb',
                request: expect.stringMatching(/^(launch|attach)$/)
            })
        );
        const resolved = this.substituteVariables(config) as CudaGdbDebugConfig;
        // When running in VRL, the test binaries embed their DVS build-time paths
        // in DWARF debug info. Without remapping, cuda-gdb can't match the package's
        // unpacked source paths to those embedded paths, and source-line breakpoints
        // never resolve. RUBICON_BUILD_ROOT is set by run-tests.sh from the
        // .build-root file written at DVS build time.
        const buildRoot = process.env.RUBICON_BUILD_ROOT;
        if (buildRoot) {
            const runtimeRoot = process.cwd();
            const subst = {
                text: `set substitute-path ${buildRoot} ${runtimeRoot}`,
                description: 'Map DVS build paths to VRL runtime paths for source breakpoints',
                ignoreFailures: false
            };
            resolved.setupCommands = [subst, ...(resolved.setupCommands ?? [])];
        }
        return resolved;
    }

    async createDebugSession(config: string | CudaGdbDebugConfig, overrides?: Partial<CudaGdbDebugConfig>): Promise<DebugSession> {
        const resolvedConfig: CudaGdbDebugConfig = typeof config === 'string' ? await this.getDebugConfig(config) : config;

        if (overrides) {
            return new DebugSession(this, { ...resolvedConfig, ...overrides } as CudaGdbDebugConfig);
        }

        return new DebugSession(this, resolvedConfig);
    }

    async startDebugging(config: string | CudaGdbDebugConfig, overrides?: Partial<CudaGdbDebugConfig>): Promise<DebugSession> {
        const session = await this.createDebugSession(config, overrides);
        await session.startDebugging();
        await session.configurationDone();
        return session;
    }

    async createBreakpoint(filePath: string, line: number, isEnabled = true, condition?: string, hitCondition?: string): Promise<LineBreakpoint> {
        const bp = new LineBreakpoint(this, path.resolve(this.path, filePath), line, isEnabled, condition, hitCondition);
        this.#breakpoints.push(bp);
        await this.reapplyBreakpoints(filePath);
        return bp;
    }

    async createFunctionBreakpoint(options: FunctionBreakpointOptions): Promise<FunctionBreakpoint> {
        const { name, isEnabled = true, condition, hitCondition } = options;
        const bp = new FunctionBreakpoint(this, name, isEnabled, condition, hitCondition);
        this.#breakpoints.push(bp);
        await this.reapplyFunctionBreakpoints();
        return bp;
    }

    async reapplyBreakpoints(filePath?: string): Promise<void> {
        for (const session of this.debugSessions) {
            await session.reapplyBreakpoints(filePath);
        }
    }

    async reapplyFunctionBreakpoints(): Promise<void> {
        for (const session of this.debugSessions) {
            await session.reapplyFunctionBreakpoints();
        }
    }

    async removeBreakpoint(breakpoint: Breakpoint): Promise<void> {
        const index = this.#breakpoints.indexOf(breakpoint);
        expect(index).toBeGreaterThanOrEqual(0);
        this.#breakpoints.splice(index, 1);

        if (breakpoint instanceof LineBreakpoint) {
            await this.reapplyBreakpoints(breakpoint.path);
        } else if (breakpoint instanceof FunctionBreakpoint) {
            await this.reapplyFunctionBreakpoints();
        }
    }
}

class WorkspaceFile {
    readonly workspace: Workspace;
    readonly path: string;

    constructor(workspace: Workspace, filePath: string) {
        this.workspace = workspace;
        this.path = path.resolve(filePath);
    }

    async readAllText(encoding?: BufferEncoding): Promise<string> {
        return await fs.readFile(this.path, { encoding: encoding ?? 'utf8' });
    }

    async readAllLines(encoding?: BufferEncoding): Promise<string[]> {
        return (await this.readAllText(encoding)).split(/\r?\n/);
    }

    async lineNumber(marker: string): Promise<number> {
        expect(marker).toStartWith('📍');
        const lines = await this.readAllLines();
        const index = lines.findIndex((line) => line.includes(`/*${marker}*/`));
        expect(index).toBeGreaterThanOrEqual(0);
        return index + 1;
    }

    async lineNumbers(...markers: string[]): Promise<number[]> {
        const result: number[] = [];
        for (const marker of markers) {
            const lineNumber = await this.lineNumber(marker);
            result.push(lineNumber);
        }
        return result;
    }

    async createBreakpoint(options: LineBreakpointOptions): Promise<LineBreakpoint> {
        let { line } = options;
        const { isEnabled = true, condition, hitCondition } = options;
        if (typeof line === 'string') {
            line = await this.lineNumber(line);
        }
        return await this.workspace.createBreakpoint(this.path, line, isEnabled, condition, hitCondition);
    }

    async createFunctionBreakpoint(options: FunctionBreakpointOptions): Promise<FunctionBreakpoint> {
        return await this.workspace.createFunctionBreakpoint(options);
    }

    /**
     * Starts debugging using the default config and derives the args from the file name.
     * For example, if the file is 'default/variables.cu', it will use 'default:launch'
     * config with args set to ['variables'].
     */
    async startDebugging(baseConfigName = 'default:launch'): Promise<DebugSession> {
        const fileName = path.basename(this.path, path.extname(this.path));
        return await this.workspace.startDebugging(baseConfigName, { args: [fileName] });
    }
}

class Breakpoint {
    readonly workspace: Workspace;
    #isEnabled: boolean;
    #dap?: DebugProtocol.Breakpoint;

    /// The number of times this breakpoint has triggered a "stopped" event. Note that this is not the
    /// same as the number of times it has been hit in case of conditional and hitcount breakpoints.
    breakCount: number = 0;

    constructor(workspace: Workspace, isEnabled = true) {
        this.workspace = workspace;
        this.#isEnabled = isEnabled;

        workspace.on('break', (breakpoints) => {
            if (breakpoints.includes(this)) {
                ++this.breakCount;
            }
        });
    }

    get dap(): DebugProtocol.Breakpoint {
        expect(this.#dap).toBeDefined();
        return this.#dap!;
    }

    set dap(dap: DebugProtocol.Breakpoint) {
        this.#dap = dap;
    }

    get isEnabled(): boolean {
        return this.#isEnabled;
    }

    async enable(): Promise<void> {
        if (!this.#isEnabled) {
            this.#isEnabled = true;
            await this.workspace.reapplyBreakpoints();
        }
    }

    async disable(): Promise<void> {
        if (this.#isEnabled) {
            this.#isEnabled = false;
            await this.workspace.reapplyBreakpoints();
        }
    }

    async remove(): Promise<void> {
        await this.workspace.removeBreakpoint(this);
    }

    expectToBeVerified(): void {
        expect(this.#dap).toEqual(
            expect.objectContaining({
                verified: true
            })
        );
    }

    expectBreakCount(count: number): void {
        expect(this.breakCount).toEqual(count);
    }

    async waitForBreakCount(count: number): Promise<void> {
        await waitForExpect(() => this.expectBreakCount(count));
    }
}

class LineBreakpoint extends Breakpoint {
    readonly path: string;
    readonly line: number;
    readonly condition?: string;
    readonly hitCondition?: string;

    constructor(workspace: Workspace, filePath: string, line: number, isEnabled = true, condition?: string, hitCondition?: string) {
        super(workspace, isEnabled);
        this.path = filePath;
        this.line = line;
        this.condition = condition;
        this.hitCondition = hitCondition;
    }
}

class FunctionBreakpoint extends Breakpoint {
    readonly name: string;
    readonly condition?: string;
    readonly hitCondition?: string;

    constructor(workspace: Workspace, name: string, isEnabled = true, condition?: string, hitCondition?: string) {
        super(workspace, isEnabled);
        this.name = name;
        this.condition = condition;
        this.hitCondition = hitCondition;
    }
}

class DapClient extends ProtocolClient {
    connect(readable: Readable, writable: Writable): void {
        super.connect(readable, writable);
    }
}

interface DebugSessionEvents {
    disposed: [];
}

class DebugSession extends EventEmitter<DebugSessionEvents> implements AsyncDisposable {
    readonly workspace: Workspace;
    readonly config: CudaGdbDebugConfig;
    readonly dap: DapClient;
    #server?: DapServer;
    readonly #id: number = 0;
    #isInitialized: boolean = false;
    #lastStop?: DebugProtocol.StoppedEvent['body'];
    #threads?: Thread[];
    #pipe: {
        clientEnd?: Duplex;
        serverEnd?: Duplex;
    } = {};

    constructor(workspace: Workspace, config: CudaGdbDebugConfig) {
        super({ captureRejections: true });
        this.config = { ...config };
        if (currentLogPath) {
            this.config.verboseLogging = true;
            for (this.#id = 1; ; ++this.#id) {
                this.config.logFile = path.resolve(currentLogPath, `adapter.${this.#id}.log`);
                if (!fsSync.existsSync(this.config.logFile)) {
                    break;
                }
            }
        }
        Object.freeze(this.config);

        this.workspace = workspace;
        this.dap = new DapClient();

        this.dap.on('breakpoint', (event: DebugProtocol.BreakpointEvent) => this.#onDapBreakpoint(event));
        this.dap.on('stopped', (event: DebugProtocol.StoppedEvent) => this.#onDapStopped(event));

        this.workspace.emit('debugSessionCreated', this);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }

    async dispose(): Promise<void> {
        await this.disconnect();
        const { clientEnd, serverEnd } = this.#pipe;
        if (clientEnd) {
            clientEnd.destroy();
        }
        if (serverEnd) {
            serverEnd.destroy();
        }
        await waitForExpect(() => {
            expect(this.#pipe.clientEnd).toBeUndefined();
            expect(this.#pipe.serverEnd).toBeUndefined();
        });
        this.emit('disposed');
        this.workspace.emit('debugSessionDisposed', this);
    }

    #onDapBreakpoint(event: DebugProtocol.BreakpointEvent): void {
        const { reason, breakpoint: dapBreakpoint } = event.body;
        if (reason === 'changed' && dapBreakpoint.id !== undefined && dapBreakpoint.id !== null) {
            const bp = this.workspace.breakpoints.find((b) => b.dap?.id === dapBreakpoint.id);
            expect(bp).toBeDefined();
            bp!.dap = event.body.breakpoint;
        }
    }

    async #onDapStopped(event: DebugProtocol.StoppedEvent): Promise<void> {
        this.#lastStop = event.body;
        await this.clearCaches();
        await this.#reportHitBreakpoints(event);
    }

    async #reportHitBreakpoints(event: DebugProtocol.StoppedEvent): Promise<void> {
        if (event.body.reason !== 'breakpoint' && event.body.reason !== 'function breakpoint') {
            return;
        }

        if (event.body.hitBreakpointIds) {
            for (const bpId of event.body.hitBreakpointIds) {
                this.workspace.emit(
                    'break',
                    this.workspace.breakpoints.filter((b) => b.dap?.id === bpId)
                );
            }
            return;
        }

        const threads = await this.threads();
        const thread = threads.find((t) => t.dap.id === event.body.threadId);
        expect(thread).toBeDefined();

        const callStack = await thread!.callStack();
        expect(callStack).not.toBeEmpty();

        const { location } = callStack[0];

        // For line breakpoints, check file and line
        const lineBreakpoints = this.workspace.breakpoints.filter((bp) => bp instanceof LineBreakpoint && bp.path === location.fileName && bp.dap?.line === location.lineNumber);

        // For function breakpoints, check if the function name matches
        const functionBreakpoints = this.workspace.breakpoints.filter((bp) => bp instanceof FunctionBreakpoint && callStack.some((frame) => frame.name === bp.name));

        if (lineBreakpoints.length === 0 && functionBreakpoints.length === 0) {
            // No matching user breakpoints — likely an internal stop (e.g. break_on_launch).
            // Auto-continue so user breakpoints can fire.
            await this.continue();
            return;
        }

        this.workspace.emit('break', [...lineBreakpoints, ...functionBreakpoints]);
    }

    async start(): Promise<void> {
        expect(this.#server).toBeUndefined();

        const logFile = currentLogPath ? path.resolve(currentLogPath, `client.${this.#id}.log`) : undefined;

        const writeLog = (data: string | Uint8Array): void => {
            if (logFile) {
                fsSync.appendFileSync(logFile, data);
            }
        };

        const makeTransform = (banner: string): Transform =>
            new Transform({
                transform(chunk, encoding, callback) {
                    writeLog(banner);
                    writeLog(chunk);
                    writeLog('\n\n\n');
                    callback(null, chunk);
                },
                destroy(error, callback) {
                    callback(error);
                }
            });

        const [clientEnd, serverEnd] = duplexPair();

        const clientTransform = makeTransform('### CLIENT -> SERVER\n');
        clientTransform.pipe(clientEnd);

        const serverTransform = makeTransform('### SERVER -> CLIENT\n');
        serverTransform.pipe(serverEnd);

        this.#pipe = { clientEnd, serverEnd };
        clientEnd.on('close', () => (this.#pipe.clientEnd = undefined));
        serverEnd.on('close', () => (this.#pipe.serverEnd = undefined));

        this.#server = new DapServer();
        this.#server.setRunAsServer(true); // otherwise it will process.exit() on disconnect
        this.#server.start(serverEnd, serverTransform);
        this.dap.connect(clientEnd, clientTransform);
    }

    async disconnect(): Promise<void> {
        try {
            await this.dap.send('disconnect');
        } catch (error) {
            console.warn('Error while disconnecting:', error);
        }
    }

    async initialize(): Promise<void> {
        expect(this.#isInitialized).toBeFalse();
        if (this.#server === undefined) {
            await this.start();
        }
        const initializeResponse = await this.dap.send('initialize', {
            clientID: 'test-client',
            adapterID: 'cuda-gdb',
            pathFormat: 'path'
        });
        expect(initializeResponse.body).toEqual(
            expect.objectContaining({
                supportsConfigurationDoneRequest: true,
                supportsSetVariable: true,
                supportsConditionalBreakpoints: true,
                supportsHitConditionalBreakpoints: true,
                supportsLogPoints: true,
                supportsFunctionBreakpoints: true,
                supportsDisassembleRequest: true,
                supportsReadMemoryRequest: true,
                supportsWriteMemoryRequest: true
            })
        );
        this.#isInitialized = true;
    }

    async startDebugging(): Promise<void> {
        if (!this.#isInitialized) {
            await this.initialize();
        }
        await this.expectEvent('initialized', async () => {
            this.dap.send(this.config.request, this.config);
        });
        await this.reapplyBreakpoints();
        await this.reapplyFunctionBreakpoints();
    }

    get lastStop(): DebugProtocol.StoppedEvent['body'] {
        expect(this.#lastStop).toBeDefined();
        return this.#lastStop!;
    }

    async configurationDone(): Promise<void> {
        await this.dap.send('configurationDone');
    }

    async continue(): Promise<void> {
        await this.dap.send('continue', { threadId: this.lastStop.threadId });
    }

    async stepIn(): Promise<void> {
        await this.dap.send('stepIn', { threadId: this.lastStop.threadId });
    }

    async stepOver(): Promise<void> {
        await this.dap.send('next', { threadId: this.lastStop.threadId });
    }

    async stepOut(): Promise<void> {
        await this.dap.send('stepOut', { threadId: this.lastStop.threadId });
    }

    async pause(): Promise<void> {
        const threads = await this.threads();
        if (threads.length > 0) {
            await this.dap.send('pause', { threadId: threads[0].dap.id });
        }
    }

    async stepInAndExpect(): Promise<DebugProtocol.StoppedEvent['body']> {
        return await this.expectStepEvent(async () => {
            await this.stepIn();
        });
    }

    async stepOverAndExpect(): Promise<DebugProtocol.StoppedEvent['body']> {
        return await this.expectStepEvent(async () => {
            await this.stepOver();
        });
    }

    async stepOutAndExpect(): Promise<DebugProtocol.StoppedEvent['body']> {
        return await this.expectStepEvent(async () => {
            await this.stepOut();
        });
    }

    async reapplyBreakpoints(filePath?: string): Promise<void> {
        if (filePath === undefined) {
            const lineBreakpoints = this.workspace.breakpoints.filter((bp): bp is LineBreakpoint => bp instanceof LineBreakpoint);
            const filePaths = new Set(lineBreakpoints.map((bp) => bp.path));
            for (const filePath of filePaths) {
                await this.reapplyBreakpoints(filePath);
            }
            return;
        }

        const breakpoints = this.workspace.breakpoints.filter((bp): bp is LineBreakpoint => bp instanceof LineBreakpoint && bp.isEnabled && bp.path === filePath);
        const {
            body: { breakpoints: dapBreakpoints }
        } = await this.dap.send('setBreakpoints', {
            source: { path: filePath },
            breakpoints: breakpoints.map(({ line, condition, hitCondition }) => {
                const bp: any = { line };
                if (condition) bp.condition = condition;
                if (hitCondition) bp.hitCondition = hitCondition;
                return bp;
            })
        });
        expect(dapBreakpoints).toHaveLength(breakpoints.length);
        for (const [i, bp] of breakpoints.entries()) {
            bp.dap = dapBreakpoints[i];
        }
    }

    async reapplyFunctionBreakpoints(): Promise<void> {
        const breakpoints = this.workspace.breakpoints.filter((bp): bp is FunctionBreakpoint => bp instanceof FunctionBreakpoint && bp.isEnabled);
        const {
            body: { breakpoints: dapBreakpoints }
        } = await this.dap.send('setFunctionBreakpoints', {
            breakpoints: breakpoints.map(({ name, condition, hitCondition }) => {
                const bp: any = { name };
                if (condition) bp.condition = condition;
                if (hitCondition) bp.hitCondition = hitCondition;
                return bp;
            })
        });
        expect(dapBreakpoints).toHaveLength(breakpoints.length);
        for (const [i, bp] of breakpoints.entries()) {
            bp.dap = dapBreakpoints[i];
        }
    }

    async expectEvent(event: string, block: () => Promise<void>): Promise<DebugProtocol.Event> {
        const promise = new Promise<DebugProtocol.Event>((resolve) => {
            this.dap.on(event, (e: DebugProtocol.Event) => {
                resolve(e);
            });
        });
        await block();
        expect(promise).toResolve();
        return promise;
    }

    async expectBreakpointHit(breakpoint: Breakpoint, callback: () => Promise<void>): Promise<DebugProtocol.StoppedEvent['body']> {
        const { body } = (await this.expectEvent('stopped', callback)) as DebugProtocol.StoppedEvent;

        expect(body).toEqual(
            expect.objectContaining({
                reason: 'breakpoint',
                allThreadsStopped: true,
                threadId: expect.any(Number)
                // TODO: Check hitBreakpointIds when they are implemented by the server
            })
        );

        // Check that file name and line number match the breakpoint.

        const threads = await this.threads();
        const thread = threads.find((t) => t.dap.id === body.threadId);
        expect(thread).toBeDefined();

        const callStack = await thread!.callStack();
        expect(callStack).not.toBeEmpty();

        const { location } = callStack[0];

        if (breakpoint instanceof LineBreakpoint) {
            expect(location).toEqual(
                expect.objectContaining({
                    fileName: breakpoint.path,
                    lineNumber: breakpoint.dap.line
                })
            );
        } else if (breakpoint instanceof FunctionBreakpoint) {
            expect(callStack[0].name).toEqual(breakpoint.name);
        }

        return body;
    }

    async expectStepEvent(callback: () => Promise<void>): Promise<DebugProtocol.StoppedEvent['body']> {
        const { body } = (await this.expectEvent('stopped', callback)) as DebugProtocol.StoppedEvent;

        expect(body).toEqual(
            expect.objectContaining({
                reason: 'step',
                allThreadsStopped: true,
                threadId: expect.any(Number)
            })
        );

        return body;
    }

    async threads(): Promise<Thread[]> {
        if (this.#threads) {
            return this.#threads;
        }
        const {
            body: { threads }
        } = await this.dap.send('threads');
        expect(threads).toBeArray();
        this.#threads = threads.map((dapThread) => new Thread(this, dapThread));
        return this.#threads;
    }

    async mainThread(): Promise<Thread> {
        const threads = await this.threads();
        expect(threads).not.toBeEmpty();
        return threads[0];
    }

    async thread(threadId: number): Promise<Thread> {
        const threads = await this.threads();
        const thread = threads.find((t) => t.dap.id === threadId);
        expect(thread).toBeDefined();
        return thread!;
    }

    async lastStopStackFrame(): Promise<StackFrame> {
        const lastStop = this.#lastStop;
        expect(lastStop).toBeDefined();
        const threadId = lastStop!.threadId;
        const threads = await this.threads();
        const thread = threads.find((t) => t.dap.id === threadId);
        expect(thread).toBeDefined();
        return thread!.currentStackFrame();
    }

    async clearCaches(): Promise<void> {
        this.#threads = undefined;
    }
}

class Thread {
    readonly session: DebugSession;
    readonly dap: DebugProtocol.Thread;
    #callStack?: StackFrame[];

    constructor(session: DebugSession, dap: DebugProtocol.Thread) {
        this.session = session;
        this.dap = dap;
    }

    async callStack(): Promise<StackFrame[]> {
        if (this.#callStack) {
            return this.#callStack;
        }
        const {
            body: { stackFrames }
        } = await this.session.dap.send('stackTrace', {
            threadId: this.dap.id
        });
        expect(stackFrames).toBeArray();
        this.#callStack = stackFrames.map((dapFrame) => new StackFrame(this, dapFrame));
        return this.#callStack;
    }

    async currentStackFrame(): Promise<StackFrame> {
        const callStack = await this.callStack();
        expect(callStack).not.toBeEmpty();
        return callStack.at(-1)!;
    }

    clearCaches(): void {
        this.#callStack = undefined;
    }
}

class StackFrame {
    readonly thread: Thread;
    readonly dap: DebugProtocol.StackFrame;
    #scopes?: { [name: string]: Scope };

    constructor(thread: Thread, dap: DebugProtocol.StackFrame) {
        this.thread = thread;
        this.dap = dap;
    }

    get session(): DebugSession {
        return this.thread.session;
    }

    get name(): string {
        return this.dap.name;
    }

    get location(): { fileName: string | undefined; lineNumber: number } {
        return { fileName: this.dap.source?.path, lineNumber: this.dap.line };
    }

    async expectLocation(expected: { name?: string; file: string | WorkspaceFile; line?: number | number[] | string | string[] } | { name?: string; file?: string | WorkspaceFile; line?: number | number[] }): Promise<void> {
        const { fileName, lineNumber } = this.location;

        const expectedName = expected.name;
        if (expectedName !== undefined) {
            expect(this.name).toEqual(expectedName);
        }

        const expectedFile = typeof expected.file === 'string' ? this.thread.session.workspace.file(expected.file) : expected.file;
        if (expectedFile !== undefined) {
            expect(fileName).toEqual(expectedFile.path);
        }

        if (expected.line !== undefined) {
            const lines = typeof expected.line === 'object' ? expected.line : [expected.line];
            const expectedLineNumbers = await Promise.all(
                lines.map(async (line) => {
                    if (typeof line === 'number') {
                        return line;
                    }
                    expect(expectedFile).toBeDefined();
                    return await expectedFile!.lineNumber(line);
                })
            );
            expect(lineNumber).toBeOneOf(expectedLineNumbers);
        }
    }

    async scopes(): Promise<{ [name: string]: Scope }> {
        if (this.#scopes) {
            return this.#scopes;
        }
        const {
            body: { scopes }
        } = await this.session.dap.send('scopes', {
            frameId: this.dap.id
        });
        expect(scopes).toBeArray();
        this.#scopes = Object.freeze(
            Object.fromEntries(
                scopes.map((dapScope) => {
                    const container = new Scope(this, dapScope);
                    return [dapScope.name, container];
                })
            )
        );
        return this.#scopes;
    }

    async locals(): Promise<{ [name: string]: Variable }> {
        const scopes = await this.scopes();
        const localsScope = scopes['Local'];
        expect(localsScope).toBeDefined();
        return localsScope.children();
    }

    async local(name: string): Promise<Variable> {
        const scopes = await this.scopes();
        const localsScope = scopes['Local'];
        expect(localsScope).toBeDefined();
        return localsScope.var(name);
    }

    async expectNoLocal(name: string): Promise<void> {
        const locals = await this.locals();
        expect(locals).not.toContainKey(name);
    }

    async expectLocal(name: string, value: unknown): Promise<Variable> {
        const variable = await this.local(name);
        expect(variable.dap.value).toEqual(value);
        return variable;
    }

    clearCaches(): void {
        this.#scopes = undefined;
    }
}

class VariableContainer {
    readonly stackFrame: StackFrame;
    readonly variablesReference: number;
    #children?: Variable[];

    constructor(stackFrame: StackFrame, variablesReference: number) {
        this.stackFrame = stackFrame;
        this.variablesReference = variablesReference;
    }

    async childrenArray(): Promise<Variable[]> {
        if (this.#children) {
            return this.#children;
        }
        const {
            body: { variables }
        } = await this.stackFrame.session.dap.send('variables', {
            variablesReference: this.variablesReference
        });
        expect(variables).toBeArray();
        this.#children = variables.map((dapVariable) => new Variable(this.stackFrame, dapVariable));
        return this.#children;
    }

    async children(): Promise<{ [name: string]: Variable }> {
        const childrenArray = await this.childrenArray();
        return Object.freeze(
            Object.fromEntries(
                childrenArray.map((variable) => {
                    return [variable.dap.name, variable];
                })
            )
        );
    }

    async var(name: string): Promise<Variable> {
        const children = await this.children();
        const variable = children[name];
        expect(variable).toBeDefined();
        return variable;
    }

    clearCaches(): void {
        this.#children = undefined;
    }
}

class Scope extends VariableContainer {
    readonly dap: DebugProtocol.Scope;

    constructor(stackFrame: StackFrame, dapScope: DebugProtocol.Scope) {
        super(stackFrame, dapScope.variablesReference);
        this.dap = dapScope;
    }
}

class Variable extends VariableContainer {
    readonly dap: DebugProtocol.Variable;

    constructor(stackFrame: StackFrame, dapVariable: DebugProtocol.Variable) {
        super(stackFrame, dapVariable.variablesReference);
        this.dap = dapVariable;
    }

    get name(): string {
        return this.dap.name;
    }

    get value(): string {
        return this.dap.value;
    }

    async setValue(value: string): Promise<void> {
        const session = this.stackFrame.session;
        const response = await session.dap.send('setVariable', {
            variablesReference: this.variablesReference,
            name: this.name,
            value
        });
        this.dap.value = response.body.value;
    }
}
