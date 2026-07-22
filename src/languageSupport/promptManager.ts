/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2026, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

import path from 'node:path';
import * as vscode from 'vscode';
import { clangdExampleFileName, clangdFileName, type ClangdExampleGenerationResult } from './clangdSetup';
import { type LanguageSupportConfigurationTrigger, languageSupportConfigurationSection, workspaceStateKey } from './constants';
import { selectLanguageProvider } from './providerSelection';
import { type InstalledLanguageProviders, type LanguageProvider, languageProviderIds, languageProviderRegistry } from './providers';

const installExtensionCommand = 'workbench.extensions.installExtension';
const clangdPromptDismissedKeyVersion = 'v2';

type ProviderPreferenceSavedListener = (workspaceFolder: vscode.WorkspaceFolder, provider: LanguageProvider) => void;

type ProviderPick = {
    provider: LanguageProvider;
    installIfMissing: boolean;
};

export function getInstalledLanguageProviders(): InstalledLanguageProviders {
    const installedProviders = {} as InstalledLanguageProviders;

    for (const provider of languageProviderIds) {
        installedProviders[provider] = vscode.extensions.getExtension(languageProviderRegistry[provider].extensionId) !== undefined;
    }

    return installedProviders;
}

export type SelectedLanguageProvider = {
    provider: LanguageProvider;
    source: ProviderSelectionSource;
    setupPolicy: ProviderSetupPolicy;
};

export type ProviderSelectionSource = 'automaticInference' | 'workspacePreference' | 'userPrompt' | 'installPrompt';

export type ProviderSetupPolicy = {
    allowWorkspaceSettingsWrites: boolean;
    allowProjectFileWritesWithoutPrompt: boolean;
    allowFallbackProjectFilePrompt: boolean;
    notifyAutomaticSetupProblems: boolean;
};

// Single source of truth for the per-provider install-dismissal key. The reset path
// (dismissalKeysToReset) and the write path (promptInstallProvider) must agree on this format.
function installPromptDismissedKey(folder: vscode.WorkspaceFolder, provider: LanguageProvider): string {
    return `${workspaceStateKey(folder, 'installPromptDismissed')}.${provider}`;
}

function providerPreferenceSaveWarningShownKey(folder: vscode.WorkspaceFolder, provider: LanguageProvider): string {
    return `${workspaceStateKey(folder, 'providerPreferenceSaveWarningShown')}.${provider}`;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function clangdGenerationPromptDismissedKey(folder: vscode.WorkspaceFolder, hasCompileCommands: boolean): string {
    const promptKind = hasCompileCommands ? 'clangdConfigGenerationPromptDismissed' : 'fallbackClangdPromptDismissed';
    return workspaceStateKey(folder, `${promptKind}.${clangdPromptDismissedKeyVersion}`);
}

function staleClangdPromptDismissalKeys(folder: vscode.WorkspaceFolder, hasCompileCommands: boolean): string[] {
    const promptKind = hasCompileCommands ? 'clangdConfigGenerationPromptDismissed' : 'fallbackClangdPromptDismissed';
    return [workspaceStateKey(folder, promptKind), workspaceStateKey(folder, `${promptKind}.${clangdPromptDismissedKeyVersion}`)];
}

function dismissalKeysToReset(folder: vscode.WorkspaceFolder, previous: InstalledLanguageProviders, current: InstalledLanguageProviders): string[] {
    const changedProviders = languageProviderIds.filter((provider) => previous[provider] !== current[provider]);

    if (changedProviders.length === 0) {
        return [];
    }

    return [workspaceStateKey(folder, 'providerPromptDismissed'), ...changedProviders.map((provider) => installPromptDismissedKey(folder, provider))];
}

function isLanguageProviderPreference(value: unknown): value is LanguageProvider {
    return typeof value === 'string' && (languageProviderIds as readonly string[]).includes(value);
}

function getWorkspaceFolderProviderPreference(configuration: vscode.WorkspaceConfiguration): LanguageProvider | undefined {
    const inspected = configuration.inspect<string>('provider');
    const value = inspected?.workspaceFolderValue;

    return isLanguageProviderPreference(value) ? value : undefined;
}

export function setupPolicyForSource(source: ProviderSelectionSource): ProviderSetupPolicy {
    switch (source) {
        case 'workspacePreference':
        case 'userPrompt': {
            return {
                allowWorkspaceSettingsWrites: true,
                allowProjectFileWritesWithoutPrompt: true,
                allowFallbackProjectFilePrompt: true,
                notifyAutomaticSetupProblems: true
            };
        }

        case 'installPrompt': {
            return {
                allowWorkspaceSettingsWrites: true,
                allowProjectFileWritesWithoutPrompt: false,
                allowFallbackProjectFilePrompt: true,
                notifyAutomaticSetupProblems: true
            };
        }

        case 'automaticInference': {
            return {
                allowWorkspaceSettingsWrites: false,
                allowProjectFileWritesWithoutPrompt: false,
                allowFallbackProjectFilePrompt: false,
                notifyAutomaticSetupProblems: false
            };
        }
    }
}

function selectedLanguageProvider(provider: LanguageProvider, source: ProviderSelectionSource): SelectedLanguageProvider {
    return {
        provider,
        source,
        setupPolicy: setupPolicyForSource(source)
    };
}

export class LanguageSupportPromptManager {
    private readonly context: vscode.ExtensionContext;
    private readonly outputChannel: vscode.OutputChannel | undefined;
    private readonly clangdGenerationPromptDismissedKeys = new Set<string>();
    private readonly providerPreferenceSaveWarningKeys = new Set<string>();
    private readonly onProviderPreferenceSaved: ProviderPreferenceSavedListener | undefined;

    public constructor(context: vscode.ExtensionContext, outputChannel?: vscode.OutputChannel, onProviderPreferenceSaved?: ProviderPreferenceSavedListener) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.onProviderPreferenceSaved = onProviderPreferenceSaved;
    }

    private logTrace(workspaceFolder: vscode.WorkspaceFolder, message: string): void {
        this.outputChannel?.appendLine(`[${new Date().toISOString()}] CUDA C++ language support: ${workspaceFolder.name}: ${message}`);
    }

    private async clearStaleClangdPromptState(workspaceFolder: vscode.WorkspaceFolder, hasCompileCommands: boolean): Promise<void> {
        for (const stateKey of staleClangdPromptDismissalKeys(workspaceFolder, hasCompileCommands)) {
            try {
                if (this.context.workspaceState.get<boolean>(stateKey, false)) {
                    this.logTrace(workspaceFolder, `clearing stale persisted clangd generation prompt dismissal (${stateKey})`);
                    await this.context.workspaceState.update(stateKey, undefined);
                }
            } catch {
                // Stale prompt dismissal cleanup is best-effort; prompting should continue.
            }
        }
    }

    private async saveProviderPreference(workspaceFolder: vscode.WorkspaceFolder, provider: LanguageProvider): Promise<void> {
        await vscode.workspace.getConfiguration(languageSupportConfigurationSection, workspaceFolder.uri).update('provider', provider, vscode.ConfigurationTarget.WorkspaceFolder);
        this.onProviderPreferenceSaved?.(workspaceFolder, provider);
    }

    private async trySaveProviderPreference(workspaceFolder: vscode.WorkspaceFolder, provider: LanguageProvider, trigger: LanguageSupportConfigurationTrigger): Promise<void> {
        try {
            await this.saveProviderPreference(workspaceFolder, provider);
        } catch (error) {
            await this.showProviderPreferenceSaveWarning(workspaceFolder, provider, trigger, error);
        }
    }

    private async showProviderPreferenceSaveWarning(workspaceFolder: vscode.WorkspaceFolder, provider: LanguageProvider, trigger: LanguageSupportConfigurationTrigger, error: unknown): Promise<void> {
        this.logTrace(workspaceFolder, `${trigger}: could not save nsight.cuda.languageSupport.provider=${provider}: ${getErrorMessage(error)}`);
        const message = `Nsight will use ${languageProviderRegistry[provider].label} for this run, but could not save the provider preference for ${workspaceFolder.name}. You may be prompted again; see the Nsight output for details.`;

        if (trigger === 'automatic') {
            const stateKey = providerPreferenceSaveWarningShownKey(workspaceFolder, provider);

            if (this.providerPreferenceSaveWarningKeys.has(stateKey)) {
                return;
            }

            try {
                if (this.context.workspaceState.get<boolean>(stateKey, false)) {
                    this.providerPreferenceSaveWarningKeys.add(stateKey);
                    return;
                }
            } catch {
                // Warning throttling is best-effort; provider selection must continue.
            }

            this.providerPreferenceSaveWarningKeys.add(stateKey);

            try {
                await this.context.workspaceState.update(stateKey, true);
            } catch {
                // Warning throttling is best-effort; provider selection must continue.
            }
        }

        try {
            void vscode.window.showWarningMessage(message).then(undefined, () => {});
        } catch {
            // Warning display is best-effort; provider selection must continue.
        }
    }

    public async selectProvider(workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger): Promise<SelectedLanguageProvider | undefined> {
        const configuration = vscode.workspace.getConfiguration(languageSupportConfigurationSection, workspaceFolder.uri);

        if (trigger !== 'userRequested' && !configuration.get<boolean>('autoConfigure', true)) {
            this.logTrace(workspaceFolder, `${trigger}: autoConfigure disabled`);
            return undefined;
        }

        if (trigger === 'userRequested') {
            const providerPick = await this.promptForProvider(workspaceFolder, trigger);
            return providerPick ? await this.useProviderOrInstallFromPicker(workspaceFolder, providerPick, trigger, 'userPrompt') : undefined;
        }

        const preference = configuration.get<string>('provider', 'auto');
        const installedProviders = getInstalledLanguageProviders();
        const decision = selectLanguageProvider({
            preference,
            installedProviders,
            isMicrosoftVsCode: vscode.env.uriScheme === 'vscode' || vscode.env.uriScheme === 'vscode-insiders'
        });
        this.logTrace(
            workspaceFolder,
            `${trigger}: provider preference=${preference}, installed clangd=${installedProviders.clangd}, installed cpptools=${installedProviders.cpptools}, decision=${decision.kind}${'provider' in decision ? `:${decision.provider}` : ''}`
        );

        switch (decision.kind) {
            case 'disabled': {
                return undefined;
            }

            case 'use': {
                return selectedLanguageProvider(decision.provider, getWorkspaceFolderProviderPreference(configuration) === decision.provider ? 'workspacePreference' : 'automaticInference');
            }

            case 'install': {
                return await this.promptInstallProvider(workspaceFolder, decision.provider, trigger);
            }
        }
    }

    public async pickWorkspaceForClangdGeneration(): Promise<vscode.WorkspaceFolder | undefined> {
        const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file' || folder.uri.scheme === 'vscode-remote');

        if (workspaceFolders.length === 0) {
            await vscode.window.showInformationMessage('Open a workspace before generating .clangd.');
            return undefined;
        }

        if (workspaceFolders.length === 1) {
            return workspaceFolders[0];
        }

        const selectedItem = await vscode.window.showQuickPick(
            workspaceFolders.map((workspaceFolder) => ({
                label: workspaceFolder.name,
                description: workspaceFolder.uri.fsPath,
                workspaceFolder
            })),
            {
                placeHolder: 'Select the workspace for .clangd generation'
            }
        );

        return selectedItem?.workspaceFolder;
    }

    public async handleExistingClangdForGenerateCommand(workspaceFolder: vscode.WorkspaceFolder, generateExample: () => Promise<ClangdExampleGenerationResult | undefined>): Promise<void> {
        const generateExampleAction = 'Generate example';
        const openExistingAction = `Open ${clangdFileName}`;
        const selection = await vscode.window.showInformationMessage(`${clangdFileName} already exists in ${workspaceFolder.name}. Nsight can generate ${clangdExampleFileName} for comparison.`, generateExampleAction, openExistingAction);

        if (selection === generateExampleAction) {
            const result = await generateExample();

            if (!result) {
                return;
            }

            const openExampleAction = `Open ${clangdExampleFileName}`;
            const message = result.kind === 'generated' ? `Nsight generated ${clangdExampleFileName} in ${workspaceFolder.name}.` : `Nsight found an existing ${clangdExampleFileName} in ${workspaceFolder.name} and left it unchanged.`;
            const postGenerateSelection = await vscode.window.showInformationMessage(message, openExampleAction);

            if (postGenerateSelection === openExampleAction) {
                await openTextDocument(result.examplePath);
            }

            return;
        }

        if (selection === openExistingAction) {
            await openTextDocument(path.join(workspaceFolder.uri.fsPath, clangdFileName));
        }
    }

    public async showOnce(stateKey: string, message: string, kind: 'info' | 'warning'): Promise<void> {
        if (this.context.workspaceState.get<boolean>(stateKey, false)) {
            return;
        }

        await this.context.workspaceState.update(stateKey, true);
        await (kind === 'info' ? vscode.window.showInformationMessage(message) : vscode.window.showWarningMessage(message));
    }

    public async promptClangdConfigGeneration(workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger, hasCompileCommands: boolean): Promise<boolean> {
        const stateKey = clangdGenerationPromptDismissedKey(workspaceFolder, hasCompileCommands);
        await this.clearStaleClangdPromptState(workspaceFolder, hasCompileCommands);

        if (trigger !== 'userRequested' && this.clangdGenerationPromptDismissedKeys.has(stateKey)) {
            this.logTrace(workspaceFolder, `${trigger}: clangd generation prompt previously dismissed in this session (hasCompileCommands=${hasCompileCommands}, keyVersion=${clangdPromptDismissedKeyVersion})`);
            return false;
        }

        const generateAction = `Generate ${clangdFileName}`;
        const notNowAction = 'Not now';
        const message = hasCompileCommands
            ? `Nsight can generate ${clangdFileName} for clangd CUDA C++ editing in ${workspaceFolder.name}. The file is project-owned and Nsight will not overwrite it automatically.`
            : `Nsight can generate a starter ${clangdFileName} for CUDA C++ editing in ${workspaceFolder.name}. Without compile_commands.json it will use generic CUDA flags.`;
        this.logTrace(workspaceFolder, `${trigger}: showing clangd generation prompt (hasCompileCommands=${hasCompileCommands})`);
        const selection = await vscode.window.showInformationMessage(message, generateAction, notNowAction);
        this.logTrace(workspaceFolder, `${trigger}: clangd generation prompt selection=${selection ?? '<dismissed>'}`);

        // Only "Not now" suppresses future automatic prompts. A Generate choice is
        // followed by filesystem work that can fail; a successful write is suppressed
        // naturally by the presence of .clangd.
        if (selection === notNowAction) {
            this.clangdGenerationPromptDismissedKeys.add(stateKey);
        }

        return selection === generateAction;
    }

    public async resetDismissalsForProviderChange(workspaceFolder: vscode.WorkspaceFolder, previous: InstalledLanguageProviders, current: InstalledLanguageProviders): Promise<void> {
        for (const key of dismissalKeysToReset(workspaceFolder, previous, current)) {
            await this.context.workspaceState.update(key, undefined);
        }
    }

    private async promptForProvider(workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger): Promise<ProviderPick | undefined> {
        const installedProviders = getInstalledLanguageProviders();
        const items = languageProviderIds.map((provider) => ({
            label: languageProviderRegistry[provider].label,
            description: installedProviders[provider] ? 'Installed' : 'Not installed',
            detail: languageProviderRegistry[provider].description,
            provider
        }));

        const selectedItem = await vscode.window.showQuickPick(items, {
            title: trigger === 'automatic' ? 'Nsight saves your choice for this workspace.' : undefined,
            placeHolder: `Select CUDA C++ language support for ${workspaceFolder.name}`
        });

        return selectedItem ? { provider: selectedItem.provider, installIfMissing: !installedProviders[selectedItem.provider] } : undefined;
    }

    private async useProviderOrInstallFromPicker(workspaceFolder: vscode.WorkspaceFolder, providerPick: ProviderPick, trigger: LanguageSupportConfigurationTrigger, source: ProviderSelectionSource): Promise<SelectedLanguageProvider | undefined> {
        if (getInstalledLanguageProviders()[providerPick.provider]) {
            await this.trySaveProviderPreference(workspaceFolder, providerPick.provider, trigger);
            return selectedLanguageProvider(providerPick.provider, source);
        }

        if (providerPick.installIfMissing) {
            return await this.installProvider(workspaceFolder, providerPick.provider, trigger, source);
        }

        return undefined;
    }

    private async promptInstallProvider(workspaceFolder: vscode.WorkspaceFolder, provider: LanguageProvider, trigger: LanguageSupportConfigurationTrigger): Promise<SelectedLanguageProvider | undefined> {
        const providerMetadata = languageProviderRegistry[provider];
        const stateKey = installPromptDismissedKey(workspaceFolder, provider);

        if (trigger !== 'userRequested' && this.context.workspaceState.get<boolean>(stateKey, false)) {
            this.logTrace(workspaceFolder, `${trigger}: install prompt for ${provider} previously dismissed`);
            return undefined;
        }

        const installAction = `Install ${providerMetadata.label}`;
        const chooseOtherAction = 'Choose other provider';
        const message =
            trigger === 'userRequested'
                ? `${providerMetadata.label} is not installed in this VS Code environment. Install it to enable CUDA-aware editing support for ${workspaceFolder.name}.`
                : `Nsight detected CUDA C++ files in ${workspaceFolder.name}. Install ${providerMetadata.label} to enable CUDA-aware editing support; Nsight will save this provider for the workspace.`;
        const selection = await vscode.window.showInformationMessage(message, installAction, chooseOtherAction, 'Not now');

        if (selection === chooseOtherAction) {
            const providerPick = await this.promptForProvider(workspaceFolder, trigger);

            if (!providerPick) {
                this.logTrace(workspaceFolder, `${trigger}: choose-other provider prompt cancelled`);
                return undefined;
            }

            return await this.useProviderOrInstallFromPicker(workspaceFolder, providerPick, trigger, 'userPrompt');
        }

        if (selection !== installAction) {
            await this.context.workspaceState.update(stateKey, true);
            this.logTrace(workspaceFolder, `${trigger}: install prompt for ${provider} dismissed`);
            return undefined;
        }

        return await this.installProvider(workspaceFolder, provider, trigger, 'installPrompt');
    }

    private async installProvider(workspaceFolder: vscode.WorkspaceFolder, provider: LanguageProvider, trigger: LanguageSupportConfigurationTrigger, source: ProviderSelectionSource): Promise<SelectedLanguageProvider | undefined> {
        const providerMetadata = languageProviderRegistry[provider];

        try {
            await vscode.commands.executeCommand(installExtensionCommand, providerMetadata.extensionId);
        } catch {
            await vscode.window.showWarningMessage(`Unable to install ${providerMetadata.label}. Install extension '${providerMetadata.extensionId}' and run CUDA: Configure CUDA C++ Language Support.`);
            return undefined;
        }

        await this.trySaveProviderPreference(workspaceFolder, provider, trigger);
        return selectedLanguageProvider(provider, source);
    }
}

async function openTextDocument(filePath: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document);
}
