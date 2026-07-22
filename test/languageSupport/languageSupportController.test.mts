import { jest } from '@jest/globals';
import * as vscode from 'vscode';
import { activateLanguageSupport, consumeRecordedProviderWrites, LanguageSupportController } from '../../src/languageSupportController.ts';
import { type LanguageSupportConfigurationTrigger, languageSupportAutoConfigureConfiguration, languageSupportProviderConfiguration } from '../../src/languageSupport/constants.ts';
import { type InstalledLanguageProviders, type LanguageProvider, languageProviderRegistry } from '../../src/languageSupport/providers.ts';
import { commands, extensions, fireExtensionsChanged, fireWorkspaceConfigurationChanged, fireWorkspaceFoldersChanged, getRegisteredCommand, resetVscodeMock, window, workspace } from '../mocks/vscode.mts';

type Deferred = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason?: unknown) => void;
};

type TestContext = vscode.ExtensionContext & {
    subscriptions: Array<{ dispose(): void }>;
};

type ConfigureLanguageSupport = (workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger) => Promise<void>;

type PromptManagerFake = {
    pickWorkspaceForClangdGeneration: jest.MockedFunction<() => Promise<vscode.WorkspaceFolder | undefined>>;
    resetDismissalsForProviderChange: jest.MockedFunction<(workspaceFolder: vscode.WorkspaceFolder, previous: InstalledLanguageProviders, current: InstalledLanguageProviders) => Promise<void>>;
    showOnce: jest.MockedFunction<(stateKey: string, message: string, kind: 'info' | 'warning') => Promise<void>>;
};

type WorkspaceConfiguratorFake = {
    configureLanguageSupport: jest.MockedFunction<ConfigureLanguageSupport>;
    generateClangdConfigForWorkspace: jest.MockedFunction<(workspaceFolder: vscode.WorkspaceFolder) => Promise<void>>;
};

function deferred(): Deferred {
    let resolvePromise!: () => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function waitForRunCount(runs: unknown[], expectedCount: number): Promise<void> {
    for (let attempt = 0; attempt < 20 && runs.length < expectedCount; attempt++) {
        await flushMicrotasks();
    }
}

function createContext(values = new Map<string, unknown>()): TestContext {
    return {
        extensionPath: '/extension',
        subscriptions: [],
        workspaceState: {
            get: <T,>(key: string, defaultValue?: T) => (values.has(key) ? values.get(key) : defaultValue) as T | undefined,
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    values.delete(key);
                    return;
                }

                values.set(key, value);
            }
        }
    } as unknown as TestContext;
}

function createOutputChannel(): vscode.OutputChannel {
    return { appendLine: jest.fn() } as unknown as vscode.OutputChannel;
}

function createPromptManager(): PromptManagerFake {
    // showOnce is a plain spy: its once-per-workspace throttle is production behavior owned by
    // LanguageSupportPromptManager and verified in promptManager.test.mts. Re-implementing it here
    // would make controller tests assert the fake's logic instead of the controller's delegation.
    return {
        pickWorkspaceForClangdGeneration: jest.fn(async () => undefined),
        resetDismissalsForProviderChange: jest.fn(async () => {}),
        showOnce: jest.fn(async () => {})
    };
}

function createWorkspaceConfigurator(configureLanguageSupport: ConfigureLanguageSupport = async () => {}): WorkspaceConfiguratorFake {
    return {
        configureLanguageSupport: jest.fn(configureLanguageSupport),
        generateClangdConfigForWorkspace: jest.fn(async () => {})
    };
}

function createQueueController(configure: (trigger: LanguageSupportConfigurationTrigger) => Promise<void>): LanguageSupportController {
    const workspaceFolder = createWorkspaceFolder('workspace', '/workspace');
    workspace.workspaceFolders = [workspaceFolder];
    setCudaFileSearch({ [workspaceFolder.uri.fsPath]: { cu: true } });

    return createControllerWithConfigurator(async (_workspaceFolder, trigger) => configure(trigger));
}

function createControllerWithConfigurator(configureLanguageSupport: ConfigureLanguageSupport = async () => {}): LanguageSupportController {
    const promptManager = createPromptManager();
    const workspaceConfigurator = createWorkspaceConfigurator(configureLanguageSupport);
    return new LanguageSupportController(promptManager, workspaceConfigurator, createOutputChannel());
}

function createUri(scheme: string, fsPath: string): vscode.Uri {
    return {
        scheme,
        fsPath,
        toString: () => `${scheme}://${fsPath}`
    } as vscode.Uri;
}

function createWorkspaceFolder(name: string, fsPath: string, scheme = 'file'): vscode.WorkspaceFolder {
    return {
        name,
        uri: scheme === 'file' ? vscode.Uri.file(fsPath) : createUri(scheme, fsPath),
        index: 0
    };
}

function setCudaFileSearch(matches: Record<string, { cu?: boolean; cuh?: boolean }>): void {
    workspace.findFiles.mockImplementation(async (include: unknown, exclude?: unknown, maxResults?: unknown) => {
        const pattern = include as { baseUri: vscode.Uri; pattern: string };
        const folderMatches = matches[pattern.baseUri.fsPath] ?? {};
        const hasMatch = (pattern.pattern === '**/*.cu' && folderMatches.cu) || (pattern.pattern === '**/*.cuh' && folderMatches.cuh);

        expect(exclude).toBe('**/{.git,node_modules,out,dist,build}/**');
        expect(maxResults).toBe(1);

        return hasMatch ? [vscode.Uri.file(`${pattern.baseUri.fsPath}/${pattern.pattern === '**/*.cu' ? 'kernel.cu' : 'kernel.cuh'}`)] : [];
    });
}

function mockActivationController(): {
    requestSpy: jest.SpiedFunction<LanguageSupportController['requestCudaConfiguration']>;
    generateSpy: jest.SpiedFunction<LanguageSupportController['generateClangdConfig']>;
    resetSpy: jest.SpiedFunction<LanguageSupportController['resetProviderDismissals']>;
} {
    return {
        requestSpy: jest.spyOn(LanguageSupportController.prototype, 'requestCudaConfiguration').mockResolvedValue(undefined),
        generateSpy: jest.spyOn(LanguageSupportController.prototype, 'generateClangdConfig').mockResolvedValue(undefined),
        resetSpy: jest.spyOn(LanguageSupportController.prototype, 'resetProviderDismissals').mockResolvedValue(undefined)
    };
}

describe('LanguageSupportController', () => {
    beforeEach(() => {
        resetVscodeMock();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('runs one queued user-requested configuration after an active automatic request', async () => {
        const runs: LanguageSupportConfigurationTrigger[] = [];
        const gates: Deferred[] = [];
        const controller = createQueueController(async (trigger) => {
            runs.push(trigger);
            const gate = deferred();
            gates.push(gate);
            await gate.promise;
        });

        const first = controller.requestCudaConfiguration('automatic');
        await waitForRunCount(runs, 1);
        expect(runs).toEqual(['automatic']);

        expect(controller.requestCudaConfiguration('automatic')).toBe(first);
        expect(controller.requestCudaConfiguration('userRequested')).toBe(first);
        expect(controller.requestCudaConfiguration('userRequested')).toBe(first);
        expect(runs).toEqual(['automatic']);

        let finished = false;
        void first.then(() => {
            finished = true;
            return undefined;
        });
        gates[0].resolve();
        await waitForRunCount(runs, 2);
        expect(runs).toEqual(['automatic', 'userRequested']);
        expect(finished).toBe(false);

        gates[1].resolve();
        await first;
        expect(finished).toBe(true);
    });

    test('configures CUDA workspaces detected from .cu and .cuh files', async () => {
        const cuFolder = createWorkspaceFolder('cu-workspace', '/workspace/cu');
        const cuhFolder = createWorkspaceFolder('cuh-workspace', '/workspace/cuh');
        const emptyFolder = createWorkspaceFolder('empty-workspace', '/workspace/empty');
        const configureLanguageSupport = jest.fn<ConfigureLanguageSupport>(async () => {});
        workspace.workspaceFolders = [cuFolder, cuhFolder, emptyFolder];
        setCudaFileSearch({
            [cuFolder.uri.fsPath]: { cu: true },
            [cuhFolder.uri.fsPath]: { cuh: true }
        });

        await createControllerWithConfigurator(configureLanguageSupport).requestCudaConfiguration('automatic');

        expect(configureLanguageSupport).toHaveBeenCalledTimes(2);
        expect(configureLanguageSupport).toHaveBeenNthCalledWith(1, cuFolder, 'automatic');
        expect(configureLanguageSupport).toHaveBeenNthCalledWith(2, cuhFolder, 'automatic');
    });

    test('filters workspaces by supported URI scheme before searching for CUDA files', async () => {
        const fileFolder = createWorkspaceFolder('file-workspace', '/workspace/file');
        const remoteFolder = createWorkspaceFolder('remote-workspace', '/workspace/remote', 'vscode-remote');
        const virtualFolder = createWorkspaceFolder('virtual-workspace', '/workspace/virtual', 'memfs');
        const configureLanguageSupport = jest.fn<ConfigureLanguageSupport>(async () => {});
        workspace.workspaceFolders = [fileFolder, remoteFolder, virtualFolder];
        setCudaFileSearch({
            [fileFolder.uri.fsPath]: { cu: true },
            [remoteFolder.uri.fsPath]: { cuh: true },
            [virtualFolder.uri.fsPath]: { cu: true }
        });

        await createControllerWithConfigurator(configureLanguageSupport).requestCudaConfiguration('automatic');

        const searchedPaths = workspace.findFiles.mock.calls.map(([include]) => (include as { baseUri: vscode.Uri }).baseUri.fsPath);
        expect(searchedPaths).toContain(fileFolder.uri.fsPath);
        expect(searchedPaths).toContain(remoteFolder.uri.fsPath);
        expect(searchedPaths).not.toContain(virtualFolder.uri.fsPath);
        expect(configureLanguageSupport).toHaveBeenCalledWith(fileFolder, 'automatic');
        expect(configureLanguageSupport).toHaveBeenCalledWith(remoteFolder, 'automatic');
        expect(configureLanguageSupport).not.toHaveBeenCalledWith(virtualFolder, expect.anything());
    });

    test('shows the user-requested no-CUDA notification when no CUDA workspace is detected', async () => {
        const folder = createWorkspaceFolder('workspace', '/workspace');
        const configureLanguageSupport = jest.fn<ConfigureLanguageSupport>(async () => {});
        workspace.workspaceFolders = [folder];
        setCudaFileSearch({});

        await createControllerWithConfigurator(configureLanguageSupport).requestCudaConfiguration('userRequested');

        expect(configureLanguageSupport).not.toHaveBeenCalled();
        expect(window.showInformationMessage).toHaveBeenCalledWith('Nsight did not find .cu or .cuh files in supported workspace folders.');
    });

    test('delegates automatic setup errors to showOnce but surfaces user-requested errors every time', async () => {
        const folder = createWorkspaceFolder('workspace', '/workspace');
        const configureLanguageSupport = jest.fn<ConfigureLanguageSupport>(async () => {
            throw new Error('setup failed');
        });
        workspace.workspaceFolders = [folder];
        setCudaFileSearch({ [folder.uri.fsPath]: { cu: true } });
        const promptManager = createPromptManager();
        const controller = new LanguageSupportController(promptManager, createWorkspaceConfigurator(configureLanguageSupport), createOutputChannel());

        await controller.requestCudaConfiguration('automatic');
        await controller.requestCudaConfiguration('automatic');

        // Automatic errors are routed through promptManager.showOnce (its once-per-workspace throttle is
        // verified in promptManager.test.mts); the controller must not surface them directly.
        expect(promptManager.showOnce).toHaveBeenCalledWith(expect.stringContaining('setupErrorShown'), expect.stringContaining('setup failed'), 'warning');
        expect(window.showWarningMessage).not.toHaveBeenCalled();

        await controller.requestCudaConfiguration('userRequested');
        await controller.requestCudaConfiguration('userRequested');

        // User-requested errors bypass showOnce and surface on every run.
        expect(window.showWarningMessage).toHaveBeenCalledTimes(2);
    });

    test('reports manual clangd generation errors with useful context', async () => {
        const folder = createWorkspaceFolder('workspace', '/workspace');
        const promptManager = createPromptManager();
        const workspaceConfigurator = createWorkspaceConfigurator();
        const outputChannel = createOutputChannel();
        promptManager.pickWorkspaceForClangdGeneration.mockResolvedValue(folder);
        workspaceConfigurator.generateClangdConfigForWorkspace.mockRejectedValue(new Error('write failed'));
        const controller = new LanguageSupportController(promptManager, workspaceConfigurator, outputChannel);

        await expect(controller.generateClangdConfig()).resolves.toBeUndefined();

        expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Nsight could not complete .clangd generation for workspace: write failed'));
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('workspace: write failed'));

        resetVscodeMock();
        const pickerPromptManager = createPromptManager();
        const unusedWorkspaceConfigurator = createWorkspaceConfigurator();
        const pickerOutputChannel = createOutputChannel();
        pickerPromptManager.pickWorkspaceForClangdGeneration.mockRejectedValue(new Error('picker failed'));
        const pickerController = new LanguageSupportController(pickerPromptManager, unusedWorkspaceConfigurator, pickerOutputChannel);

        await expect(pickerController.generateClangdConfig()).resolves.toBeUndefined();

        expect(unusedWorkspaceConfigurator.generateClangdConfigForWorkspace).not.toHaveBeenCalled();
        expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Nsight could not complete .clangd generation: picker failed'));
        expect(pickerOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('CUDA: Generate .clangd: picker failed'));
    });

    test('activation registers command callbacks and requests initial automatic configuration', async () => {
        const { generateSpy, requestSpy } = mockActivationController();
        const context = createContext();

        activateLanguageSupport(context, createOutputChannel());
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('automatic');

        expect(commands.registerCommand).toHaveBeenCalledWith('cuda.configureLanguageSupport', expect.any(Function));
        expect(commands.registerCommand).toHaveBeenCalledWith('cuda.generateClangdConfig', expect.any(Function));

        requestSpy.mockClear();
        await getRegisteredCommand('cuda.configureLanguageSupport')?.();
        await getRegisteredCommand('cuda.generateClangdConfig')?.();

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('userRequested');
        expect(generateSpy).toHaveBeenCalledTimes(1);
    });

    test('reconfigures and resets dismissals when provider extension state changes', async () => {
        const installedExtensions = new Set<string>();
        const { requestSpy, resetSpy } = mockActivationController();
        extensions.getExtension.mockImplementation((extensionId: string) => (installedExtensions.has(extensionId) ? { id: extensionId } : undefined));
        workspace.workspaceFolders = [createWorkspaceFolder('workspace', '/workspace')];

        activateLanguageSupport(createContext(), createOutputChannel());
        requestSpy.mockClear();

        await fireExtensionsChanged();

        expect(resetSpy).not.toHaveBeenCalled();
        expect(requestSpy).not.toHaveBeenCalled();

        installedExtensions.add(languageProviderRegistry.clangd.extensionId);
        await fireExtensionsChanged();

        expect(resetSpy).toHaveBeenCalledWith({ clangd: false, cpptools: false }, { clangd: true, cpptools: false });
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenCalledWith('automatic');
    });

    test('requests automatic configuration when workspace folders change', async () => {
        const { requestSpy } = mockActivationController();

        activateLanguageSupport(createContext(), createOutputChannel());
        requestSpy.mockClear();

        await fireWorkspaceFoldersChanged();

        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith('automatic');
    });

    test('reconfigures only for watched language-support configuration changes', async () => {
        const { requestSpy } = mockActivationController();

        activateLanguageSupport(createContext(), createOutputChannel());
        requestSpy.mockClear();

        await fireWorkspaceConfigurationChanged(['editor.fontSize']);
        expect(requestSpy).not.toHaveBeenCalled();

        await fireWorkspaceConfigurationChanged([languageSupportAutoConfigureConfiguration]);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith('automatic');

        requestSpy.mockClear();
        await fireWorkspaceConfigurationChanged(['nsight.cuda.languageSupport.gpuArch']);
        expect(requestSpy).not.toHaveBeenCalled();

        requestSpy.mockClear();
        await fireWorkspaceConfigurationChanged([languageSupportProviderConfiguration]);
        expect(requestSpy).toHaveBeenCalledTimes(1);
        expect(requestSpy).toHaveBeenLastCalledWith('automatic');
    });
});

describe('consumeRecordedProviderWrites', () => {
    test('drains self-written provider changes without swallowing user edits', () => {
        const recorded = new Map<string, LanguageProvider>([['file:///a', 'clangd']]);

        expect(consumeRecordedProviderWrites(recorded, [{ key: 'file:///a', currentProvider: 'clangd' }])).toBe(true);
        expect(recorded.has('file:///a')).toBe(false);

        const userEdit = new Map<string, LanguageProvider>();

        expect(consumeRecordedProviderWrites(userEdit, [{ key: 'file:///a', currentProvider: 'cpptools' }])).toBe(false);
        expect(userEdit.size).toBe(0);

        const mixedEdit = new Map<string, LanguageProvider>([
            ['file:///a', 'clangd'],
            ['file:///b', 'cpptools']
        ]);

        const suppressed = consumeRecordedProviderWrites(mixedEdit, [
            { key: 'file:///c', currentProvider: 'clangd' },
            { key: 'file:///a', currentProvider: 'clangd' }
        ]);

        expect(suppressed).toBe(false);
        expect(mixedEdit.has('file:///a')).toBe(false);
        expect(mixedEdit.has('file:///b')).toBe(true);

        const staleEntry = new Map<string, LanguageProvider>([['file:///a', 'clangd']]);
        expect(
            consumeRecordedProviderWrites(staleEntry, [
                { key: 'file:///c', currentProvider: 'clangd' },
                { key: 'file:///a', currentProvider: 'clangd' }
            ])
        ).toBe(false);
        expect(consumeRecordedProviderWrites(staleEntry, [{ key: 'file:///a', currentProvider: 'clangd' }])).toBe(false);
    });
});
