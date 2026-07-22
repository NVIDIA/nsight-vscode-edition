import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clangdFileName, clangdNoCompilationDatabaseValue, clangdTemplateRelativePath, getClangdCompilationDatabaseValue, getClangdPath, hasClangdConfig, resolveClangdTemplate, setupClangd } from '../../src/languageSupport/clangdSetup.ts';
import { type CudaEnvironment } from '../../src/languageSupport/cudaEnvironment.ts';

const cudaEnvironment: CudaEnvironment = {
    cudaRoot: '/usr/local/cuda-13.2',
    cudaIncludeDir: '/usr/local/cuda-13.2/targets/x86_64-linux/include',
    cudaCcclIncludeDir: '/usr/local/cuda-13.2/targets/x86_64-linux/include/cccl',
    cudaGpuArch: 'sm_90a'
};

const cudaEnvironmentWithoutCccl: CudaEnvironment = {
    cudaRoot: '/usr/local/cuda-13.2',
    cudaIncludeDir: '/usr/local/cuda-13.2/targets/x86_64-linux/include',
    cudaGpuArch: 'sm_90a'
};

describe('clangd setup', () => {
    let testDirectory: string;
    let extensionPath: string;
    let workspacePath: string;

    beforeEach(async () => {
        testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rubicon-clangd-'));
        extensionPath = path.join(testDirectory, 'extension');
        workspacePath = path.join(testDirectory, 'workspace');
        await fs.mkdir(path.join(extensionPath, path.dirname(clangdTemplateRelativePath)), { recursive: true });
        await fs.mkdir(workspacePath);
        await fs.writeFile(
            path.join(extensionPath, clangdTemplateRelativePath),
            [
                'CompileFlags:',
                '  CompilationDatabase: @COMPILE_COMMANDS_DIR@',
                '  Add:',
                '    - --cuda-path=@CUDA_ROOT@',
                '    - -I@CUDA_INCLUDE_DIR@',
                '@IF_CUDA_CCCL_INCLUDE_DIR@',
                '    - -I@CUDA_CCCL_INCLUDE_DIR@',
                '@ENDIF_CUDA_CCCL_INCLUDE_DIR@',
                '    - --cuda-gpu-arch=@CUDA_GPU_ARCH@'
            ].join('\n')
        );
    });

    afterEach(async () => {
        await fs.rm(testDirectory, { recursive: true, force: true });
    });

    test('resolves all clangd template placeholders', () => {
        const resolvedTemplate = resolveClangdTemplate('dir=@COMPILE_COMMANDS_DIR@ root=@CUDA_ROOT@ include=@CUDA_INCLUDE_DIR@ cccl=@CUDA_CCCL_INCLUDE_DIR@ arch=@CUDA_GPU_ARCH@', 'build', cudaEnvironment);

        expect(resolvedTemplate).toContain('dir=build');
        expect(resolvedTemplate).toContain('root=/usr/local/cuda-13.2');
        expect(resolvedTemplate).toContain('include=/usr/local/cuda-13.2/targets/x86_64-linux/include');
        expect(resolvedTemplate).toContain('cccl=/usr/local/cuda-13.2/targets/x86_64-linux/include/cccl');
        expect(resolvedTemplate).toContain('arch=sm_90a');
    });

    test('renders optional CCCL include block only when CCCL is available', () => {
        const template = ['CompileFlags:', '  Add:', '@IF_CUDA_CCCL_INCLUDE_DIR@', '    - -I@CUDA_CCCL_INCLUDE_DIR@', '@ENDIF_CUDA_CCCL_INCLUDE_DIR@', '    - --cuda-path=@CUDA_ROOT@'].join('\n');
        const withoutCccl = resolveClangdTemplate(template, 'build', cudaEnvironmentWithoutCccl);
        const withCccl = resolveClangdTemplate(template, 'build', cudaEnvironment);

        expect(withoutCccl).not.toContain('@IF_CUDA_CCCL_INCLUDE_DIR@');
        expect(withoutCccl).not.toContain('@ENDIF_CUDA_CCCL_INCLUDE_DIR@');
        expect(withoutCccl).not.toContain('@CUDA_CCCL_INCLUDE_DIR@');
        expect(withoutCccl).not.toContain('-I');
        expect(withoutCccl).toContain('--cuda-path=/usr/local/cuda-13.2');

        expect(withCccl).toContain('-I/usr/local/cuda-13.2/targets/x86_64-linux/include/cccl');
        expect(withCccl).not.toContain('@IF_CUDA_CCCL_INCLUDE_DIR@');
        expect(withCccl).not.toContain('@ENDIF_CUDA_CCCL_INCLUDE_DIR@');
    });

    test('shipped template scopes CUDA language mode to CUDA source files', async () => {
        const template = await fs.readFile(path.join(process.cwd(), clangdTemplateRelativePath), 'utf8');
        const [globalFragment, cudaFragment] = template.split('---');

        expect(template).toContain(String.raw`PathMatch: '.*\.(cu|cuh)$'`);
        expect(globalFragment).not.toContain('- -x');
        expect(globalFragment).not.toContain('- cuda');
        expect(globalFragment).not.toContain('Diagnostics:');
        expect(globalFragment).not.toContain('variadic_device_fn');
        expect(cudaFragment).toContain('Diagnostics:');
        expect(cudaFragment).toContain('variadic_device_fn');
    });

    test('shipped template has no unresolved placeholders after resolving', async () => {
        const template = await fs.readFile(path.join(process.cwd(), clangdTemplateRelativePath), 'utf8');

        expect(resolveClangdTemplate(template, 'build', cudaEnvironment)).not.toMatch(/@[A-Z_]+@/u);
        expect(resolveClangdTemplate(template, 'build', cudaEnvironmentWithoutCccl)).not.toMatch(/@[A-Z_]+@/u);
    });

    test('shipped template omits project-specific or diagnostic-volume flags', async () => {
        const template = await fs.readFile(path.join(process.cwd(), clangdTemplateRelativePath), 'utf8');

        expect(template).not.toContain('-fgpu-rdc');
        expect(template).not.toContain('-ferror-limit=0');
        expect(template).not.toContain('-ftemplate-backtrace-limit=0');
        expect(template).not.toContain('--no-cuda-version-check');
    });

    test('shipped template keeps required CUDA clangd setup flags', async () => {
        const template = await fs.readFile(path.join(process.cwd(), clangdTemplateRelativePath), 'utf8');

        expect(template).toContain('--cuda-path=@CUDA_ROOT@');
        expect(template).toContain('-I@CUDA_INCLUDE_DIR@');
        expect(template).toContain('-I@CUDA_CCCL_INCLUDE_DIR@');
        expect(template).toContain('--cuda-gpu-arch=@CUDA_GPU_ARCH@');
    });

    test('formats compile_commands directory relative to workspace only when possible', () => {
        const externalCompileCommandsDir = path.join(testDirectory, 'external-build');

        expect(getClangdCompilationDatabaseValue(workspacePath, path.join(workspacePath, 'build'))).toBe('build');
        expect(getClangdCompilationDatabaseValue(workspacePath, workspacePath)).toBe('.');
        expect(getClangdCompilationDatabaseValue(workspacePath, externalCompileCommandsDir)).toBe(externalCompileCommandsDir);
    });

    test('writes generated .clangd files with compile_commands and fallback modes', async () => {
        const result = await setupClangd({
            extensionPath,
            workspacePath,
            compilationDatabaseValue: 'build',
            cudaEnvironment
        });

        const generatedClangd = await fs.readFile(path.join(workspacePath, clangdFileName), 'utf8');

        expect(result.kind).toBe('configured');
        expect(generatedClangd).toContain('CompilationDatabase: build');
        expect(generatedClangd).toContain('--cuda-gpu-arch=sm_90a');

        const fallbackWorkspacePath = path.join(testDirectory, 'fallback-workspace');
        await fs.mkdir(fallbackWorkspacePath);
        const fallbackResult = await setupClangd({
            extensionPath,
            workspacePath: fallbackWorkspacePath,
            compilationDatabaseValue: clangdNoCompilationDatabaseValue,
            cudaEnvironment
        });

        const fallbackClangd = await fs.readFile(path.join(fallbackWorkspacePath, clangdFileName), 'utf8');

        expect(fallbackResult.kind).toBe('configured');
        expect(fallbackClangd).toContain('CompilationDatabase: None');
        expect(fallbackClangd).toContain('--cuda-path=/usr/local/cuda-13.2');
    });

    test('does not overwrite existing .clangd file', async () => {
        await fs.writeFile(path.join(workspacePath, clangdFileName), 'CompileFlags:\n  Add: []\n');

        const result = await setupClangd({
            extensionPath,
            workspacePath,
            compilationDatabaseValue: 'build',
            cudaEnvironment
        });

        const existingClangd = await fs.readFile(path.join(workspacePath, clangdFileName), 'utf8');

        expect(result.kind).toBe('existingFile');
        expect(existingClangd).toBe('CompileFlags:\n  Add: []\n');
    });

    test('checks for existing .clangd with contextual inspect errors', async () => {
        await expect(hasClangdConfig(workspacePath)).resolves.toBe(false);

        await fs.writeFile(getClangdPath(workspacePath), 'CompileFlags:\n  Add: []\n');
        await expect(hasClangdConfig(workspacePath)).resolves.toBe(true);

        const tooLongWorkspacePath = path.join(testDirectory, 'a'.repeat(5000));
        await expect(hasClangdConfig(tooLongWorkspacePath)).rejects.toThrow(`Unable to inspect existing ${clangdFileName}`);
    });

    test('adds context when the clangd template cannot be rendered', async () => {
        const templatePath = path.join(extensionPath, clangdTemplateRelativePath);
        await fs.rm(templatePath);

        await expect(
            setupClangd({
                extensionPath,
                workspacePath,
                compilationDatabaseValue: 'build',
                cudaEnvironment
            })
        ).rejects.toThrow(`Unable to generate ${clangdFileName} from template ${templatePath}`);
    });

    test('adds context when generated .clangd cannot be written', async () => {
        const missingWorkspacePath = path.join(testDirectory, 'missing-workspace');
        const clangdPath = path.join(missingWorkspacePath, clangdFileName);

        await expect(
            setupClangd({
                extensionPath,
                workspacePath: missingWorkspacePath,
                compilationDatabaseValue: 'build',
                cudaEnvironment
            })
        ).rejects.toThrow(`Unable to write generated ${clangdFileName} to ${clangdPath}`);
    });
});
