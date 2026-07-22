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
import os from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const extensionDevelopmentPath = process.cwd();
const extensionTestsPath = path.resolve(extensionDevelopmentPath, 'out', 'extensionHost', 'suite', 'index.js');
const defaultVSCodeExecutablePath = '/usr/share/code/code';

async function getVSCodeExecutablePath(): Promise<string | undefined> {
    if (process.env.VSCODE_TEST_EXECUTABLE_PATH) {
        return process.env.VSCODE_TEST_EXECUTABLE_PATH;
    }

    try {
        await fs.access(defaultVSCodeExecutablePath);
        return defaultVSCodeExecutablePath;
    } catch {
        return undefined;
    }
}

async function createTestWorkspace(): Promise<{ workspacePath: string; userDataDir: string; extensionsDir: string; cudaRoot: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rubicon-extension-host-'));
    const workspacePath = path.join(root, 'workspace');
    const userDataDir = path.join(root, 'user-data');
    const extensionsDir = path.join(root, 'extensions');
    const cudaRoot = path.join(root, 'cuda-13.2');
    const nvccPath = path.join(cudaRoot, 'bin', 'nvcc');
    const buildPath = path.join(workspacePath, 'build');

    await fs.mkdir(path.join(workspacePath, '.vscode'), { recursive: true });
    await fs.mkdir(buildPath, { recursive: true });
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.mkdir(path.join(cudaRoot, 'include', 'cccl'), { recursive: true });
    await fs.mkdir(path.dirname(nvccPath), { recursive: true });
    await fs.writeFile(nvccPath, '#!/bin/sh\n', 'utf8');
    await fs.writeFile(path.join(workspacePath, 'kernel.cu'), '__global__ void kernel() {}\n', 'utf8');
    await fs.writeFile(
        path.join(buildPath, 'compile_commands.json'),
        `${JSON.stringify(
            [
                {
                    directory: workspacePath,
                    file: path.join(workspacePath, 'kernel.cu'),
                    arguments: [nvccPath, '-arch=sm_90a', '-c', path.join(workspacePath, 'kernel.cu')]
                }
            ],
            undefined,
            4
        )}\n`,
        'utf8'
    );
    await fs.writeFile(
        path.join(workspacePath, '.vscode', 'settings.json'),
        `${JSON.stringify(
            {
                'nsight.cuda.languageSupport.autoConfigure': false
            },
            undefined,
            4
        )}\n`,
        'utf8'
    );

    return { workspacePath, userDataDir, extensionsDir, cudaRoot };
}

async function main(): Promise<void> {
    const { workspacePath, userDataDir, extensionsDir, cudaRoot } = await createTestWorkspace();
    const vscodeExecutablePath = await getVSCodeExecutablePath();

    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        vscodeExecutablePath,
        launchArgs: [
            workspacePath,
            '--disable-extensions',
            '--disable-gpu',
            '--disable-setuid-sandbox',
            '--disable-telemetry',
            '--disable-workspace-trust',
            '--headless',
            '--ozone-platform=headless',
            '--user-data-dir',
            userDataDir,
            '--extensions-dir',
            extensionsDir,
            '--skip-welcome',
            '--skip-release-notes'
        ],
        extensionTestsEnv: {
            ELECTRON_DISABLE_SANDBOX: '1',
            RUBICON_LANGUAGE_HOST_CUDA_ROOT: cudaRoot,
            RUBICON_LANGUAGE_HOST_WORKSPACE: workspacePath
        }
    });
}

// eslint-disable-next-line unicorn/prefer-top-level-await -- This runner is bundled as CommonJS by the extension-host test build.
main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
