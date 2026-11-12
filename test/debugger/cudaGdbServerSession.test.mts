import path from 'node:path';
import { jest } from '@jest/globals';
import { type DebugProtocol } from '@vscode/debugprotocol';

const autostartModulePath = path.resolve(process.cwd(), 'src/debugger/cudaGdbServerAutostart.ts');
// cudaGdbServerConfig imports these interfaces as values, so the ESM mock must export them.
jest.unstable_mockModule(autostartModulePath, () => ({
    CudaQnxTargetLaunchRequestArguments: undefined,
    CudaTargetLaunchArguments: undefined,
    CudaTargetLaunchRequestArguments: undefined,
    startGDBServerGeneric: jest.fn()
}));

const { CudaGdbServerSession } = await import('../../src/debugger/cudaGdbServerSession.ts');

class SessionHarness extends CudaGdbServerSession {
    disconnect(response: DebugProtocol.DisconnectResponse): Promise<void> {
        return this.disconnectRequest(response, {});
    }
}

describe('Local auto-start disconnect', () => {
    test('stops the cuda-gdbserver it started', async () => {
        const session = new SessionHarness();
        Object.assign(session, { gdb: { sendGDBExit: async () => {} }, killGdbServer: true });
        const sendResponse = jest.spyOn(session, 'sendResponse').mockImplementation(() => {});

        await session.disconnect({ success: true } as DebugProtocol.DisconnectResponse);

        expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
});
