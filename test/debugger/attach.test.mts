import { test } from '@jest/globals';
import { usingWorkspace } from './test-client.mts';

describe('Attach', () => {
    describe('Process ID', () => {
        test('attaches to a running process given a numeric process ID', () =>
            usingWorkspace(async (workspace) => {
                const target = await workspace.startProcessWaitingForAttach();
                const bp = await workspace
                    .file('default/attach.cu')
                    .createBreakpoint({ line: '📍attached' });

                const session = await workspace.startDebugging('default:attach', {
                    processId: target.pid
                });
                await session.waitForStop('entry');
                await session.continue();

                await bp.waitForBreakCount(1);
            }));

        test('attaches to a running process given the process ID as a string', () =>
            usingWorkspace(async (workspace) => {
                const target = await workspace.startProcessWaitingForAttach();
                const bp = await workspace
                    .file('default/attach.cu')
                    .createBreakpoint({ line: '📍attached' });

                const session = await workspace.startDebugging('default:attach', {
                    processId: `${target.pid}`
                });
                await session.waitForStop('entry');
                await session.continue();

                await bp.waitForBreakCount(1);
            }));

        test('attaches to a running process given the process ID and executable name reported by the process picker', () =>
            usingWorkspace(async (workspace) => {
                const target = await workspace.startProcessWaitingForAttach();
                const bp = await workspace
                    .file('default/attach.cu')
                    .createBreakpoint({ line: '📍attached' });

                const session = await workspace.startDebugging('default:attach', {
                    processId: `${target.pid}:default attach`
                });
                await session.waitForStop('entry');
                await session.continue();

                await bp.waitForBreakCount(1);
            }));

        test('attaches to a running process given a process ID surrounded by whitespace', () =>
            usingWorkspace(async (workspace) => {
                const target = await workspace.startProcessWaitingForAttach();
                const bp = await workspace
                    .file('default/attach.cu')
                    .createBreakpoint({ line: '📍attached' });

                const session = await workspace.startDebugging('default:attach', {
                    processId: ` ${target.pid} `
                });
                await session.waitForStop('entry');
                await session.continue();

                await bp.waitForBreakCount(1);
            }));

        test('inspects the state of the attached process', () =>
            usingWorkspace(async (workspace) => {
                const target = await workspace.startProcessWaitingForAttach();
                const bp = await workspace
                    .file('default/attach.cu')
                    .createBreakpoint({ line: '📍attached' });

                const session = await workspace.startDebugging('default:attach', {
                    processId: target.pid
                });
                await session.waitForStop('entry');
                await session.continue();
                await bp.waitForBreakCount(1);

                // The outermost frame is main, which received the 'attach' argument that made the
                // process wait for a debugger. The attach config has no program of its own, so its
                // symbols can only come from the executable resolved from the attached process.
                const frame = await session.lastStopStackFrame();
                await frame.expectLocal('argc', '2');
            }));
    });

    describe('Invalid process ID', () => {
        test.each([
            ['not a number', 'not-a-pid'],
            ['empty', ''],
            ['zero', '0'],
            ['negative', '-1'],
            ['fractional', '1.5'],
            ['out of range', `${Number.MAX_SAFE_INTEGER}0`]
        ])('rejects a process ID that is %s', (_, processId) =>
            usingWorkspace(async (workspace) => {
                const message = await workspace.expectDebuggingToFail('default:attach', {
                    processId
                });

                expect(message).toEqual(`Unable to attach to pid ${processId}: invalid process ID`);
            })
        );

        test('rejects a missing process ID', () =>
            usingWorkspace(async (workspace) => {
                const message = await workspace.expectDebuggingToFail('default:attach', {
                    processId: undefined
                });

                expect(message).toEqual('Unable to attach to pid undefined: invalid process ID');
            }));

        test('reports the executable name from the process picker alongside an invalid process ID', () =>
            usingWorkspace(async (workspace) => {
                const message = await workspace.expectDebuggingToFail('default:attach', {
                    processId: 'not-a-pid:default attach'
                });

                expect(message).toEqual(
                    'Unable to attach to pid not-a-pid (process name: default attach): invalid process ID'
                );
            }));
    });

    describe('Unavailable process', () => {
        test('rejects a process ID of a process that is no longer running', () =>
            usingWorkspace(async (workspace) => {
                const target = await workspace.startProcessWaitingForAttach();
                const { pid } = target;
                await target.dispose();

                const message = await workspace.expectDebuggingToFail('default:attach', {
                    processId: pid
                });

                expect(message).toStartWith(`Unable to attach to pid ${pid}: `);
                expect(message).toInclude(`/proc/${pid}/exe`);
            }));

        test('reports the executable name from the process picker for a process that is no longer running', () =>
            usingWorkspace(async (workspace) => {
                const target = await workspace.startProcessWaitingForAttach();
                const { pid } = target;
                await target.dispose();

                const message = await workspace.expectDebuggingToFail('default:attach', {
                    processId: `${pid}:default attach`
                });

                expect(message).toStartWith(
                    `Unable to attach to pid ${pid} (process name: default attach): `
                );
                expect(message).toInclude(`/proc/${pid}/exe`);
            }));
    });
});
