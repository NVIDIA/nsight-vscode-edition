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

import * as fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { type LanguageSupportConfigurationTrigger, languageSupportConfigurationSection, workspaceStateKey } from './constants';
import { resolveCudaEnvironment } from './cudaEnvironment';
import {
    clangdExampleFileName,
    clangdNoCompilationDatabaseValue,
    clangdFileName,
    generateClangdConfigContents,
    getClangdCompilationDatabaseValue,
    getClangdExamplePath,
    hasClangdConfig,
    setupClangd,
    type ClangdExampleGenerationResult,
    type ClangdSetupOptions
} from './clangdSetup';
import { setupCpptools } from './cpptoolsSetup';
import { getInstalledLanguageProviders, LanguageSupportPromptManager, type ProviderSetupPolicy } from './promptManager';
import { normalizeLanguageProviderPreference } from './providerSelection';
import { type LanguageProvider } from './providers';

type ProviderSetup = (workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger, setupPolicy: ProviderSetupPolicy) => Promise<void>;

type WorkspaceConfigurationPrompts = Pick<LanguageSupportPromptManager, 'handleExistingClangdForGenerateCommand' | 'promptClangdConfigGeneration' | 'selectProvider' | 'showOnce'>;

type CompileCommandsDiscovery = {
    path?: string;
    usablePath?: string;
    problem?: string;
};

function formatPathForLog(filePath: string | undefined): string {
    return filePath ?? 'none';
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class WorkspaceConfigurator {
    private readonly context: vscode.ExtensionContext;

    private readonly promptManager: WorkspaceConfigurationPrompts;

    private readonly outputChannel: vscode.OutputChannel;

    private readonly providerSetups = {
        clangd: (workspaceFolder, trigger, setupPolicy) => this.setupClangdProvider(workspaceFolder, trigger, setupPolicy),
        cpptools: (workspaceFolder, trigger, setupPolicy) => this.setupCpptoolsProvider(workspaceFolder, trigger, setupPolicy)
    } satisfies Record<LanguageProvider, ProviderSetup>;

    public constructor(context: vscode.ExtensionContext, promptManager: WorkspaceConfigurationPrompts, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.promptManager = promptManager;
        this.outputChannel = outputChannel;
    }

    private logSetupFailure(workspaceFolder: vscode.WorkspaceFolder, message: string): void {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] ${workspaceFolder.name}: ${message}`);
    }

    private logTrace(workspaceFolder: vscode.WorkspaceFolder, message: string): void {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] CUDA C++ language support: ${workspaceFolder.name}: ${message}`);
    }

    public async configureLanguageSupport(workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger): Promise<void> {
        if (trigger === 'automatic' && (await this.canUseExistingClangd(workspaceFolder))) {
            this.logTrace(workspaceFolder, `${trigger}: existing ${clangdFileName} with clangd installed; skipping provider selection`);
            return;
        }

        this.logTrace(workspaceFolder, `${trigger}: selecting provider`);
        const selection = await this.promptManager.selectProvider(workspaceFolder, trigger);

        if (!selection) {
            this.logTrace(workspaceFolder, `${trigger}: no provider selected`);
            return;
        }

        this.logTrace(workspaceFolder, `${trigger}: selected ${selection.provider} (source=${selection.source})`);
        await this.providerSetups[selection.provider](workspaceFolder, trigger, selection.setupPolicy);
    }

    private async canUseExistingClangd(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
        const configuration = vscode.workspace.getConfiguration(languageSupportConfigurationSection, workspaceFolder.uri);
        const providerPreference = normalizeLanguageProviderPreference(configuration.get<string>('provider', 'auto'));

        return providerPreference === 'auto' && getInstalledLanguageProviders().clangd && (await hasClangdConfig(workspaceFolder.uri.fsPath));
    }

    public async generateClangdConfigForWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
        if (await hasClangdConfig(workspaceFolder.uri.fsPath)) {
            await this.promptManager.handleExistingClangdForGenerateCommand(workspaceFolder, () => this.generateClangdExampleFile(workspaceFolder));
            return;
        }

        const compileCommands = await this.findWorkspaceCompileCommands(workspaceFolder);
        await this.reportCompileCommandsProblem(workspaceFolder, compileCommands, 'always');
        const setupOptions = await this.buildClangdSetupOptions(workspaceFolder, compileCommands.usablePath);

        if (!setupOptions) {
            await this.reportMissingCudaToolkit(workspaceFolder, 'always');
            return;
        }

        const setupResult = await setupClangd(setupOptions);

        if (setupResult.kind === 'configured') {
            await vscode.window.showInformationMessage(`Nsight generated ${clangdFileName} in ${workspaceFolder.name}. The file is now project-owned and will not be overwritten automatically.`);
            return;
        }

        await this.promptManager.handleExistingClangdForGenerateCommand(workspaceFolder, () => this.generateClangdExampleFile(workspaceFolder));
    }

    private async findWorkspaceCompileCommands(workspaceFolder: vscode.WorkspaceFolder): Promise<CompileCommandsDiscovery> {
        const workspacePath = workspaceFolder.uri.fsPath;
        const cmakeBuildDirectory = vscode.workspace.getConfiguration('cmake', workspaceFolder.uri).get<string>('buildDirectory');
        const candidateDirectories = [workspacePath];

        if (cmakeBuildDirectory) {
            const expanded = cmakeBuildDirectory.replaceAll('${workspaceFolder}', workspacePath);
            candidateDirectories.push(path.isAbsolute(expanded) ? expanded : path.resolve(workspacePath, expanded));
        }

        candidateDirectories.push(path.join(workspacePath, 'build'));

        for (const directoryPath of candidateDirectories) {
            const filePath = path.join(directoryPath, 'compile_commands.json');
            try {
                if ((await fs.stat(filePath)).isFile()) {
                    return await this.inspectCompileCommandsFile(filePath);
                }
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                // A missing or unreadable candidate is non-fatal: skip it and keep searching.
                // EACCES/EPERM/ELOOP cover locked-down or symlink-looped out-of-source build
                // directories the user cannot traverse, which should not abort configuration.
                if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') {
                    continue;
                }

                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Unable to inspect ${filePath} while searching for compile_commands.json: ${message}`);
            }
        }

        return {};
    }

    private async inspectCompileCommandsFile(filePath: string): Promise<CompileCommandsDiscovery> {
        try {
            const contents = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(contents) as unknown;

            if (!Array.isArray(parsed)) {
                return { path: filePath, problem: 'file is not a JSON array' };
            }

            return { path: filePath, usablePath: filePath };
        } catch (error) {
            return { path: filePath, problem: getErrorMessage(error) };
        }
    }

    private async reportCompileCommandsProblem(workspaceFolder: vscode.WorkspaceFolder, compileCommands: CompileCommandsDiscovery, frequency: 'always' | 'once' | 'logOnly'): Promise<void> {
        if (!compileCommands.problem) {
            return;
        }

        this.logSetupFailure(workspaceFolder, `Nsight found compile_commands.json at ${compileCommands.path}, but could not read or parse it: ${compileCommands.problem}`);

        if (frequency === 'logOnly') {
            return;
        }

        const message = `Nsight found compile_commands.json in ${workspaceFolder.name}, but could not read or parse it. CUDA C++ language-support configuration may be incomplete; see the Nsight output for details.`;

        if (frequency === 'always') {
            await vscode.window.showWarningMessage(message);
            return;
        }

        await this.promptManager.showOnce(workspaceStateKey(workspaceFolder, 'compileCommandsReadWarningShown'), message, 'warning');
    }

    private async setupClangdProvider(workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger, setupPolicy: ProviderSetupPolicy): Promise<void> {
        if (await hasClangdConfig(workspaceFolder.uri.fsPath)) {
            this.logTrace(workspaceFolder, `${trigger}: existing ${clangdFileName}; skipping generation`);
            await this.promptManager.showOnce(
                workspaceStateKey(workspaceFolder, 'existingClangdInfoShown'),
                `Nsight found an existing ${clangdFileName} in ${workspaceFolder.name} and left it unchanged. Run CUDA: Generate .clangd to create ${clangdExampleFileName} for comparison.`,
                'info'
            );
            return;
        }

        const compileCommands = await this.findWorkspaceCompileCommands(workspaceFolder);
        this.logTrace(workspaceFolder, `${trigger}: clangd compile_commands=${formatPathForLog(compileCommands.path)}`);
        await this.reportCompileCommandsProblem(workspaceFolder, compileCommands, this.getCompileCommandsProblemNotificationFrequency(trigger, setupPolicy));
        const setupOptions = await this.buildClangdSetupOptions(workspaceFolder, compileCommands.usablePath);

        if (!setupOptions) {
            this.logTrace(workspaceFolder, `${trigger}: clangd CUDA Toolkit resolution failed`);
            await this.reportMissingCudaToolkit(workspaceFolder, trigger === 'userRequested' ? 'always' : 'once');
            return;
        }

        if (!compileCommands.usablePath && !setupPolicy.allowFallbackProjectFilePrompt) {
            this.logTrace(workspaceFolder, `${trigger}: no compile_commands.json; skipping automatic clangd fallback generation prompt`);
            return;
        }

        const promptBeforeGeneration = !compileCommands.usablePath || !setupPolicy.allowProjectFileWritesWithoutPrompt;

        if (promptBeforeGeneration) {
            this.logTrace(workspaceFolder, `${trigger}: prompting before clangd generation (hasCompileCommands=${compileCommands.usablePath !== undefined})`);
        }

        if (promptBeforeGeneration && !(await this.promptManager.promptClangdConfigGeneration(workspaceFolder, trigger, compileCommands.usablePath !== undefined))) {
            this.logTrace(workspaceFolder, `${trigger}: clangd generation prompt declined or suppressed`);
            return;
        }

        const setupResult = await setupClangd(setupOptions);
        this.logTrace(workspaceFolder, `${trigger}: clangd setup result=${setupResult.kind}`);

        if (setupResult.kind === 'existingFile') {
            await this.promptManager.showOnce(
                workspaceStateKey(workspaceFolder, 'existingClangdInfoShown'),
                `Nsight found an existing ${clangdFileName} in ${workspaceFolder.name} and left it unchanged. Run CUDA: Generate .clangd to create ${clangdExampleFileName} for comparison.`,
                'info'
            );
        }
    }

    private async setupCpptoolsProvider(workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger, setupPolicy: ProviderSetupPolicy): Promise<void> {
        if (!setupPolicy.allowWorkspaceSettingsWrites) {
            this.logTrace(workspaceFolder, `${trigger}: cpptools selected without workspace-settings write consent; skipping settings writes`);
            return;
        }

        const compileCommands = await this.findWorkspaceCompileCommands(workspaceFolder);
        this.logTrace(workspaceFolder, `cpptools compile_commands=${formatPathForLog(compileCommands.path)}`);
        await this.reportCompileCommandsProblem(workspaceFolder, compileCommands, this.getCompileCommandsProblemNotificationFrequency(trigger, setupPolicy));

        if (compileCommands.usablePath) {
            await this.setupOptionalCpptoolsSettings(workspaceFolder, trigger, { compileCommandsPath: compileCommands.usablePath });
            return;
        }

        if (compileCommands.problem) {
            this.logTrace(workspaceFolder, `${trigger}: cpptools setup skipped because compile_commands.json is not usable`);
            return;
        }

        const message = 'Nsight could not find a usable compile_commands.json for Microsoft C/C++ CUDA language support.';
        this.logSetupFailure(workspaceFolder, message);
        await this.promptManager.showOnce(workspaceStateKey(workspaceFolder, 'noCpptoolsInputsWarningShown'), message, 'warning');
    }

    private async setupOptionalCpptoolsSettings(workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger, options: Parameters<typeof setupCpptools>[1]): Promise<void> {
        const result = await setupCpptools(workspaceFolder, options);

        if (result.failedSettings.length > 0) {
            this.logTrace(workspaceFolder, `cpptools optional settings were not saved: ${result.failedSettings.join('; ')}`);

            if (trigger === 'userRequested') {
                await vscode.window.showWarningMessage(
                    `Nsight is using the Microsoft C/C++ extension for CUDA C++ support in ${workspaceFolder.name}, but could not save optional workspace settings. Existing C/C++ settings were not changed; see the Nsight output for details.`
                );
            }

            return;
        }

        this.logTrace(workspaceFolder, 'cpptools saved optional settings if needed');
    }

    private getCompileCommandsProblemNotificationFrequency(trigger: LanguageSupportConfigurationTrigger, setupPolicy: ProviderSetupPolicy): 'always' | 'once' | 'logOnly' {
        if (trigger === 'userRequested') {
            return 'always';
        }

        return setupPolicy.notifyAutomaticSetupProblems ? 'once' : 'logOnly';
    }

    private async reportMissingCudaToolkit(workspaceFolder: vscode.WorkspaceFolder, frequency: 'always' | 'once'): Promise<void> {
        const message = 'Nsight could not find a complete CUDA Toolkit installation for clangd CUDA C++ language support.';
        this.logSetupFailure(workspaceFolder, message);

        if (frequency === 'always') {
            await vscode.window.showWarningMessage(message);
            return;
        }

        await this.promptManager.showOnce(workspaceStateKey(workspaceFolder, 'noCudaToolkitWarningShown'), message, 'warning');
    }

    private async buildClangdSetupOptions(workspaceFolder: vscode.WorkspaceFolder, compileCommands: string | undefined): Promise<ClangdSetupOptions | undefined> {
        const configuration = vscode.workspace.getConfiguration(languageSupportConfigurationSection, workspaceFolder.uri);
        const configuredCudaGpuArch = configuration.get<string>('gpuArch') || undefined;
        const cudaEnvironment = await resolveCudaEnvironment(compileCommands, configuredCudaGpuArch);

        if (!cudaEnvironment) {
            return undefined;
        }

        return {
            extensionPath: this.context.extensionPath,
            workspacePath: workspaceFolder.uri.fsPath,
            compilationDatabaseValue: compileCommands ? getClangdCompilationDatabaseValue(workspaceFolder.uri.fsPath, path.dirname(compileCommands)) : clangdNoCompilationDatabaseValue,
            cudaEnvironment
        };
    }

    private async generateClangdExampleFile(workspaceFolder: vscode.WorkspaceFolder): Promise<ClangdExampleGenerationResult | undefined> {
        const examplePath = getClangdExamplePath(workspaceFolder.uri.fsPath);

        if (await this.hasExistingClangdExampleFile(examplePath)) {
            return { kind: 'existingFile', examplePath };
        }

        const compileCommands = await this.findWorkspaceCompileCommands(workspaceFolder);
        await this.reportCompileCommandsProblem(workspaceFolder, compileCommands, 'always');
        const setupOptions = await this.buildClangdSetupOptions(workspaceFolder, compileCommands.usablePath);

        if (!setupOptions) {
            await this.reportMissingCudaToolkit(workspaceFolder, 'always');
            return undefined;
        }

        const contents = await generateClangdConfigContents(setupOptions);

        try {
            await fs.writeFile(examplePath, contents, { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') {
                return { kind: 'existingFile', examplePath };
            }

            throw new Error(`Unable to write generated ${clangdExampleFileName} to ${examplePath}: ${getErrorMessage(error)}`);
        }

        return { kind: 'generated', examplePath };
    }

    private async hasExistingClangdExampleFile(examplePath: string): Promise<boolean> {
        try {
            await fs.access(examplePath);
            return true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                return false;
            }

            throw new Error(`Unable to inspect existing ${clangdExampleFileName} at ${examplePath}: ${getErrorMessage(error)}`);
        }
    }
}
