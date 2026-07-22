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
});
