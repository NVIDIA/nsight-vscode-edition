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

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';

const extensionId = 'nvidia.nsight-vscode-edition';
const workspacePath = process.env.RUBICON_LANGUAGE_HOST_WORKSPACE;

function requireWorkspacePath(): string {
    assert.ok(workspacePath, 'RUBICON_LANGUAGE_HOST_WORKSPACE must point at the temp workspace.');
    return workspacePath;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await fileExists(filePath)) {
            return;
        }

        await delay(100);
    }

    assert.fail(`Timed out waiting for ${filePath}`);
}

async function activateExtension(): Promise<void> {
    const extension = vscode.extensions.getExtension(extensionId);

    assert.ok(extension, `Expected ${extensionId} to be available in the extension host.`);
    await extension.activate();
}

describe('CUDA language support smoke', () => {
    beforeEach(async () => {
        const workspacePath = requireWorkspacePath();
        await fs.rm(path.join(workspacePath, '.clangd'), { force: true });
        await fs.rm(path.join(workspacePath, '.clangd.nsight.example'), { force: true });
    });

    it('activates when automatic CUDA language support is disabled without writing .clangd', async () => {
        const workspacePath = requireWorkspacePath();
        await activateExtension();

        const commands = await vscode.commands.getCommands(false);
        assert.ok(commands.includes('cuda.configureLanguageSupport'));
        assert.ok(commands.includes('cuda.generateClangdConfig'));
        assert.equal(await fileExists(path.join(workspacePath, '.clangd')), false);

        const settings = JSON.parse(await fs.readFile(path.join(workspacePath, '.vscode', 'settings.json'), 'utf8')) as Record<string, unknown>;
        assert.equal(settings['C_Cpp.default.compilerPath'], undefined);
        assert.equal(settings['C_Cpp.default.compileCommands'], undefined);
    });

    it('generates .clangd from the shipped template with resolved placeholders', async () => {
        const workspacePath = requireWorkspacePath();
        await activateExtension();
        const clangdPath = path.join(workspacePath, '.clangd');

        const generateClangdConfig = vscode.commands.executeCommand('cuda.generateClangdConfig');
        await waitForFile(clangdPath);
        await vscode.commands.executeCommand('notifications.clearAll');
        await generateClangdConfig;

        const clangd = await fs.readFile(clangdPath, 'utf8');
        assert.match(clangd, /CompilationDatabase: build/u);
        assert.equal(clangd.includes('@COMPILE_COMMANDS_DIR@'), false);
        assert.equal(clangd.includes('@CUDA_ROOT@'), false);
        assert.equal(clangd.includes('@CUDA_INCLUDE_DIR@'), false);
        assert.equal(clangd.includes('@CUDA_CCCL_INCLUDE_DIR@'), false);
        assert.equal(clangd.includes('@CUDA_GPU_ARCH@'), false);
    });
});
