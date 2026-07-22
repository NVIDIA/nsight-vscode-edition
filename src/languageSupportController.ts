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

import * as vscode from 'vscode';
import { type LanguageSupportConfigurationTrigger, languageSupportAutoConfigureConfiguration, languageSupportConfigurationSection, languageSupportProviderConfiguration, workspaceStateKey } from './languageSupport/constants';
import { getInstalledLanguageProviders, LanguageSupportPromptManager } from './languageSupport/promptManager';
import { installedLanguageProvidersEqual, type InstalledLanguageProviders, type LanguageProvider } from './languageSupport/providers';
import { WorkspaceConfigurator } from './languageSupport/workspaceConfigurator';

const configureLanguageSupportCommand = 'cuda.configureLanguageSupport';
const generateClangdConfigCommand = 'cuda.generateClangdConfig';
const cudaFileExcludePattern = '**/{.git,node_modules,out,dist,build}/**';
const languageSupportLogPrefix = 'CUDA C++ language support';

type LanguageSupportPrompts = Pick<LanguageSupportPromptManager, 'pickWorkspaceForClangdGeneration' | 'resetDismissalsForProviderChange' | 'showOnce'>;

type LanguageSupportWorkspaceConfigurator = Pick<WorkspaceConfigurator, 'configureLanguageSupport' | 'generateClangdConfigForWorkspace'>;

async function isCudaWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    try {
        const [cuFiles, cuhFiles] = await Promise.all([
            vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, '**/*.cu'), cudaFileExcludePattern, 1),
            vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, '**/*.cuh'), cudaFileExcludePattern, 1)
        ]);
        return cuFiles.length > 0 || cuhFiles.length > 0;
    } catch {
        return false;
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class LanguageSupportController {
    private readonly promptManager: LanguageSupportPrompts;

    private readonly workspaceConfigurator: LanguageSupportWorkspaceConfigurator;

    private readonly outputChannel: vscode.OutputChannel;

    private activeConfigurationRequest: Promise<void> | undefined;

    private activeConfigurationTrigger: LanguageSupportConfigurationTrigger | undefined;

    private pendingUserRequestedConfiguration = false;

    public constructor(promptManager: LanguageSupportPrompts, workspaceConfigurator: LanguageSupportWorkspaceConfigurator, outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.promptManager = promptManager;
        this.workspaceConfigurator = workspaceConfigurator;
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] ${languageSupportLogPrefix}: ${message}`);
    }

    public requestCudaConfiguration(trigger: LanguageSupportConfigurationTrigger): Promise<void> {
        if (this.activeConfigurationRequest) {
            if (trigger === 'userRequested' && this.activeConfigurationTrigger === 'automatic') {
                this.pendingUserRequestedConfiguration = true;
                this.log('queued userRequested request after active automatic request');
            } else {
                this.log(`coalescing ${trigger} request with active request`);
            }
            return this.activeConfigurationRequest;
        }

        this.activeConfigurationRequest = this.runConfigurationRequests(trigger).finally(() => {
            this.activeConfigurationRequest = undefined;
            this.activeConfigurationTrigger = undefined;
            this.pendingUserRequestedConfiguration = false;
        });
        return this.activeConfigurationRequest;
    }

    private async runConfigurationRequests(initialTrigger: LanguageSupportConfigurationTrigger): Promise<void> {
        let trigger: LanguageSupportConfigurationTrigger | undefined = initialTrigger;

        while (trigger) {
            this.activeConfigurationTrigger = trigger;
            this.log(`starting ${trigger} request`);
            await this.configureCudaWorkspaces(trigger);
            this.log(`finished ${trigger} request`);

            if (trigger === 'automatic' && this.pendingUserRequestedConfiguration) {
                this.pendingUserRequestedConfiguration = false;
                trigger = 'userRequested';
            } else {
                trigger = undefined;
            }
        }
    }

    public async generateClangdConfig(): Promise<void> {
        let workspaceFolder: vscode.WorkspaceFolder | undefined;

        try {
            workspaceFolder = await this.promptManager.pickWorkspaceForClangdGeneration();

            if (!workspaceFolder) {
                return;
            }

            await this.workspaceConfigurator.generateClangdConfigForWorkspace(workspaceFolder);
        } catch (error) {
            await this.reportGenerateClangdError(workspaceFolder, error);
        }
    }

    public async resetProviderDismissals(previous: InstalledLanguageProviders, current: InstalledLanguageProviders): Promise<void> {
        for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
            await this.promptManager.resetDismissalsForProviderChange(workspaceFolder, previous, current);
        }
    }

    private async configureCudaWorkspaces(trigger: LanguageSupportConfigurationTrigger): Promise<void> {
        const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file' || folder.uri.scheme === 'vscode-remote');
        this.log(`${trigger}: inspecting ${workspaceFolders.length} supported workspace folder(s)`);
        let foundCudaWorkspace = false;

        for (const workspaceFolder of workspaceFolders) {
            const hasCudaFiles = await isCudaWorkspace(workspaceFolder);
            this.log(`${trigger}: ${workspaceFolder.name}: CUDA files ${hasCudaFiles ? 'detected' : 'not detected'}`);

            if (hasCudaFiles) {
                foundCudaWorkspace = true;

                try {
                    await this.workspaceConfigurator.configureLanguageSupport(workspaceFolder, trigger);
                } catch (error) {
                    await this.reportSetupError(workspaceFolder, error, trigger);
                }
            }
        }

        if (!foundCudaWorkspace) {
            this.log(`${trigger}: no CUDA C++ workspace detected`);
        }

        if (trigger === 'userRequested' && !foundCudaWorkspace) {
            await vscode.window.showInformationMessage('Nsight did not find .cu or .cuh files in supported workspace folders.');
        }
    }

    private async reportSetupError(workspaceFolder: vscode.WorkspaceFolder, error: unknown, trigger: LanguageSupportConfigurationTrigger): Promise<void> {
        const message = getErrorMessage(error);
        const notification = `Nsight could not configure CUDA C++ language support for ${workspaceFolder.name}: ${message}`;
        this.outputChannel.appendLine(`[${new Date().toISOString()}] ${workspaceFolder.name}: ${message}`);

        // Surface the warning every time on a user-requested run; otherwise only once per workspace.
        if (trigger === 'userRequested') {
            await vscode.window.showWarningMessage(notification);
            return;
        }

        await this.promptManager.showOnce(workspaceStateKey(workspaceFolder, 'setupErrorShown'), notification, 'warning');
    }

    private async reportGenerateClangdError(workspaceFolder: vscode.WorkspaceFolder | undefined, error: unknown): Promise<void> {
        const message = getErrorMessage(error);
        const workspaceContext = workspaceFolder ? ` for ${workspaceFolder.name}` : '';
        const logContext = workspaceFolder?.name ?? 'CUDA: Generate .clangd';
        this.outputChannel.appendLine(`[${new Date().toISOString()}] ${logContext}: ${message}`);
        await vscode.window.showWarningMessage(`Nsight could not complete .clangd generation${workspaceContext}: ${message}. Check that the workspace is writable and CUDA Toolkit paths are accessible, then run CUDA: Generate .clangd again.`);
    }
}

type AffectedProviderFolder = { key: string; currentProvider: string | undefined };

// Decides whether a provider-configuration change is fully explained by the extension's own
// preference writes, in which case the automatic re-run is suppressed. Always clears every
// matched recorded write, even on a value mismatch or when another folder is unexplained, so
// a stale entry can never later swallow a genuine user edit.
export function consumeRecordedProviderWrites(recordedWrites: Map<string, LanguageProvider>, affected: readonly AffectedProviderFolder[]): boolean {
    let consumedAny = false;
    let sawUnexplainedChange = false;

    for (const { key, currentProvider } of affected) {
        const savedProvider = recordedWrites.get(key);
        if (!savedProvider) {
            sawUnexplainedChange = true;
            continue;
        }

        recordedWrites.delete(key);

        if (currentProvider === savedProvider) {
            consumedAny = true;
        } else {
            sawUnexplainedChange = true;
        }
    }

    return consumedAny && !sawUnexplainedChange;
}

export function activateLanguageSupport(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): void {
    const providerPreferenceWrites = new Map<string, LanguageProvider>();
    const promptManager = new LanguageSupportPromptManager(context, outputChannel, (workspaceFolder, provider) => {
        providerPreferenceWrites.set(workspaceFolder.uri.toString(), provider);
    });
    const workspaceConfigurator = new WorkspaceConfigurator(context, promptManager, outputChannel);
    const controller = new LanguageSupportController(promptManager, workspaceConfigurator, outputChannel);
    let previousInstalledProviders = getInstalledLanguageProviders();

    const consumeProviderPreferenceWrite = (event: vscode.ConfigurationChangeEvent): boolean => {
        const affected = (vscode.workspace.workspaceFolders ?? [])
            .filter((workspaceFolder) => event.affectsConfiguration(languageSupportProviderConfiguration, workspaceFolder.uri))
            .map((workspaceFolder) => ({
                key: workspaceFolder.uri.toString(),
                currentProvider: vscode.workspace.getConfiguration(languageSupportConfigurationSection, workspaceFolder.uri).get<string>('provider')
            }));

        return consumeRecordedProviderWrites(providerPreferenceWrites, affected);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(configureLanguageSupportCommand, () => controller.requestCudaConfiguration('userRequested')),
        vscode.commands.registerCommand(generateClangdConfigCommand, () => controller.generateClangdConfig()),
        vscode.extensions.onDidChange(async () => {
            const currentInstalledProviders = getInstalledLanguageProviders();
            if (installedLanguageProvidersEqual(previousInstalledProviders, currentInstalledProviders)) return;
            const previousProviders = previousInstalledProviders;
            previousInstalledProviders = currentInstalledProviders;
            await controller.resetProviderDismissals(previousProviders, currentInstalledProviders);
            void controller.requestCudaConfiguration('automatic');
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void controller.requestCudaConfiguration('automatic');
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(languageSupportProviderConfiguration) && consumeProviderPreferenceWrite(event)) {
                return;
            }

            if (event.affectsConfiguration(languageSupportAutoConfigureConfiguration) || event.affectsConfiguration(languageSupportProviderConfiguration)) {
                void controller.requestCudaConfiguration('automatic');
            }
        })
    );

    void controller.requestCudaConfiguration('automatic');
}
