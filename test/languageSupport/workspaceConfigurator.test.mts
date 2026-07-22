import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import * as vscode from 'vscode';
import { clangdExampleFileName, clangdFileName, type ClangdExampleGenerationResult } from '../../src/languageSupport/clangdSetup.ts';
import { type LanguageSupportConfigurationTrigger, languageSupportConfigurationSection } from '../../src/languageSupport/constants.ts';
import { type CudaEnvironment } from '../../src/languageSupport/cudaEnvironment.ts';
import { type ProviderSelectionSource, type SelectedLanguageProvider, setupPolicyForSource } from '../../src/languageSupport/promptManager.ts';
import { type LanguageProvider, languageProviderRegistry } from '../../src/languageSupport/providers.ts';
import { extensions, getConfigurationValues, resetVscodeMock, setConfiguration, window, workspace } from '../mocks/vscode.mts';

type PromptDecisions = {
    provider: LanguageProvider;
    source?: ProviderSelectionSource;
    generateClangdConfig?: boolean;
};

type ResolveCudaEnvironment = (compileCommandsPath?: string, configuredCudaGpuArch?: string) => Promise<CudaEnvironment | undefined>;
type PromptManagerFake = {
    selectProvider: jest.MockedFunction<(workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger) => Promise<SelectedLanguageProvider>>;
    promptClangdConfigGeneration: jest.MockedFunction<(workspaceFolder: vscode.WorkspaceFolder, trigger: LanguageSupportConfigurationTrigger, hasCompileCommands: boolean) => Promise<boolean>>;
    showOnce: jest.MockedFunction<(stateKey: string, message: string, kind: 'info' | 'warning') => Promise<void>>;
    handleExistingClangdForGenerateCommand: jest.MockedFunction<(workspaceFolder: vscode.WorkspaceFolder, generateExample: () => Promise<ClangdExampleGenerationResult | undefined>) => Promise<void>>;
};
type WorkspaceConfiguratorConstructor = typeof import('../../src/languageSupport/workspaceConfigurator.ts').WorkspaceConfigurator;

const resolveCudaEnvironmentMock = jest.fn<ResolveCudaEnvironment>();
const cudaEnvironmentModulePath = path.resolve(process.cwd(), 'src/languageSupport/cudaEnvironment.ts');
const workspaceConfiguratorModulePath = path.resolve(process.cwd(), 'src/languageSupport/workspaceConfigurator.ts');

jest.unstable_mockModule(cudaEnvironmentModulePath, () => ({
    resolveCudaEnvironment: resolveCudaEnvironmentMock
}));

const { WorkspaceConfigurator } = (await import(workspaceConfiguratorModulePath)) as { WorkspaceConfigurator: WorkspaceConfiguratorConstructor };

function configurationUpdateMock(section: string): jest.MockedFunction<(key: string, value: unknown, target?: unknown) => Promise<void>> {
    return (workspace.getConfiguration(section) as { update: jest.MockedFunction<(key: string, value: unknown, target?: unknown) => Promise<void>> }).update;
}

function createPrompts(decisions: PromptDecisions): PromptManagerFake {
    return {
        selectProvider: jest.fn(async () => selectedProvider(decisions.provider, decisions.source ?? 'userPrompt')),
        promptClangdConfigGeneration: jest.fn(async () => decisions.generateClangdConfig ?? false),
        showOnce: jest.fn(async () => {}),
        handleExistingClangdForGenerateCommand: jest.fn(async () => {})
    };
}

function selectedProvider(provider: LanguageProvider, source: ProviderSelectionSource): SelectedLanguageProvider {
    return { provider, source, setupPolicy: setupPolicyForSource(source) };
}

function cudaEnvironment(cudaRoot: string, cudaGpuArch = 'sm_90'): CudaEnvironment {
    return {
        cudaRoot,
        cudaIncludeDir: path.join(cudaRoot, 'include'),
        cudaCcclIncludeDir: path.join(cudaRoot, 'include', 'cccl'),
        cudaGpuArch
    };
}

describe('WorkspaceConfigurator', () => {
    let testDirectory: string;
    let workspacePath: string;
    let extensionPath: string;
    let folder: vscode.WorkspaceFolder;

    beforeEach(async () => {
        resetVscodeMock();
        resolveCudaEnvironmentMock.mockReset();
        testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rubicon-workspace-configurator-'));
        workspacePath = path.join(testDirectory, 'workspace');
        extensionPath = path.join(testDirectory, 'extension');
        await fs.mkdir(workspacePath);
        await fs.mkdir(path.join(extensionPath, 'templates', 'clangd'), { recursive: true });
        await fs.writeFile(path.join(extensionPath, 'templates', 'clangd', '.clangd'), ['CompileFlags:', '  CompilationDatabase: @COMPILE_COMMANDS_DIR@', '  Add:', '    - --cuda-path=@CUDA_ROOT@', '    - --cuda-gpu-arch=@CUDA_GPU_ARCH@'].join('\n'));
        folder = {
            name: 'workspace',
            uri: vscode.Uri.file(workspacePath),
            index: 0
        };
    });

    afterEach(async () => {
        await fs.rm(testDirectory, { recursive: true, force: true });
    });

    test('prefers workspace root compile_commands for cpptools settings without nvcc lookup', async () => {
        const compileCommandsPath = path.join(workspacePath, 'compile_commands.json');
        await fs.mkdir(path.join(workspacePath, 'build'));
        await fs.writeFile(compileCommandsPath, '[]');
        await fs.writeFile(path.join(workspacePath, 'build', 'compile_commands.json'), '[]');
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, createPrompts({ provider: 'cpptools' }), { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'userRequested');

        expect(getConfigurationValues('C_Cpp')).toEqual({
            'default.compileCommands': '${workspaceFolder}/compile_commands.json'
        });
    });

    test('uses configured CMake build directory before build fallback', async () => {
        const cmakeBuildPath = path.join(workspacePath, 'cmake-build-debug');
        const buildPath = path.join(workspacePath, 'build');
        await fs.mkdir(cmakeBuildPath);
        await fs.mkdir(buildPath);
        await fs.writeFile(path.join(cmakeBuildPath, 'compile_commands.json'), '[]');
        await fs.writeFile(path.join(buildPath, 'compile_commands.json'), '[]');
        setConfiguration('cmake', { buildDirectory: '${workspaceFolder}/cmake-build-debug' });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, createPrompts({ provider: 'cpptools' }), { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'userRequested');

        expect(getConfigurationValues('C_Cpp')).toEqual({
            'default.compileCommands': '${workspaceFolder}/cmake-build-debug/compile_commands.json'
        });
    });

    test('ignores missing and non-directory compile_commands candidates', async () => {
        const filePath = path.join(workspacePath, 'not-a-directory');
        await fs.writeFile(filePath, '');
        setConfiguration('cmake', { buildDirectory: path.join(filePath, 'nested') });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, createPrompts({ provider: 'cpptools' }), { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'userRequested');

        expect(getConfigurationValues('C_Cpp')).toEqual({});
    });

    test('continues past an unreadable candidate directory to find compile_commands', async () => {
        // A symlink cycle makes stat() fail with ELOOP, standing in for an inaccessible
        // candidate (e.g. EACCES on a locked-down out-of-source build directory). The search
        // must skip it and keep looking rather than aborting configuration.
        await fs.symlink(path.join(workspacePath, 'loopB'), path.join(workspacePath, 'loopA'));
        await fs.symlink(path.join(workspacePath, 'loopA'), path.join(workspacePath, 'loopB'));
        const buildPath = path.join(workspacePath, 'build');
        await fs.mkdir(buildPath);
        await fs.writeFile(path.join(buildPath, 'compile_commands.json'), '[]');
        setConfiguration('cmake', { buildDirectory: '${workspaceFolder}/loopA' });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, createPrompts({ provider: 'cpptools' }), { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'userRequested');

        expect(getConfigurationValues('C_Cpp')).toEqual({
            'default.compileCommands': '${workspaceFolder}/build/compile_commands.json'
        });
    });

    test('does not write cpptools settings from silent automatic provider reuse', async () => {
        const compileCommandsPath = path.join(workspacePath, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, '[]');
        const prompts = createPrompts({ provider: 'cpptools', source: 'automaticInference' });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'automatic');

        expect(getConfigurationValues('C_Cpp')).toEqual({});
    });

    test('writes cpptools settings from workspace provider preference', async () => {
        const compileCommandsPath = path.join(workspacePath, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, '[]');
        const prompts = createPrompts({ provider: 'cpptools', source: 'workspacePreference' });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'automatic');

        expect(getConfigurationValues('C_Cpp')).toEqual({
            'default.compileCommands': '${workspaceFolder}/compile_commands.json'
        });
    });

    test('skips automatic provider selection when auto workspace already has clangd config', async () => {
        await fs.writeFile(path.join(workspacePath, clangdFileName), 'CompileFlags:\n  Add: []\n');
        setConfiguration(languageSupportConfigurationSection, { provider: 'auto' });
        extensions.getExtension.mockImplementation((extensionId: string) => (extensionId === languageProviderRegistry.clangd.extensionId ? { id: extensionId } : undefined));
        const prompts = createPrompts({ provider: 'cpptools' });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'automatic');

        expect(prompts.selectProvider).not.toHaveBeenCalled();
        expect(prompts.showOnce).not.toHaveBeenCalled();
    });

    test('gates fallback clangd file creation on the fallback prompt', async () => {
        const cudaRoot = path.join(testDirectory, 'cuda-13.2');
        resolveCudaEnvironmentMock.mockResolvedValue(cudaEnvironment(cudaRoot));
        const declinedPrompts = createPrompts({ provider: 'clangd', generateClangdConfig: false });
        const acceptedPrompts = createPrompts({ provider: 'clangd', generateClangdConfig: true });

        await new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, declinedPrompts, { appendLine: jest.fn() } as any).configureLanguageSupport(folder, 'automatic');
        await expect(fs.access(path.join(workspacePath, clangdFileName))).rejects.toThrow();
        expect(declinedPrompts.promptClangdConfigGeneration).toHaveBeenCalledWith(folder, 'automatic', false);

        await new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, acceptedPrompts, { appendLine: jest.fn() } as any).configureLanguageSupport(folder, 'automatic');
        const clangd = await fs.readFile(path.join(workspacePath, clangdFileName), 'utf8');

        expect(clangd).toContain('CompilationDatabase: None');
        expect(acceptedPrompts.promptClangdConfigGeneration).toHaveBeenCalledWith(folder, 'automatic', false);
    });

    test('configures clangd from compile_commands without extra prompt after manual provider prompt selection', async () => {
        const cudaRoot = path.join(testDirectory, 'cuda-13.2');
        const compileCommandsDirectory = path.join(workspacePath, 'build');
        const compileCommandsPath = path.join(compileCommandsDirectory, 'compile_commands.json');
        await fs.mkdir(compileCommandsDirectory);
        await fs.writeFile(compileCommandsPath, '[]');
        resolveCudaEnvironmentMock.mockResolvedValue(cudaEnvironment(cudaRoot, 'sm_90'));
        const prompts = createPrompts({ provider: 'clangd', generateClangdConfig: false });
        const outputChannel = { appendLine: jest.fn() };
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, outputChannel as any);

        await configurator.configureLanguageSupport(folder, 'userRequested');

        const clangd = await fs.readFile(path.join(workspacePath, clangdFileName), 'utf8');
        expect(clangd).toContain('CompilationDatabase: build');
        expect(clangd).toContain(`--cuda-path=${cudaRoot}`);
        expect(clangd).toContain('--cuda-gpu-arch=sm_90');
        expect(resolveCudaEnvironmentMock).toHaveBeenCalledWith(compileCommandsPath, undefined);
        expect(prompts.promptClangdConfigGeneration).not.toHaveBeenCalled();
        expect(outputChannel.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('could not'));
    });

    test('install-prompted clangd still prompts before generating even with usable compile_commands', async () => {
        // installPrompt differs from userPrompt only in allowProjectFileWritesWithoutPrompt=false, so a
        // clangd provider chosen via an install prompt must still prompt before writing .clangd, unlike
        // the userPrompt path (which generates without an extra prompt when compile_commands exists).
        const cudaRoot = path.join(testDirectory, 'cuda-13.2');
        const compileCommandsDirectory = path.join(workspacePath, 'build');
        const compileCommandsPath = path.join(compileCommandsDirectory, 'compile_commands.json');
        await fs.mkdir(compileCommandsDirectory);
        await fs.writeFile(compileCommandsPath, '[]');
        resolveCudaEnvironmentMock.mockResolvedValue(cudaEnvironment(cudaRoot));
        const prompts = createPrompts({ provider: 'clangd', source: 'installPrompt', generateClangdConfig: true });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'automatic');

        expect(prompts.promptClangdConfigGeneration).toHaveBeenCalledWith(folder, 'automatic', true);
        const clangd = await fs.readFile(path.join(workspacePath, clangdFileName), 'utf8');
        expect(clangd).toContain('CompilationDatabase: build');
    });

    test('warns and gates fallback generation when user-requested clangd setup finds invalid compile_commands', async () => {
        const cudaRoot = path.join(testDirectory, 'cuda-13.2');
        const compileCommandsPath = path.join(workspacePath, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, '{');
        resolveCudaEnvironmentMock.mockResolvedValue(cudaEnvironment(cudaRoot, 'sm_80'));
        const prompts = createPrompts({ provider: 'clangd', generateClangdConfig: true });
        const outputChannel = { appendLine: jest.fn() };
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, outputChannel as any);

        await configurator.configureLanguageSupport(folder, 'userRequested');

        const clangd = await fs.readFile(path.join(workspacePath, clangdFileName), 'utf8');
        expect(clangd).toContain('CompilationDatabase: None');
        expect(resolveCudaEnvironmentMock).toHaveBeenCalledWith(undefined, undefined);
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining(`compile_commands.json at ${compileCommandsPath}`));
        expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not read or parse it'));
        expect(prompts.promptClangdConfigGeneration).toHaveBeenCalledWith(folder, 'userRequested', false);
    });

    test('does not write cpptools settings when compile_commands is invalid', async () => {
        const compileCommandsPath = path.join(workspacePath, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, '{');
        const prompts = createPrompts({ provider: 'cpptools' });
        const outputChannel = { appendLine: jest.fn() };
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, outputChannel as any);

        await configurator.configureLanguageSupport(folder, 'userRequested');

        expect(getConfigurationValues('C_Cpp')).toEqual({});
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining(`compile_commands.json at ${compileCommandsPath}`));
        expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not read or parse it'));
    });

    test('prompts before writing clangd config from silent automatic provider reuse', async () => {
        const cudaRoot = path.join(testDirectory, 'cuda-13.2');
        const compileCommandsDirectory = path.join(workspacePath, 'build');
        const compileCommandsPath = path.join(compileCommandsDirectory, 'compile_commands.json');
        await fs.mkdir(compileCommandsDirectory);
        await fs.writeFile(compileCommandsPath, '[]');
        resolveCudaEnvironmentMock.mockResolvedValue(cudaEnvironment(cudaRoot));
        const prompts = createPrompts({ provider: 'clangd', source: 'automaticInference', generateClangdConfig: false });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'automatic');

        await expect(fs.access(path.join(workspacePath, clangdFileName))).rejects.toThrow();
        expect(resolveCudaEnvironmentMock).toHaveBeenCalledWith(compileCommandsPath, undefined);
        expect(prompts.promptClangdConfigGeneration).toHaveBeenCalledWith(folder, 'automatic', true);
    });

    test('warns and logs when clangd setup cannot find a complete CUDA toolkit', async () => {
        resolveCudaEnvironmentMock.mockResolvedValue(undefined);
        await fs.writeFile(path.join(workspacePath, 'compile_commands.json'), '[]');
        const prompts = createPrompts({ provider: 'clangd' });
        const outputChannel = { appendLine: jest.fn() };
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, outputChannel as any);
        const message = 'Nsight could not find a complete CUDA Toolkit installation for clangd CUDA C++ language support.';

        await configurator.configureLanguageSupport(folder, 'automatic');

        await expect(fs.access(path.join(workspacePath, clangdFileName))).rejects.toThrow();
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining(`${folder.name}: ${message}`));
        expect(prompts.showOnce).toHaveBeenCalledWith(expect.stringContaining('noCudaToolkitWarningShown'), message, 'warning');
        expect(prompts.promptClangdConfigGeneration).not.toHaveBeenCalled();
    });

    test('warns and logs when cpptools setup cannot find a usable compile_commands', async () => {
        const prompts = createPrompts({ provider: 'cpptools' });
        const outputChannel = { appendLine: jest.fn() };
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, outputChannel as any);
        const message = 'Nsight could not find a usable compile_commands.json for Microsoft C/C++ CUDA language support.';

        await configurator.configureLanguageSupport(folder, 'userRequested');

        expect(getConfigurationValues('C_Cpp')).toEqual({});
        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining(`${folder.name}: ${message}`));
        expect(prompts.showOnce).toHaveBeenCalledWith(expect.stringContaining('noCpptoolsInputsWarningShown'), message, 'warning');
    });

    test('reports optional cpptools setting write failures only for user-requested configuration', async () => {
        const compileCommandsPath = path.join(workspacePath, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, '[]');
        configurationUpdateMock('C_Cpp').mockRejectedValue(new Error('not registered'));
        const outputChannel = { appendLine: jest.fn() };
        const warning = `Nsight is using the Microsoft C/C++ extension for CUDA C++ support in ${folder.name}, but could not save optional workspace settings. Existing C/C++ settings were not changed; see the Nsight output for details.`;

        await new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, createPrompts({ provider: 'cpptools' }), outputChannel as any).configureLanguageSupport(folder, 'userRequested');

        expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('cpptools optional settings were not saved'));
        expect(window.showWarningMessage).toHaveBeenCalledWith(warning);

        window.showWarningMessage.mockClear();
        await new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, createPrompts({ provider: 'cpptools' }), outputChannel as any).configureLanguageSupport(folder, 'automatic');

        expect(window.showWarningMessage).not.toHaveBeenCalled();
    });

    test('leaves existing .clangd unchanged without reading the template', async () => {
        const existingClangd = 'CompileFlags:\n  Add: []\n';
        await fs.writeFile(path.join(workspacePath, clangdFileName), existingClangd);
        await fs.rm(path.join(extensionPath, 'templates', 'clangd', '.clangd'));
        const prompts = createPrompts({ provider: 'clangd', generateClangdConfig: true });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, { appendLine: jest.fn() } as any);

        await configurator.configureLanguageSupport(folder, 'automatic');

        await expect(fs.readFile(path.join(workspacePath, clangdFileName), 'utf8')).resolves.toBe(existingClangd);
        expect(prompts.promptClangdConfigGeneration).not.toHaveBeenCalled();
        expect(prompts.showOnce).toHaveBeenCalledWith(expect.stringContaining('existingClangdInfoShown'), expect.stringContaining('left it unchanged'), 'info');
    });

    test('generate command leaves existing .clangd.nsight.example unchanged without resolving CUDA', async () => {
        const existingExamplePath = path.join(workspacePath, clangdExampleFileName);
        const existingExample = 'CompileFlags:\n  Add: [-DUSER]\n';
        await fs.writeFile(path.join(workspacePath, clangdFileName), 'CompileFlags:\n  Add: []\n');
        await fs.writeFile(existingExamplePath, existingExample);
        await fs.rm(path.join(extensionPath, 'templates', 'clangd', '.clangd'));
        const prompts = createPrompts({ provider: 'clangd' });
        let generationResult: ClangdExampleGenerationResult | undefined;
        prompts.handleExistingClangdForGenerateCommand.mockImplementation(async (_workspaceFolder, generateExample) => {
            generationResult = await generateExample();
        });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, { appendLine: jest.fn() } as any);

        await configurator.generateClangdConfigForWorkspace(folder);

        expect(generationResult).toEqual({ kind: 'existingFile', examplePath: existingExamplePath });
        await expect(fs.readFile(existingExamplePath, 'utf8')).resolves.toBe(existingExample);
        expect(resolveCudaEnvironmentMock).not.toHaveBeenCalled();
    });

    test('generate command creates .clangd.nsight.example for comparison when .clangd exists', async () => {
        const cudaRoot = path.join(testDirectory, 'cuda-13.2');
        const examplePath = path.join(workspacePath, clangdExampleFileName);
        await fs.writeFile(path.join(workspacePath, clangdFileName), 'CompileFlags:\n  Add: []\n');
        resolveCudaEnvironmentMock.mockResolvedValue(cudaEnvironment(cudaRoot, 'sm_80'));
        const prompts = createPrompts({ provider: 'clangd' });
        let generationResult: ClangdExampleGenerationResult | undefined;
        prompts.handleExistingClangdForGenerateCommand.mockImplementation(async (_workspaceFolder, generateExample) => {
            generationResult = await generateExample();
        });
        const configurator = new WorkspaceConfigurator({ extensionPath } as vscode.ExtensionContext, prompts, { appendLine: jest.fn() } as any);

        await configurator.generateClangdConfigForWorkspace(folder);

        const example = await fs.readFile(examplePath, 'utf8');
        expect(generationResult).toEqual({ kind: 'generated', examplePath });
        expect(example).toContain('CompilationDatabase: None');
    });
});
