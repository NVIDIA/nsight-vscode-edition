import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type DebugProtocol } from '@vscode/debugprotocol';
import waitForExpect from 'wait-for-expect';
import { CudaGdbSession } from '../../src/debugger/cudaGdbSession.ts';
import { usingWorkspace } from './test-client.mts';

describe('Launch arguments', () => {
    test('empty args array launches without debuggee arguments', () =>
        usingWorkspace(async (workspace) => {
            const bp = await workspace.createFunctionBreakpoint({ name: 'main' });

            const session = await workspace.startDebugging('default:launch', {
                args: [],
                breakOnLaunch: false
            });
            await bp.waitForBreakCount(1);

            const frame = await session.lastStopStackFrame();
            await frame.expectLocal('argc', '1');
        }));

    test('empty debuggerPath is treated as unspecified', () =>
        usingWorkspace(async (workspace) => {
            const bp = await workspace.createFunctionBreakpoint({ name: 'main' });

            await workspace.startDebugging('default:launch', {
                debuggerPath: '',
                breakOnLaunch: false
            });
            await bp.waitForBreakCount(1);
        }));

    test('miDebuggerArgs are passed to cuda-gdb', () =>
        usingWorkspace(async (workspace) => {
            const bp = await workspace.createFunctionBreakpoint({ name: 'main' });

            const session = await workspace.startDebugging('default:launch', {
                miDebuggerArgs: ['-ex', 'set $miDebuggerArgs = 42'],
                breakOnLaunch: false
            });
            await bp.waitForBreakCount(1);

            const frame = await session.lastStopStackFrame();
            expect((await frame.evaluate('$miDebuggerArgs')).result).toEqual('42');
        }));

    test('logFile of each session gets only its own log lines', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubicon-log-file-'));
        try {
            const debuggerPath = path.join(dir, 'cuda-gdb');
            fs.writeFileSync(debuggerPath, '');
            const logFiles = ['a.log', 'b.log'].map((name) => path.join(dir, name));
            for (const logFile of logFiles) {
                const session = new CudaGdbSession();
                // The launch stops where cuda-gdb would be started, after the logger is set up.
                (session as unknown as { spawn(): Promise<void> }).spawn = () =>
                    Promise.reject(new Error('cuda-gdb is not started in this test'));
                session.handleMessage({
                    seq: 1,
                    type: 'request',
                    command: 'launch',
                    arguments: { debuggerPath, logFile }
                } as DebugProtocol.Request);
                await waitForExpect(() =>
                    expect(fs.readFileSync(logFile, 'utf8')).toContain('Calling launch request')
                );
            }
            expect(fs.readFileSync(logFiles[0], 'utf8')).not.toContain(logFiles[1]);
            expect(fs.readFileSync(logFiles[1], 'utf8')).not.toContain(logFiles[0]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('adapter log lines but not the DAP traffic are reported in the debug console', () =>
        usingWorkspace(async (workspace) => {
            const bp = await workspace.createFunctionBreakpoint({ name: 'main' });

            const session = await workspace.createDebugSession('default:launch', {
                setupCommands: [
                    {
                        text: 'set cuda no_such_setting on',
                        description: 'An unknown setting',
                        ignoreFailures: true
                    }
                ],
                breakOnLaunch: false,
                verboseLogging: true
            });
            const outputs: string[] = [];
            session.dap.on('output', (event: DebugProtocol.OutputEvent) =>
                outputs.push(event.body.output)
            );
            await session.startDebugging();
            await session.configurationDone();
            await bp.waitForBreakCount(1);

            expect(outputs.join('')).toContain(
                'Setup command "set cuda no_such_setting on" failed but failures are ignored'
            );
            expect(outputs.some((output) => output.startsWith('GDB command: '))).toBe(true);
            expect(outputs.filter((output) => /^(To|From) client: /.test(output))).toEqual([]);
        }));
});
