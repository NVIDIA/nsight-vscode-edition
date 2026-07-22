import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { buildSolibSearchPath } from '../../src/debugger/utils.ts';

type CudaQnxTargetLaunchRequestArguments = import('../../src/debugger/cudaGdbServerAutostart.ts').CudaQnxTargetLaunchRequestArguments;

const autostartModulePath = path.resolve(process.cwd(), 'src/debugger/cudaGdbServerAutostart.ts');
const qnxSessionModulePath = path.resolve(process.cwd(), 'src/debugger/cudaQnxGdbServerSession.ts');

// cudaGdbServerConfig imports these interfaces as values, so the ESM mock must export them.
jest.unstable_mockModule(autostartModulePath, () => ({
    CudaQnxTargetLaunchRequestArguments: undefined,
    CudaTargetLaunchArguments: undefined,
    CudaTargetLaunchRequestArguments: undefined,
    startGDBServerGeneric: jest.fn()
}));

const { CudaQnxGdbServerSession } = (await import(qnxSessionModulePath)) as typeof import('../../src/debugger/cudaQnxGdbServerSession.ts');

class QnxSessionHarness extends CudaQnxGdbServerSession {
    startServer(args: CudaQnxTargetLaunchRequestArguments): Promise<void> {
        return this.startGDBServer(args);
    }
}

describe('QNX shared-library search path', () => {
    let sysroot: string;

    beforeEach(async () => {
        sysroot = await fs.mkdtemp(path.join(os.tmpdir(), 'rubicon-qnx-sysroot-'));
        await fs.mkdir(path.join(sysroot, 'usr', 'lib'), { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(sysroot, { recursive: true, force: true });
    });

    test('prepends the additional search path to the generated sysroot paths', () => {
        const additionalSOLibSearchPath = '/custom/qnx-libraries';
        const searchPaths = buildSolibSearchPath(sysroot, additionalSOLibSearchPath).split(':');

        expect(searchPaths[0]).toBe(additionalSOLibSearchPath);
        expect(searchPaths).toEqual(expect.arrayContaining([sysroot, path.join(sysroot, 'usr'), path.join(sysroot, 'usr', 'lib')]));
    });

    test('uses only generated sysroot paths when no additional path is configured', () => {
        const searchPaths = buildSolibSearchPath(sysroot).split(':');

        expect(searchPaths[0]).toBe(sysroot);
        expect(searchPaths).toEqual(expect.arrayContaining([path.join(sysroot, 'usr'), path.join(sysroot, 'usr', 'lib')]));
    });
});

describe('QNX connect-only launch', () => {
    test('does not start cuda-gdbserver when autostart is omitted', async () => {
        const session = new QnxSessionHarness();
        const args = {
            program: '/workspace/a.out',
            target: { host: 'qnx-target-host', port: '2346' },
            sysroot: '/path/to/qnx-sysroot'
        } as CudaQnxTargetLaunchRequestArguments;

        await expect(session.startServer(args)).resolves.toBeUndefined();
    });
});
