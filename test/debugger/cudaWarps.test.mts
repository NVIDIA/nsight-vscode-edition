import type { CudaDebugProtocol } from '../../src/debugger/cudaDebugProtocol.ts';
import { usingWorkspace } from './test-client.mts';

describe('CUDA warp requests', () => {
    test('return a warp overview and lane details for the selected warp', () =>
        usingWorkspace(async (ws) => {
            const src = ws.file('default/variables.cu');
            const bp = await src.createBreakpoint({ line: '📍cudaComputeHash' });
            const session = await src.startDebugging();
            await bp.waitForBreakCount(1);

            const overview = (await session.dap.send(
                'cudaWarps',
                {}
            )) as CudaDebugProtocol.CudaWarpsResponse;
            const snapshot = overview.body?.snapshot;
            expect(snapshot?.warps.length).toBeGreaterThan(0);

            const { device, sm, warp } = snapshot!.warps[0];
            expect(device).toBeDefined();
            expect(sm).toBeDefined();
            expect(warp).toBeDefined();
            const details = (await session.dap.send('cudaWarpDetails', {
                selection: { device, sm, warp }
            })) as CudaDebugProtocol.CudaWarpDetailsResponse;
            expect(details.body.warp).toMatchObject({ device, sm, warp });
            expect(details.body.warp?.lanes.length).toBeGreaterThan(0);
        }));
});
