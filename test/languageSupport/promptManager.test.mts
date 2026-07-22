import * as vscode from 'vscode';
import { jest } from '@jest/globals';
import { clangdExampleFileName, clangdFileName } from '../../src/languageSupport/clangdSetup.ts';
import { getInstalledLanguageProviders, LanguageSupportPromptManager, type ProviderSelectionSource, type ProviderSetupPolicy, setupPolicyForSource } from '../../src/languageSupport/promptManager.ts';
import { languageSupportConfigurationSection, workspaceStateKey } from '../../src/languageSupport/constants.ts';
import { type InstalledLanguageProviders, type LanguageProvider, languageProviderIds, languageProviderRegistry } from '../../src/languageSupport/providers.ts';
import { commands, extensions, getConfigurationValues, resetVscodeMock, setConfiguration, setInspectedConfiguration, window, workspace } from '../mocks/vscode.mts';

const folder = {
    name: 'workspace',
    uri: vscode.Uri.file('/workspace'),
    index: 0
} satisfies vscode.WorkspaceFolder;

function createContext(values = new Map<string, unknown>()): vscode.ExtensionContext {
    return {
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
    } as unknown as vscode.ExtensionContext;
}

function installedProviders(installedProviderIds: LanguageProvider[]): InstalledLanguageProviders {
    const providers = {} as InstalledLanguageProviders;

    for (const provider of languageProviderIds) {
        providers[provider] = installedProviderIds.includes(provider);
    }

    return providers;
}

function expectedProviderQuickPickItems(installedProviderIds: LanguageProvider[]): Array<{ label: string; description: string; detail: string; provider: LanguageProvider }> {
    const installed = installedProviders(installedProviderIds);
    return languageProviderIds.map((provider) => ({
        label: languageProviderRegistry[provider].label,
        description: installed[provider] ? 'Installed' : 'Not installed',
        detail: languageProviderRegistry[provider].description,
        provider
    }));
}

function selectedProvider(provider: LanguageProvider, source: ProviderSelectionSource = 'userPrompt'): { provider: LanguageProvider; source: ProviderSelectionSource; setupPolicy: ProviderSetupPolicy } {
    return { provider, source, setupPolicy: setupPolicyForSource(source) };
}

function createOutputChannel(): vscode.OutputChannel {
    return { appendLine: jest.fn() } as unknown as vscode.OutputChannel;
}

function failProviderPreferenceSave(): void {
    const configuration = workspace.getConfiguration(languageSupportConfigurationSection) as {
        update: {
            mockRejectedValue(value: unknown): unknown;
        };
    };

    configuration.update.mockRejectedValue(new Error('save failed'));
}

describe('LanguageSupportPromptManager', () => {
    beforeEach(() => {
        resetVscodeMock();
        setConfiguration(languageSupportConfigurationSection, { autoConfigure: true, provider: 'auto' });
        extensions.getExtension.mockReturnValue({ id: 'installed' });
    });

    test('detects installed providers from the provider registry', () => {
        extensions.getExtension.mockImplementation((extensionId: string) => (extensionId === languageProviderRegistry.clangd.extensionId ? { id: extensionId } : undefined));

        expect(getInstalledLanguageProviders()).toEqual(Object.fromEntries(languageProviderIds.map((provider) => [provider, provider === 'clangd'])));
    });

    test('skips auto configuration when disabled but allows user-requested provider prompt', async () => {
        setConfiguration(languageSupportConfigurationSection, { autoConfigure: false, provider: 'auto' });
        const manager = new LanguageSupportPromptManager(createContext());

        await expect(manager.selectProvider(folder, 'automatic')).resolves.toBeUndefined();

        window.showQuickPick.mockResolvedValue({ provider: 'clangd' });
        await expect(manager.selectProvider(folder, 'userRequested')).resolves.toEqual(selectedProvider('clangd'));
        expect(getConfigurationValues(languageSupportConfigurationSection).provider).toBe('clangd');
        expect(window.showQuickPick).toHaveBeenCalledWith(expectedProviderQuickPickItems(['clangd', 'cpptools']), expect.objectContaining({ placeHolder: `Select CUDA C++ language support for ${folder.name}` }));
    });

    test('reports successful provider preference saves', async () => {
        const providerSaved = jest.fn();
        const manager = new LanguageSupportPromptManager(createContext(), undefined, providerSaved);
        window.showQuickPick.mockResolvedValue({ provider: 'clangd' });

        await expect(manager.selectProvider(folder, 'userRequested')).resolves.toEqual(selectedProvider('clangd'));

        expect(providerSaved).toHaveBeenCalledWith(folder, 'clangd');
    });

    test('marks automatic provider reuse as automatic inference', async () => {
        extensions.getExtension.mockImplementation((extensionId: string) => (extensionId === languageProviderRegistry.cpptools.extensionId ? { id: extensionId } : undefined));
        const manager = new LanguageSupportPromptManager(createContext());

        await expect(manager.selectProvider(folder, 'automatic')).resolves.toEqual(selectedProvider('cpptools', 'automaticInference'));

        expect(window.showQuickPick).not.toHaveBeenCalled();
        expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    test('classifies provider preference scope for workspace write consent', async () => {
        for (const { configuration, inspected, expectedSource } of [
            {
                configuration: { autoConfigure: true, provider: 'cpptools' },
                inspected: { provider: { workspaceFolderValue: 'cpptools' } },
                expectedSource: 'workspacePreference'
            },
            {
                configuration: { autoConfigure: true, provider: 'cpptools' },
                inspected: { provider: { workspaceValue: 'cpptools' } },
                expectedSource: 'automaticInference'
            },
            {
                configuration: { autoConfigure: true, provider: 'auto' },
                inspected: { provider: { workspaceValue: 'auto' } },
                expectedSource: 'automaticInference'
            },
            {
                configuration: { autoConfigure: true, provider: 'auto' },
                inspected: { provider: { workspaceFolderValue: 'auto', workspaceValue: 'cpptools' } },
                expectedSource: 'automaticInference'
            },
            {
                configuration: { autoConfigure: true, provider: 'cpptools' },
                inspected: { provider: { globalValue: 'cpptools' } },
                expectedSource: 'automaticInference'
            }
        ] as const) {
            resetVscodeMock();
            setConfiguration(languageSupportConfigurationSection, configuration);
            setInspectedConfiguration(languageSupportConfigurationSection, inspected);
            extensions.getExtension.mockImplementation((extensionId: string) => (extensionId === languageProviderRegistry.cpptools.extensionId ? { id: extensionId } : undefined));
            const manager = new LanguageSupportPromptManager(createContext());

            await expect(manager.selectProvider(folder, 'automatic')).resolves.toEqual(selectedProvider('cpptools', expectedSource));
        }
    });

    test('reads the provider preference from the requested folder scope', async () => {
        const folderA = { name: 'a', uri: vscode.Uri.file('/a'), index: 0 } satisfies vscode.WorkspaceFolder;
        const folderB = { name: 'b', uri: vscode.Uri.file('/b'), index: 1 } satisfies vscode.WorkspaceFolder;
        setConfiguration(languageSupportConfigurationSection, { autoConfigure: true, provider: 'clangd' }, folderA.uri);
        setInspectedConfiguration(languageSupportConfigurationSection, { provider: { workspaceFolderValue: 'clangd' } }, folderA.uri);
        setConfiguration(languageSupportConfigurationSection, { autoConfigure: true, provider: 'cpptools' }, folderB.uri);
        setInspectedConfiguration(languageSupportConfigurationSection, { provider: { workspaceFolderValue: 'cpptools' } }, folderB.uri);
        const manager = new LanguageSupportPromptManager(createContext());

        await expect(manager.selectProvider(folderA, 'automatic')).resolves.toEqual(selectedProvider('clangd', 'workspacePreference'));
        await expect(manager.selectProvider(folderB, 'automatic')).resolves.toEqual(selectedProvider('cpptools', 'workspacePreference'));
    });

    test('returns undefined without prompting when provider preference is disabled', async () => {
        setConfiguration(languageSupportConfigurationSection, { autoConfigure: true, provider: 'disabled' });
        const manager = new LanguageSupportPromptManager(createContext());

        await expect(manager.selectProvider(folder, 'automatic')).resolves.toBeUndefined();

        expect(window.showQuickPick).not.toHaveBeenCalled();
        expect(window.showInformationMessage).not.toHaveBeenCalled();
        expect(commands.executeCommand).not.toHaveBeenCalled();
    });

    test('uses deterministic automatic provider selection without prompting when both providers are installed', async () => {
        const manager = new LanguageSupportPromptManager(createContext());

        await expect(manager.selectProvider(folder, 'automatic')).resolves.toEqual(selectedProvider('cpptools', 'automaticInference'));

        expect(window.showQuickPick).not.toHaveBeenCalled();
        expect(getConfigurationValues(languageSupportConfigurationSection).provider).toBe('auto');
    });

    test('remembers automatic install Not now dismissal and installs directly when user-requested', async () => {
        extensions.getExtension.mockReturnValue(undefined);
        const manager = new LanguageSupportPromptManager(createContext());
        window.showQuickPick.mockResolvedValue({ provider: 'cpptools' });
        window.showInformationMessage.mockResolvedValueOnce('Not now');

        await expect(manager.selectProvider(folder, 'automatic')).resolves.toBeUndefined();
        await expect(manager.selectProvider(folder, 'automatic')).resolves.toBeUndefined();
        await expect(manager.selectProvider(folder, 'userRequested')).resolves.toEqual(selectedProvider('cpptools', 'userPrompt'));

        expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
        expect(commands.executeCommand).toHaveBeenCalledWith('workbench.extensions.installExtension', languageProviderRegistry.cpptools.extensionId);
    });

    test('installs a missing provider selected from the manual picker without an extra notification', async () => {
        extensions.getExtension.mockReturnValue(undefined);
        const manager = new LanguageSupportPromptManager(createContext());
        window.showQuickPick.mockResolvedValue({ provider: 'cpptools' });

        await expect(manager.selectProvider(folder, 'userRequested')).resolves.toEqual(selectedProvider('cpptools', 'userPrompt'));

        expect(window.showInformationMessage).not.toHaveBeenCalled();
        expect(commands.executeCommand).toHaveBeenCalledWith('workbench.extensions.installExtension', languageProviderRegistry.cpptools.extensionId);
    });

    test('choose other provider installs a missing selected provider without a second notification', async () => {
        setConfiguration(languageSupportConfigurationSection, { autoConfigure: true, provider: 'cpptools' });
        extensions.getExtension.mockReturnValue(undefined);
        window.showInformationMessage.mockResolvedValueOnce('Choose other provider');
        window.showQuickPick.mockResolvedValue({ provider: 'clangd' });
        const manager = new LanguageSupportPromptManager(createContext());

        await expect(manager.selectProvider(folder, 'automatic')).resolves.toEqual(selectedProvider('clangd', 'userPrompt'));

        expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
        expect(window.showInformationMessage).toHaveBeenNthCalledWith(1, expect.stringContaining(`Install ${languageProviderRegistry.cpptools.label}`), `Install ${languageProviderRegistry.cpptools.label}`, 'Choose other provider', 'Not now');
        expect(window.showQuickPick).toHaveBeenCalledWith(expectedProviderQuickPickItems([]), expect.objectContaining({ placeHolder: `Select CUDA C++ language support for ${folder.name}` }));
        expect(commands.executeCommand).toHaveBeenCalledWith('workbench.extensions.installExtension', languageProviderRegistry.clangd.extensionId);
        expect(getConfigurationValues(languageSupportConfigurationSection).provider).toBe('clangd');
    });

    test('provider preference save failures are logged and do not block provider selection', async () => {
        failProviderPreferenceSave();
        window.showQuickPick.mockResolvedValue({ provider: 'clangd' });
        const outputChannel = createOutputChannel();
        let resolveWarning: ((value?: unknown) => void) | undefined;
        window.showWarningMessage.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveWarning = resolve;
                })
        );
        const manager = new LanguageSupportPromptManager(createContext(), outputChannel);

        await expect(manager.selectProvider(folder, 'userRequested')).resolves.toEqual(selectedProvider('clangd'));

        expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not save the provider preference'));
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('save failed'));
        expect(getConfigurationValues(languageSupportConfigurationSection).provider).toBe('auto');
        resolveWarning?.();
    });

    test('throttles the provider preference save warning to once across automatic runs', async () => {
        // The automatic path must warn only once so repeated automatic runs do not nag. Use a
        // non-persisting workspaceState so the persisted throttle never fires; this isolates the
        // in-memory throttle as the only thing that can suppress the second warning, so removing it
        // would make this test fail.
        extensions.getExtension.mockReturnValue(undefined);
        failProviderPreferenceSave();
        window.showInformationMessage.mockResolvedValue(`Install ${languageProviderRegistry.cpptools.label}`);
        const nonPersistingContext = {
            workspaceState: { get: <T,>(_key: string, defaultValue?: T) => defaultValue, update: async () => {} }
        } as unknown as vscode.ExtensionContext;
        const manager = new LanguageSupportPromptManager(nonPersistingContext);

        await expect(manager.selectProvider(folder, 'automatic')).resolves.toEqual(selectedProvider('cpptools', 'installPrompt'));
        await expect(manager.selectProvider(folder, 'automatic')).resolves.toEqual(selectedProvider('cpptools', 'installPrompt'));

        expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not save the provider preference'));
    });

    test('shows warning when provider install command fails', async () => {
        extensions.getExtension.mockReturnValue(undefined);
        commands.executeCommand.mockRejectedValue(new Error('install failed'));
        window.showInformationMessage.mockResolvedValue(`Install ${languageProviderRegistry.cpptools.label}`);
        const manager = new LanguageSupportPromptManager(createContext());

        await expect(manager.selectProvider(folder, 'automatic')).resolves.toBeUndefined();

        expect(commands.executeCommand).toHaveBeenCalledWith('workbench.extensions.installExtension', languageProviderRegistry.cpptools.extensionId);
        expect(window.showWarningMessage).toHaveBeenCalledWith(`Unable to install ${languageProviderRegistry.cpptools.label}. Install extension '${languageProviderRegistry.cpptools.extensionId}' and run CUDA: Configure CUDA C++ Language Support.`);
        expect(getConfigurationValues(languageSupportConfigurationSection).provider).toBe('auto');
    });

    test('continues configuration after install before the extension is visible', async () => {
        extensions.getExtension.mockReturnValue(undefined);
        const manager = new LanguageSupportPromptManager(createContext());
        window.showInformationMessage.mockResolvedValue(`Install ${languageProviderRegistry.cpptools.label}`);

        await expect(manager.selectProvider(folder, 'automatic')).resolves.toEqual(selectedProvider('cpptools', 'installPrompt'));

        expect(commands.executeCommand).toHaveBeenCalledWith('workbench.extensions.installExtension', languageProviderRegistry.cpptools.extensionId);
        expect(getConfigurationValues(languageSupportConfigurationSection).provider).toBe('cpptools');
    });

    test('remembers fallback clangd generation prompt dismissal for the current session only', async () => {
        const firstSessionValues = new Map<string, unknown>();
        const firstSessionManager = new LanguageSupportPromptManager(createContext(firstSessionValues));
        const secondSessionManager = new LanguageSupportPromptManager(createContext(new Map<string, unknown>()));
        window.showInformationMessage.mockResolvedValueOnce('Not now').mockResolvedValueOnce(`Generate ${clangdFileName}`);

        await expect(firstSessionManager.promptClangdConfigGeneration(folder, 'automatic', false)).resolves.toBe(false);
        await expect(firstSessionManager.promptClangdConfigGeneration(folder, 'automatic', false)).resolves.toBe(false);
        await expect(secondSessionManager.promptClangdConfigGeneration(folder, 'automatic', false)).resolves.toBe(true);

        expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
        expect(firstSessionValues.size).toBe(0);
    });

    test('remembers compile_commands clangd generation prompt separately for the current session', async () => {
        const values = new Map<string, unknown>();
        const manager = new LanguageSupportPromptManager(createContext(values));
        const stateKey = workspaceStateKey(folder, 'clangdConfigGenerationPromptDismissed.v2');
        window.showInformationMessage.mockResolvedValueOnce('Not now').mockResolvedValueOnce(`Generate ${clangdFileName}`);

        await expect(manager.promptClangdConfigGeneration(folder, 'automatic', true)).resolves.toBe(false);
        await expect(manager.promptClangdConfigGeneration(folder, 'automatic', true)).resolves.toBe(false);
        await expect(manager.promptClangdConfigGeneration(folder, 'userRequested', true)).resolves.toBe(true);

        expect(window.showInformationMessage).toHaveBeenCalledTimes(2);
        expect(window.showInformationMessage).toHaveBeenNthCalledWith(1, expect.stringContaining('project-owned'), `Generate ${clangdFileName}`, 'Not now');
        expect(values.has(stateKey)).toBe(false);
    });

    test('clears stale persisted clangd generation prompt dismissals and does not remember unselected or generated prompts', async () => {
        const values = new Map<string, unknown>();
        const manager = new LanguageSupportPromptManager(createContext(values));
        const legacyStateKey = workspaceStateKey(folder, 'clangdConfigGenerationPromptDismissed');
        const stateKey = workspaceStateKey(folder, 'clangdConfigGenerationPromptDismissed.v2');
        values.set(legacyStateKey, true);
        window.showInformationMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(`Generate ${clangdFileName}`).mockResolvedValueOnce(`Generate ${clangdFileName}`);

        await expect(manager.promptClangdConfigGeneration(folder, 'automatic', true)).resolves.toBe(false);
        await expect(manager.promptClangdConfigGeneration(folder, 'automatic', true)).resolves.toBe(false);
        await expect(manager.promptClangdConfigGeneration(folder, 'automatic', true)).resolves.toBe(true);
        await expect(manager.promptClangdConfigGeneration(folder, 'automatic', true)).resolves.toBe(true);

        expect(window.showInformationMessage).toHaveBeenCalledTimes(4);
        expect(values.has(legacyStateKey)).toBe(false);
        expect(values.has(stateKey)).toBe(false);
    });

    test('picks workspace for clangd generation', async () => {
        const manager = new LanguageSupportPromptManager(createContext());
        const otherFolder = {
            name: 'other',
            uri: vscode.Uri.file('/other'),
            index: 1
        } satisfies vscode.WorkspaceFolder;
        workspace.workspaceFolders = [folder, otherFolder];
        window.showQuickPick.mockResolvedValue({ workspaceFolder: otherFolder });

        await expect(manager.pickWorkspaceForClangdGeneration()).resolves.toBe(otherFolder);

        expect(window.showQuickPick).toHaveBeenCalledWith(
            [
                { label: folder.name, description: folder.uri.fsPath, workspaceFolder: folder },
                { label: otherFolder.name, description: otherFolder.uri.fsPath, workspaceFolder: otherFolder }
            ],
            expect.objectContaining({ placeHolder: 'Select the workspace for .clangd generation' })
        );
    });

    test('reports missing workspace before clangd generation', async () => {
        const manager = new LanguageSupportPromptManager(createContext());

        await expect(manager.pickWorkspaceForClangdGeneration()).resolves.toBeUndefined();

        expect(window.showInformationMessage).toHaveBeenCalledWith('Open a workspace before generating .clangd.');
    });

    test('handles existing clangd generate and open actions', async () => {
        const manager = new LanguageSupportPromptManager(createContext());
        const generatedExamplePath = '/workspace/.clangd.nsight.example';
        const existingDocument = { uri: vscode.Uri.file(`/workspace/${clangdFileName}`) };
        const exampleDocument = { uri: vscode.Uri.file(generatedExamplePath) };
        const generateExample = jest.fn(async () => ({ kind: 'generated' as const, examplePath: generatedExamplePath }));
        workspace.openTextDocument.mockResolvedValueOnce(exampleDocument).mockResolvedValueOnce(existingDocument);
        window.showInformationMessage.mockResolvedValueOnce('Generate example').mockResolvedValueOnce(`Open ${clangdExampleFileName}`).mockResolvedValueOnce(`Open ${clangdFileName}`);

        await manager.handleExistingClangdForGenerateCommand(folder, generateExample);
        await manager.handleExistingClangdForGenerateCommand(folder, generateExample);

        expect(generateExample).toHaveBeenCalledTimes(1);
        expect(workspace.openTextDocument).toHaveBeenNthCalledWith(1, expect.objectContaining({ fsPath: generatedExamplePath }));
        expect(workspace.openTextDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({ fsPath: `/workspace/${clangdFileName}` }));
        expect(window.showTextDocument).toHaveBeenNthCalledWith(1, exampleDocument);
        expect(window.showTextDocument).toHaveBeenNthCalledWith(2, existingDocument);
    });

    test('opens an existing clangd example without reporting it as generated', async () => {
        const manager = new LanguageSupportPromptManager(createContext());
        const existingExamplePath = '/workspace/.clangd.nsight.example';
        const exampleDocument = { uri: vscode.Uri.file(existingExamplePath) };
        const generateExample = jest.fn(async () => ({ kind: 'existingFile' as const, examplePath: existingExamplePath }));
        workspace.openTextDocument.mockResolvedValue(exampleDocument);
        window.showInformationMessage.mockResolvedValueOnce('Generate example').mockResolvedValueOnce(`Open ${clangdExampleFileName}`);

        await manager.handleExistingClangdForGenerateCommand(folder, generateExample);

        expect(window.showInformationMessage).toHaveBeenNthCalledWith(2, expect.stringContaining('left it unchanged'), `Open ${clangdExampleFileName}`);
        expect(workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: existingExamplePath }));
        expect(window.showTextDocument).toHaveBeenCalledWith(exampleDocument);
    });

    test('resets only stale provider and install dismissals after provider extension state changes', async () => {
        const values = new Map<string, unknown>();
        const manager = new LanguageSupportPromptManager(createContext(values));
        const providerPromptKey = workspaceStateKey(folder, 'providerPromptDismissed');
        const clangdInstallPromptKey = `${workspaceStateKey(folder, 'installPromptDismissed')}.clangd`;
        const cpptoolsInstallPromptKey = `${workspaceStateKey(folder, 'installPromptDismissed')}.cpptools`;
        const fallbackPromptKey = workspaceStateKey(folder, 'fallbackClangdPromptDismissed.v2');

        values.set(providerPromptKey, true);
        values.set(clangdInstallPromptKey, true);
        values.set(cpptoolsInstallPromptKey, true);
        values.set(fallbackPromptKey, true);

        await manager.resetDismissalsForProviderChange(folder, installedProviders(['cpptools']), installedProviders(['clangd', 'cpptools']));

        expect(values.has(providerPromptKey)).toBe(false);
        expect(values.has(clangdInstallPromptKey)).toBe(false);
        expect(values.get(cpptoolsInstallPromptKey)).toBe(true);
        expect(values.get(fallbackPromptKey)).toBe(true);
    });
});
