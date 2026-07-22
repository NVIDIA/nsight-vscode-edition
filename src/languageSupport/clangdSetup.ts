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
import { type CudaEnvironment } from './cudaEnvironment';

export const clangdTemplateRelativePath = path.join('templates', 'clangd', '.clangd');
export const clangdFileName = '.clangd';
export const clangdExampleFileName = '.clangd.nsight.example';
export const clangdNoCompilationDatabaseValue = 'None';

export type ClangdSetupOptions = {
    extensionPath: string;
    workspacePath: string;
    compilationDatabaseValue: string;
    cudaEnvironment: CudaEnvironment;
};

export type ClangdSetupResult = { kind: 'configured' | 'existingFile'; clangdPath: string };
export type ClangdExampleGenerationResult = { kind: 'generated' | 'existingFile'; examplePath: string };

function normalizePath(filePath: string): string {
    return filePath.split(path.sep).join('/');
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function getClangdPath(workspacePath: string): string {
    return path.join(workspacePath, clangdFileName);
}

export function getClangdExamplePath(workspacePath: string): string {
    return path.join(workspacePath, clangdExampleFileName);
}

export async function hasClangdConfig(workspacePath: string): Promise<boolean> {
    const clangdPath = getClangdPath(workspacePath);

    try {
        await fs.access(clangdPath);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return false;
        }

        throw new Error(`Unable to inspect existing ${clangdFileName} at ${clangdPath}: ${getErrorMessage(error)}`);
    }
}

export function getClangdCompilationDatabaseValue(workspacePath: string, compileCommandsDirectory: string): string {
    const relativePath = path.relative(workspacePath, compileCommandsDirectory);

    if (relativePath === '') {
        return '.';
    }

    if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        return normalizePath(relativePath);
    }

    return normalizePath(compileCommandsDirectory);
}

export function resolveClangdTemplate(template: string, compilationDatabaseValue: string, cudaEnvironment: CudaEnvironment): string {
    const templateWithOptionalCccl = template.replace(/^.*@IF_CUDA_CCCL_INCLUDE_DIR@\r?\n([\s\S]*?)^.*@ENDIF_CUDA_CCCL_INCLUDE_DIR@\r?\n?/mu, cudaEnvironment.cudaCcclIncludeDir ? '$1' : '');

    return templateWithOptionalCccl
        .replaceAll('@COMPILE_COMMANDS_DIR@', compilationDatabaseValue)
        .replaceAll('@CUDA_ROOT@', normalizePath(cudaEnvironment.cudaRoot))
        .replaceAll('@CUDA_INCLUDE_DIR@', normalizePath(cudaEnvironment.cudaIncludeDir))
        .replaceAll('@CUDA_CCCL_INCLUDE_DIR@', cudaEnvironment.cudaCcclIncludeDir ? normalizePath(cudaEnvironment.cudaCcclIncludeDir) : '')
        .replaceAll('@CUDA_GPU_ARCH@', cudaEnvironment.cudaGpuArch);
}

export async function generateClangdConfigContents(options: ClangdSetupOptions): Promise<string> {
    const template = await fs.readFile(path.join(options.extensionPath, clangdTemplateRelativePath), 'utf8');
    return resolveClangdTemplate(template, options.compilationDatabaseValue, options.cudaEnvironment);
}

export async function setupClangd(options: ClangdSetupOptions): Promise<ClangdSetupResult> {
    const clangdPath = getClangdPath(options.workspacePath);

    if (await hasClangdConfig(options.workspacePath)) {
        return { kind: 'existingFile', clangdPath };
    }

    let contents: string;
    try {
        contents = await generateClangdConfigContents(options);
    } catch (error) {
        const templatePath = path.join(options.extensionPath, clangdTemplateRelativePath);
        throw new Error(`Unable to generate ${clangdFileName} from template ${templatePath}: ${getErrorMessage(error)}`);
    }

    try {
        await fs.writeFile(clangdPath, contents, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
            return { kind: 'existingFile', clangdPath };
        }

        throw new Error(`Unable to write generated ${clangdFileName} to ${clangdPath}: ${getErrorMessage(error)}`);
    }

    return { kind: 'configured', clangdPath };
}
