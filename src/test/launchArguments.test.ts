/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

import { TestUtils } from './testUtils';
import { CudaDebugClient } from './cudaDebugClient';
import { type CudaLaunchRequestArguments } from '../debugger/cudaGdbSession';
import { expect } from '@jest/globals'; // Use jest imports consistent with the file
import * as fs from 'node:fs/promises';
import path from 'node:path'; // Use default import
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import which from 'which';

let realCudaGdbPath: string | undefined; // Use undefined

// Find real cuda-gdb once before tests run
beforeAll(async () => {
    try {
        realCudaGdbPath = await which('cuda-gdb');
        console.log(`Found real cuda-gdb at: ${realCudaGdbPath}`);
    } catch {
        console.warn('cuda-gdb not found in PATH, skipping debuggerPath tests.');
        realCudaGdbPath = undefined; // Use undefined
    }
});

describe('Launch argument tests', () => {
    let dc: CudaDebugClient;

    afterEach(async () => {
        await dc.stop();
    });

    it('Launch environment variables work', async () => {
        dc = await TestUtils.createDebugClient();
        const launchArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
        launchArguments.envFile = TestUtils.resolveTestPath('launchEnvVars/launchEnvVars.txt');

        await dc.launchRequest(launchArguments);

        const line = 28;

        const bpResp = await dc.setBreakpointsRequest({
            source: TestUtils.getTestSource('launchEnvVars/launchEnvVars.cpp'),
            breakpoints: [
                {
                    line
                }
            ]
        });

        expect(bpResp).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    breakpoints: [
                        expect.objectContaining({
                            id: expect.any(Number),
                            verified: true,
                            line
                        })
                    ]
                })
            })
        );

        await dc.configurationDoneRequest();
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'launchEnvVars.cpp', 28);

        const locals = await TestUtils.getLocalsAsObject(dc, frameId);
        expect(locals).toEqual(
            expect.objectContaining({
                success: expect.objectContaining({
                    value: 'true'
                })
            })
        );
    });

    it('stopAtEntry works', async () => {
        dc = await TestUtils.createDebugClient();
        const launchArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
        launchArguments.stopAtEntry = true;

        await dc.launchRequest(launchArguments);

        await dc.configurationDoneRequest();
        // Stop reason should be 'breakpoint' when stopAtEntry hits the effective entry point (e.g., main)
        await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'launchEnvVars.cpp', 8);
    });

    // ==================================
    // setupCommands Tests
    // ==================================

    it('setupCommands: Simple successful command', async () => {
        dc = await TestUtils.createDebugClient();
        const launchArguments: CudaLaunchRequestArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
        launchArguments.stopAtEntry = true;
        launchArguments.setupCommands = [{ text: 'set $test_var = 123', ignoreFailures: false, description: 'Set test var' }];

        await dc.launchRequest(launchArguments);
        await dc.configurationDoneRequest();
        // Expect stop reason 'breakpoint' due to stopAtEntry
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'launchEnvVars.cpp', 8);

        // Use evaluateRequest directly and validate structure
        const evalResp = await dc.evaluateRequest({ expression: '$test_var', frameId: frameId });
        expect(evalResp).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    result: '123',
                    variablesReference: 0 // Convenience vars shouldn't have children
                })
            })
        );
    });

    it('setupCommands: Failing command stops execution (ignoreFailures: false)', async () => {
        dc = await TestUtils.createDebugClient();
        const launchArguments: CudaLaunchRequestArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
        launchArguments.stopAtEntry = true; // Need this to attempt to stop *after* setup commands
        launchArguments.setupCommands = [
            { text: 'set $test_var_fail_1 = 1', ignoreFailures: false, description: 'Set test var 1' },
            { text: 'invalid-gdb-command', ignoreFailures: false, description: 'This will fail' },
            { text: 'set $test_var_fail_2 = 2', ignoreFailures: false, description: 'Set test var 2 (should not run)' }
        ];

        // Launch should fail because of the invalid command with ignoreFailures: false
        await expect(dc.launchRequest(launchArguments)).rejects.toThrow();
    });

    it('setupCommands: Failing command is ignored (ignoreFailures: true)', async () => {
        dc = await TestUtils.createDebugClient();
        const launchArguments: CudaLaunchRequestArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
        launchArguments.stopAtEntry = true;
        launchArguments.setupCommands = [
            { text: 'set $test_var_ignore_1 = 1', ignoreFailures: false, description: 'Set test var 1' },
            { text: 'invalid-gdb-command', ignoreFailures: true, description: 'This will fail but be ignored' },
            { text: 'set $test_var_ignore_2 = 2', ignoreFailures: false, description: 'Set test var 2 (should run)' }
        ];

        await dc.launchRequest(launchArguments);
        await dc.configurationDoneRequest();
        // Expect stop reason 'breakpoint' due to stopAtEntry
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'launchEnvVars.cpp', 8);

        // Check first variable was set
        const evalResp1 = await dc.evaluateRequest({ expression: '$test_var_ignore_1', frameId: frameId });
        expect(evalResp1).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    result: '1',
                    variablesReference: 0
                })
            })
        );

        // Check second variable was also set (failure was ignored)
        const evalResp2 = await dc.evaluateRequest({ expression: '$test_var_ignore_2', frameId: frameId });
        expect(evalResp2).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    result: '2',
                    variablesReference: 0
                })
            })
        );
    });

    it('setupCommands: Mixed initCommands (string) and setupCommands (object)', async () => {
        dc = await TestUtils.createDebugClient();
        const launchArguments: CudaLaunchRequestArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
        launchArguments.stopAtEntry = true;
        // initCommands are processed first
        launchArguments.initCommands = ['set $init_var = 111'];
        // setupCommands are processed next
        launchArguments.setupCommands = [{ text: 'set $setup_var = 222', ignoreFailures: false, description: 'Setup var' }];

        await dc.launchRequest(launchArguments);
        await dc.configurationDoneRequest();
        // Expect stop reason 'breakpoint' due to stopAtEntry
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'launchEnvVars.cpp', 8);

        // Check initCommands variable
        const evalResp1 = await dc.evaluateRequest({ expression: '$init_var', frameId: frameId });
        expect(evalResp1).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    result: '111',
                    variablesReference: 0
                })
            })
        );

        // Check setupCommands variable
        const evalResp2 = await dc.evaluateRequest({ expression: '$setup_var', frameId: frameId });
        expect(evalResp2).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    result: '222',
                    variablesReference: 0
                })
            })
        );
    });

    it('setupCommands: Checks order with ignored failure', async () => {
        dc = await TestUtils.createDebugClient();
        const launchArguments: CudaLaunchRequestArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
        launchArguments.stopAtEntry = true;
        launchArguments.setupCommands = [
            { text: 'set $order_var = 1', ignoreFailures: false, description: 'First' },
            { text: 'invalid-gdb-command', ignoreFailures: true, description: 'Second (ignored fail)' },
            { text: 'set $order_var = $order_var + 1', ignoreFailures: false, description: 'Third (depends on first)' },
            { text: 'set $order_var_2 = 99', ignoreFailures: false, description: 'Fourth' }
        ];

        await dc.launchRequest(launchArguments);
        await dc.configurationDoneRequest();
        // Expect stop reason 'breakpoint' due to stopAtEntry
        const { frameId } = await TestUtils.assertStoppedLocation(dc, 'breakpoint', 'launchEnvVars.cpp', 8);

        // Check final value of $order_var (should be 1 + 1 = 2)
        const evalResp1 = await dc.evaluateRequest({ expression: '$order_var', frameId: frameId });
        expect(evalResp1).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    result: '2',
                    variablesReference: 0
                })
            })
        );
        // Check final value of $order_var_2
        const evalResp2 = await dc.evaluateRequest({ expression: '$order_var_2', frameId: frameId });
        expect(evalResp2).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    result: '99',
                    variablesReference: 0
                })
            })
        );
    });

    // ==================================
    // debuggerPath Tests
    // ==================================
    describe('debuggerPath', () => {
        // Use 'test.skipIf' once Node 22+ features are available, or a helper
        const testIfCudaGdbFound = realCudaGdbPath ? it : it.skip;

        testIfCudaGdbFound('uses the executable specified in debuggerPath', async () => {
            const uniqueId = crypto.randomUUID();
            // Calculate repo root relative to the current working directory
            const repoRoot = process.cwd(); // Assuming test runs from repo root
            const testDir = path.resolve(repoRoot, 'out', 'tests', `debuggerPathTest-${uniqueId}`);
            const wrapperPath = path.join(testDir, `gdb-wrapper-${uniqueId}.sh`);
            const markerPath = path.join(testDir, 'marker.txt');

            dc = await TestUtils.createDebugClient();
            const launchArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars'); // Use a simple existing program

            try {
                // 1. Setup: Create directory and wrapper script
                await fs.mkdir(testDir, { recursive: true });
                const wrapperContent = `#!/bin/bash\ntouch "${markerPath}"\nexec "${realCudaGdbPath}" "$@"`;
                await fs.writeFile(wrapperPath, wrapperContent, { mode: 0o755 }); // Make executable

                // Ensure marker does not exist initially
                await expect(fs.access(markerPath)).rejects.toThrow();

                // 2. Execution: Launch with debuggerPath pointing to wrapper
                launchArguments.debuggerPath = wrapperPath;
                launchArguments.testMode = true; // Good practice
                launchArguments.stopAtEntry = false; // Avoid stopping if not needed
                launchArguments.program = TestUtils.getTestProgram('launchEnvVars/launchEnvVars'); // Ensure program path is absolute

                // No need to store the promise if just awaiting race condition below
                await dc.launchRequest(launchArguments);

                // Wait for initialization or a short timeout
                // Using initialized event is more robust than a fixed timeout
                await Promise.race([
                    dc.waitForEvent('initialized'),
                    new Promise((_resolve, _reject) => setTimeout(() => _reject(new Error('Timeout waiting for initialized event')), 5000)) // Rename promise params
                ]);

                // If launch didn't throw and initialized event received, GDB likely started
            } finally {
                // 3. Stop debugger regardless of success/failure
                await dc.stop();

                // 4. Verification: Check if marker file was created
                let markerExists;
                try {
                    await fs.access(markerPath);
                    markerExists = true;
                } catch {
                    markerExists = false;
                }
                expect(markerExists).toBe(true);

                // 5. Cleanup
                await fs.rm(testDir, { recursive: true, force: true });
            }
        });

        it('rejects launch if debuggerPath is non-existent', async () => {
            const uniqueId = crypto.randomUUID();
            const nonExistentPath = path.join(os.tmpdir(), `non-existent-gdb-${uniqueId}`);

            dc = await TestUtils.createDebugClient();
            const launchArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');
            launchArguments.debuggerPath = nonExistentPath;
            launchArguments.program = TestUtils.getTestProgram('launchEnvVars/launchEnvVars'); // Ensure program path is absolute

            await expect(dc.launchRequest(launchArguments)).rejects.toThrow(/Unable to find/);
            // No cleanup needed as nothing should have been created
        });

        it('rejects launch if debuggerPath is not executable', async () => {
            const uniqueId = crypto.randomUUID();
            // Calculate repo root relative to the current working directory
            const repoRoot = process.cwd(); // Assuming test runs from repo root
            const testDir = path.resolve(repoRoot, 'out', 'tests', `debuggerPathNotExec-${uniqueId}`);
            const notExecutablePath = path.join(testDir, `not-executable-${uniqueId}.txt`);

            dc = await TestUtils.createDebugClient();
            const launchArguments = await TestUtils.getLaunchArguments('launchEnvVars/launchEnvVars');

            try {
                // 1. Setup: Create directory and empty, non-executable file
                await fs.mkdir(testDir, { recursive: true });
                await fs.writeFile(notExecutablePath, '', { mode: 0o644 }); // Not executable

                // 2. Execution & Verification
                launchArguments.debuggerPath = notExecutablePath;
                launchArguments.program = TestUtils.getTestProgram('launchEnvVars/launchEnvVars'); // Ensure program path is absolute
                await expect(dc.launchRequest(launchArguments)).rejects.toThrow(/Unable to find|access/); // Error message might vary slightly
            } finally {
                // 3. Cleanup
                await fs.rm(testDir, { recursive: true, force: true });
            }
        });
    }); // End of debuggerPath describe
});
