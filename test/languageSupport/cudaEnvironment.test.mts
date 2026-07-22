import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from '@jest/globals';
import {
    extractCudaGpuArch,
    getVersionedCudaRootCandidates,
    normalizeCudaGpuArch,
    readGpuArchFromCompileCommands,
    readNvccPathsFromCompileCommands,
    resolveCudaEnvironment,
    resolveCudaEnvironmentFromNvccPaths
} from '../../src/languageSupport/cudaEnvironment.ts';

function getExpectedCudaTargetDirectoryName(): string {
    return process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux';
}

async function createFakeCudaToolkit(cudaRoot: string, options: { includeCccl?: boolean; targetInclude?: boolean } = {}): Promise<string> {
    const nvccPath = path.join(cudaRoot, 'bin', 'nvcc');
    const rootIncludeDir = path.join(cudaRoot, 'include');
    await fs.mkdir(path.dirname(nvccPath), { recursive: true });
    await fs.mkdir(options.includeCccl === false ? rootIncludeDir : path.join(rootIncludeDir, 'cccl'), { recursive: true });

    if (options.targetInclude) {
        await fs.mkdir(path.join(cudaRoot, 'targets', getExpectedCudaTargetDirectoryName(), 'include', 'cccl'), { recursive: true });
    }

    await fs.writeFile(nvccPath, '');
    return nvccPath;
}

describe('CUDA environment helpers', () => {
    let testDirectory: string;

    beforeEach(async () => {
        testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rubicon-cuda-env-'));
    });

    afterEach(async () => {
        await fs.rm(testDirectory, { recursive: true, force: true });
    });

    test('extracts CUDA GPU arch flags from common nvcc command forms', () => {
        for (const [command, expectedArch] of [
            ['nvcc -arch=sm_90a file.cu', 'sm_90a'],
            ['nvcc -arch sm_80 file.cu', 'sm_80'],
            ['nvcc --cuda-gpu-arch=sm_75 file.cu', 'sm_75'],
            ['nvcc -gencode=arch=compute_90,code=sm_90 file.cu', 'sm_90'],
            ['nvcc --generate-code=arch=compute_90,code=[sm_90a,compute_90] file.cu', 'sm_90a'],
            ['nvcc --gpu-architecture compute_86 file.cu', 'sm_86']
        ] as const) {
            expect(extractCudaGpuArch(command)).toBe(expectedArch);
        }
    });

    test('ignores arch tokens outside the 2-3 digit range so a valid arch still wins', () => {
        expect(extractCudaGpuArch('nvcc -gencode=arch=compute_90,code=sm_90 -DMAX_ARCH=sm_1000 file.cu')).toBe('sm_90');
        expect(extractCudaGpuArch('nvcc -arch=sm_9 file.cu')).toBeUndefined();
        expect(extractCudaGpuArch('nvcc -DARCH=sm_1000 file.cu')).toBeUndefined();
    });

    test('orders versioned CUDA roots by semantic version descending', () => {
        expect(getVersionedCudaRootCandidates('/usr/local', ['cuda-9.2', 'cuda-13.2', 'cuda-13.10', 'cuda-backup'])).toEqual(['/usr/local/cuda-13.10', '/usr/local/cuda-13.2', '/usr/local/cuda-9.2']);
    });

    test('skips invalid nvcc candidate and returns next complete toolkit', async () => {
        const invalidNvccPath = path.join(testDirectory, 'wrapper', 'bin', 'nvcc');
        const validNvccPath = await createFakeCudaToolkit(path.join(testDirectory, 'cuda-13.2'));
        await fs.mkdir(path.dirname(invalidNvccPath), { recursive: true });
        await fs.writeFile(invalidNvccPath, '');

        const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths([invalidNvccPath, validNvccPath]);

        expect(cudaEnvironment?.cudaRoot).toBe(path.join(testDirectory, 'cuda-13.2'));
    });

    test('resolves nvcc symlink to its complete toolkit', async () => {
        const validNvccPath = await createFakeCudaToolkit(path.join(testDirectory, 'cuda-13.2'));
        const symlinkPath = path.join(testDirectory, 'bin', 'nvcc');
        await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
        await fs.symlink(validNvccPath, symlinkPath);

        const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths([symlinkPath]);

        expect(cudaEnvironment?.cudaRoot).toBe(path.join(testDirectory, 'cuda-13.2'));
    });

    test('preserves a complete CUDA Toolkit root symlink', async () => {
        const realCudaRoot = path.join(testDirectory, 'cuda-13.2');
        const symlinkCudaRoot = path.join(testDirectory, 'cuda');
        await createFakeCudaToolkit(realCudaRoot);
        await fs.symlink(realCudaRoot, symlinkCudaRoot, 'dir');

        const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths([path.join(symlinkCudaRoot, 'bin', 'nvcc')]);

        expect(cudaEnvironment).toMatchObject({
            cudaRoot: symlinkCudaRoot,
            cudaIncludeDir: path.join(symlinkCudaRoot, 'include'),
            cudaCcclIncludeDir: path.join(symlinkCudaRoot, 'include', 'cccl')
        });
    });

    test('uses configured GPU arch when resolving a complete toolkit', async () => {
        const validNvccPath = await createFakeCudaToolkit(path.join(testDirectory, 'cuda-13.2'));

        const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths([validNvccPath], undefined, 'sm_90');

        expect(cudaEnvironment?.cudaGpuArch).toBe('sm_90');
    });

    test('resolves a toolkit without a CCCL include directory', async () => {
        const validNvccPath = await createFakeCudaToolkit(path.join(testDirectory, 'cuda-12.0'), { includeCccl: false });

        const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths([validNvccPath]);

        expect(cudaEnvironment).toMatchObject({
            cudaRoot: path.join(testDirectory, 'cuda-12.0'),
            cudaIncludeDir: path.join(testDirectory, 'cuda-12.0', 'include'),
            cudaCcclIncludeDir: undefined
        });
    });

    test('prefers target-specific CUDA include directory when available', async () => {
        const cudaRoot = path.join(testDirectory, 'cuda-13.2');
        const targetIncludeDir = path.join(cudaRoot, 'targets', getExpectedCudaTargetDirectoryName(), 'include');
        const validNvccPath = await createFakeCudaToolkit(cudaRoot, { targetInclude: true });

        const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths([validNvccPath]);

        expect(cudaEnvironment).toMatchObject({
            cudaRoot,
            cudaIncludeDir: targetIncludeDir,
            cudaCcclIncludeDir: path.join(targetIncludeDir, 'cccl')
        });
    });

    test('normalizes valid configured GPU arches', () => {
        for (const [configuredArch, expectedArch] of [
            ['sm_90', 'sm_90'],
            ['sm_100', 'sm_100'],
            ['compute_90', 'sm_90'],
            ['compute_90a', 'sm_90a']
        ] as const) {
            expect(normalizeCudaGpuArch(configuredArch)).toBe(expectedArch);
        }
    });

    test('rejects invalid configured GPU arches so they fall back', () => {
        for (const configuredArch of ['sm_9', 'compute_5', 'sm_1000', 'sm_', 'bad_arch', 'gfx90a']) {
            expect(normalizeCudaGpuArch(configuredArch)).toBeUndefined();
        }
    });

    test('normalizes configured compute arches when resolving a complete toolkit', async () => {
        for (const [configuredArch, expectedArch] of [
            ['compute_90', 'sm_90'],
            ['compute_90a', 'sm_90a']
        ] as const) {
            const validNvccPath = await createFakeCudaToolkit(path.join(testDirectory, `cuda-${expectedArch}`));

            const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths([validNvccPath], undefined, configuredArch);

            expect(cudaEnvironment?.cudaGpuArch).toBe(expectedArch);
        }
    });

    test('falls back to compile commands when configured GPU arch is invalid', async () => {
        const validNvccPath = await createFakeCudaToolkit(path.join(testDirectory, 'cuda-13.2'));
        const compileCommandsPath = path.join(testDirectory, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, JSON.stringify([{ command: 'nvcc -arch=sm_90 a.cu' }]));

        const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths([validNvccPath], compileCommandsPath, 'bad_arch');

        expect(cudaEnvironment?.cudaGpuArch).toBe('sm_90');
    });

    test('falls back to the default when configured GPU arch is invalid and no arch is discovered', async () => {
        const validNvccPath = await createFakeCudaToolkit(path.join(testDirectory, 'cuda-13.2'));

        const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths([validNvccPath], undefined, 'bad_arch');

        expect(cudaEnvironment?.cudaGpuArch).toBe('sm_80');
    });

    test('picks the highest arch across compile_commands entries', async () => {
        const compileCommandsPath = path.join(testDirectory, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, JSON.stringify([{ command: 'nvcc -arch=sm_80 a.cu' }, { command: 'nvcc -arch=sm_90 b.cu' }, { command: 'nvcc -arch=sm_80 c.cu' }]));

        await expect(readGpuArchFromCompileCommands(compileCommandsPath)).resolves.toBe('sm_90');
    });

    test('prefers the "a" arch variant on numeric tie', async () => {
        const compileCommandsPath = path.join(testDirectory, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, JSON.stringify([{ command: 'nvcc -arch=sm_90 a.cu' }, { command: 'nvcc -arch=sm_90a b.cu' }]));

        await expect(readGpuArchFromCompileCommands(compileCommandsPath)).resolves.toBe('sm_90a');
    });

    test('extracts absolute nvcc paths from compile commands', async () => {
        const firstNvccPath = path.join(testDirectory, 'cuda-12.4', 'bin', 'nvcc');
        const secondNvccPath = path.join(testDirectory, 'cuda-13.2', 'bin', 'nvcc');
        const compileCommandsPath = path.join(testDirectory, 'compile_commands.json');
        await fs.writeFile(
            compileCommandsPath,
            JSON.stringify([
                { command: `${firstNvccPath} -arch=sm_80 a.cu` },
                { arguments: [secondNvccPath, '-arch=sm_90', 'b.cu'] },
                { arguments: ['nvcc', '$CUDA_HOME/bin/nvcc', '-arch=sm_90', 'ignored.cu'] },
                { command: `${firstNvccPath} -arch=sm_80 c.cu` }
            ])
        );

        await expect(readNvccPathsFromCompileCommands(compileCommandsPath)).resolves.toEqual([firstNvccPath, secondNvccPath]);
    });

    test('uses compile commands nvcc candidates before system CUDA candidates', async () => {
        const compileCommandsNvccPath = await createFakeCudaToolkit(path.join(testDirectory, 'cuda-12.4'));
        const compileCommandsPath = path.join(testDirectory, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, JSON.stringify([{ arguments: [compileCommandsNvccPath, '-arch=sm_80', 'a.cu'] }]));

        const cudaEnvironment = await resolveCudaEnvironment(compileCommandsPath);

        expect(cudaEnvironment?.cudaRoot).toBe(path.join(testDirectory, 'cuda-12.4'));
    });

    test('falls back when compile commands nvcc candidate is invalid', async () => {
        const invalidNvccPath = path.join(testDirectory, 'missing-cuda', 'bin', 'nvcc');
        const fallbackNvccPath = await createFakeCudaToolkit(path.join(testDirectory, 'cuda-13.2'));
        const compileCommandsPath = path.join(testDirectory, 'compile_commands.json');
        await fs.writeFile(compileCommandsPath, JSON.stringify([{ command: `${invalidNvccPath} -arch=sm_80 a.cu` }]));
        const nvccPaths = [...(await readNvccPathsFromCompileCommands(compileCommandsPath)), fallbackNvccPath];

        const cudaEnvironment = await resolveCudaEnvironmentFromNvccPaths(nvccPaths, compileCommandsPath);

        expect(cudaEnvironment?.cudaRoot).toBe(path.join(testDirectory, 'cuda-13.2'));
    });
});
