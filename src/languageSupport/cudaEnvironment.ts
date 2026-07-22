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
import * as semver from 'semver';
import which from 'which';

export const fallbackCudaGpuArch = 'sm_80';
// Digit bound matches the user-facing gpuArch setting (manifest pattern and
// normalizeCudaGpuArch): real architectures are 2-3 digits, so a stray token
// such as sm_1000 (e.g. an incidental -D define) never out-ranks a valid arch.
const cudaGpuArchPattern = /(?:^|[\s=,[;])(?:sm_|compute_)([0-9]{2,3})(a?)(?=$|[\s\],;])/gu;
const absoluteNvccPathPattern = /(?:^|[\s"'])(\/[^\s"']*\/?nvcc)(?=$|[\s"'])/gu;

export type CudaEnvironment = {
    cudaRoot: string;
    cudaIncludeDir: string;
    cudaCcclIncludeDir?: string;
    cudaGpuArch: string;
};

type CompileCommand = {
    command?: string;
    arguments?: string[];
};

// Setup entry point
export async function resolveCudaEnvironment(compileCommandsPath?: string, configuredCudaGpuArch?: string): Promise<CudaEnvironment | undefined> {
    return await resolveCudaEnvironmentFromNvccPaths(await getNvccCandidates(compileCommandsPath), compileCommandsPath, configuredCudaGpuArch);
}

export async function resolveCudaEnvironmentFromNvccPaths(nvccPaths: string[], compileCommandsPath?: string, configuredCudaGpuArch?: string): Promise<CudaEnvironment | undefined> {
    const cudaGpuArch = await resolveCudaGpuArch(compileCommandsPath, configuredCudaGpuArch);

    for (const nvccPath of nvccPaths) {
        if (!(await fileExists(nvccPath))) {
            continue;
        }

        const candidateEnvironment = await buildCudaEnvironment(path.dirname(path.dirname(nvccPath)), cudaGpuArch);
        if (candidateEnvironment) {
            return candidateEnvironment;
        }

        const resolvedNvccPath = await fs.realpath(nvccPath);
        const resolvedEnvironment = await buildCudaEnvironment(path.dirname(path.dirname(resolvedNvccPath)), cudaGpuArch);
        if (resolvedEnvironment) {
            return resolvedEnvironment;
        }
    }

    return undefined;
}

// GPU architecture resolution.
async function resolveCudaGpuArch(compileCommandsPath?: string, configuredCudaGpuArch?: string): Promise<string> {
    const configuredArch = configuredCudaGpuArch ? normalizeCudaGpuArch(configuredCudaGpuArch) : undefined;
    if (configuredArch) {
        return configuredArch;
    }

    const compileCommandsArch = compileCommandsPath ? await readGpuArchFromCompileCommands(compileCommandsPath) : undefined;
    return compileCommandsArch ?? fallbackCudaGpuArch;
}

export function normalizeCudaGpuArch(cudaGpuArch: string): string | undefined {
    const match = /^(?:sm_|compute_)([0-9]{2,3})(a?)$/u.exec(cudaGpuArch.trim());
    return match ? `sm_${match[1]}${match[2]}` : undefined;
}

export function extractCudaGpuArch(command: string): string | undefined {
    let bestNum = -1;
    let bestHasA = false;

    for (const match of command.matchAll(cudaGpuArchPattern)) {
        const num = Number(match[1]);
        const hasA = match[2] === 'a';
        if (num > bestNum || (num === bestNum && hasA && !bestHasA)) {
            bestNum = num;
            bestHasA = hasA;
        }
    }

    return bestNum === -1 ? undefined : `sm_${bestNum}${bestHasA ? 'a' : ''}`;
}

// nvcc discovery.
async function getNvccCandidates(compileCommandsPath?: string): Promise<string[]> {
    const compileCommandsNvccPaths = compileCommandsPath ? await readNvccPathsFromCompileCommands(compileCommandsPath) : [];
    const systemNvccPaths = await getSystemNvccCandidates();
    return [...new Set([...compileCommandsNvccPaths, ...systemNvccPaths])];
}

function getCudaDirectoryVersion(directoryName: string): semver.SemVer | undefined {
    return directoryName.startsWith('cuda-') ? (semver.coerce(directoryName.slice('cuda-'.length)) ?? undefined) : undefined;
}

export function getVersionedCudaRootCandidates(usrLocalPath: string, directoryNames: string[]): string[] {
    const candidates: Array<{ directoryName: string; version: semver.SemVer }> = [];

    for (const directoryName of directoryNames) {
        const version = getCudaDirectoryVersion(directoryName);
        if (version) {
            candidates.push({ directoryName, version });
        }
    }

    candidates.sort((left, right) => semver.rcompare(left.version, right.version));
    return candidates.map((candidate) => path.join(usrLocalPath, candidate.directoryName));
}

async function getSystemNvccCandidates(): Promise<string[]> {
    const nvccPaths: string[] = [];

    // Explicit env-var overrides win over PATH, matching CMake/PyTorch/numba conventions.
    for (const cudaRoot of [process.env.CUDA_HOME, process.env.CUDA_PATH]) {
        if (cudaRoot) {
            nvccPaths.push(path.join(cudaRoot, 'bin', 'nvcc'));
        }
    }

    try {
        nvccPaths.push(await which('nvcc'));
    } catch {
        // nvcc is not on PATH; fall back to well-known CUDA Toolkit roots.
    }

    nvccPaths.push('/usr/local/cuda/bin/nvcc');

    try {
        const entries = await fs.readdir('/usr/local', { withFileTypes: true });
        const directoryNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        for (const cudaRoot of getVersionedCudaRootCandidates('/usr/local', directoryNames)) {
            nvccPaths.push(path.join(cudaRoot, 'bin', 'nvcc'));
        }
    } catch {
        // Some systems do not have /usr/local or do not allow listing it.
    }

    return [...new Set(nvccPaths)];
}

// CUDA Toolkit include paths.
function getCudaTargetDirectoryName(): string {
    return process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux';
}

async function findCudaIncludeDir(cudaRoot: string): Promise<string | undefined> {
    const candidates = [path.join(cudaRoot, 'targets', getCudaTargetDirectoryName(), 'include'), path.join(cudaRoot, 'include')];

    for (const candidate of candidates) {
        if (await directoryExists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

async function buildCudaEnvironment(cudaRoot: string, cudaGpuArch: string): Promise<CudaEnvironment | undefined> {
    const cudaIncludeDir = await findCudaIncludeDir(cudaRoot);
    if (!cudaIncludeDir) {
        return undefined;
    }

    const cudaCcclIncludeDir = await findCudaCcclIncludeDir(cudaIncludeDir, cudaRoot);
    return { cudaRoot, cudaIncludeDir, cudaCcclIncludeDir, cudaGpuArch };
}

async function findCudaCcclIncludeDir(cudaIncludeDir: string, cudaRoot: string): Promise<string | undefined> {
    const candidates = [path.join(cudaIncludeDir, 'cccl'), path.join(cudaRoot, 'include', 'cccl')];

    for (const candidate of candidates) {
        if (await directoryExists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

// compile_commands.json parsing.
export async function readGpuArchFromCompileCommands(compileCommandsPath: string): Promise<string | undefined> {
    try {
        const compileCommands = JSON.parse(await fs.readFile(compileCommandsPath, 'utf8')) as CompileCommand[];
        const commandText = compileCommands.map((entry) => entry.command ?? entry.arguments?.join(' ') ?? '').join(' ');
        return extractCudaGpuArch(commandText);
    } catch {
        return undefined;
    }
}

export async function readNvccPathsFromCompileCommands(compileCommandsPath: string): Promise<string[]> {
    try {
        const compileCommands = JSON.parse(await fs.readFile(compileCommandsPath, 'utf8')) as CompileCommand[];
        const nvccPaths: string[] = [];

        for (const entry of compileCommands) {
            for (const argument of entry.arguments ?? []) {
                if (path.isAbsolute(argument) && path.basename(argument) === 'nvcc') {
                    nvccPaths.push(argument);
                }
            }

            for (const match of (entry.command ?? '').matchAll(absoluteNvccPathPattern)) {
                if (path.basename(match[1]) === 'nvcc') {
                    nvccPaths.push(match[1]);
                }
            }
        }

        return [...new Set(nvccPaths)];
    } catch {
        return [];
    }
}

// Filesystem helpers.
async function fileExists(filePath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(filePath);
        return stat.isFile();
    } catch {
        return false;
    }
}

async function directoryExists(directoryPath: string): Promise<boolean> {
    try {
        const stat = await fs.stat(directoryPath);
        return stat.isDirectory();
    } catch {
        return false;
    }
}
