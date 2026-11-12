import { type DebugProtocol } from '@vscode/debugprotocol';
import { CudaGdbSession } from '../../src/debugger/cudaGdbSession.ts';

/// Drives `=breakpoint-modified` notifications through a session and collects the
/// BreakpointEvents it sends to the client.
function notifyBreakpointModified(bkpt: unknown): DebugProtocol.Breakpoint[] {
    const session = new CudaGdbSession();
    const sent: DebugProtocol.Breakpoint[] = [];
    session.sendEvent = (event: DebugProtocol.Event) => {
        if (event.event === 'breakpoint') {
            sent.push((event as DebugProtocol.BreakpointEvent).body.breakpoint);
        }
    };
    // Protected in production code; this is exactly what the GDBBackend 'notifyAsync' hook calls.
    (session as unknown as { handleGDBNotify(cls: string, data: unknown): void }).handleGDBNotify(
        'breakpoint-modified',
        { bkpt }
    );
    return sent;
}

describe('=breakpoint-modified handling', () => {
    test('single-location breakpoint', () => {
        expect(
            notifyBreakpointModified({ number: '3', addr: '0x0000555555577000', line: '31' })
        ).toEqual([{ id: 3, verified: true, line: 31 }]);
    });

    test('single-location breakpoint still pending', () => {
        expect(notifyBreakpointModified({ number: '3', addr: '<PENDING>' })).toEqual([
            { id: 3, verified: false }
        ]);
    });

    // MI2 output for a multi-location breakpoint is `bkpt={parent},{loc},{loc}`, which the MI
    // parser turns into an array. This is what cuda-gdb 13.3 emits for a __host__ __device__
    // function once the device code is loaded (fields trimmed).
    test('multi-location breakpoint uses the parent id and the resolved location', () => {
        const events = notifyBreakpointModified([
            { number: '1', addr: '<MULTIPLE>', times: '1' },
            { number: '1.1', enabled: 'n', addr: '<PENDING>', pending: 'addNums' },
            { number: '1.2', enabled: 'y', addr: '0x000055555557787a', line: '31' }
        ]);
        expect(events).toEqual([{ id: 1, verified: true, line: 31 }]);
    });

    // First event cuda-gdb 13.3 emits for a Rust kernel bp once the device ELF is registered
    // but not yet relocated: candidate locations with unrelocated addresses and enabled="n".
    // Nothing is armed yet, so the breakpoint is not verified.
    test('multi-location breakpoint with only disabled locations is pending', () => {
        const events = notifyBreakpointModified([
            { number: '2', addr: '<MULTIPLE>', times: '0' },
            {
                number: '2.1',
                enabled: 'n',
                addr: '0x0000000000001150',
                func: 'rehash_kernel',
                line: '248'
            },
            {
                number: '2.2',
                enabled: 'n',
                addr: '0x0000000000001e80',
                func: 'set_tag',
                line: '248'
            }
        ]);
        expect(events).toEqual([{ id: 2, verified: false }]);
    });

    test('multi-location breakpoint with no resolved location is pending', () => {
        const events = notifyBreakpointModified([
            { number: '1', addr: '<MULTIPLE>' },
            { number: '1.1', addr: '<PENDING>' },
            { number: '1.2', addr: '<PENDING>' }
        ]);
        expect(events).toEqual([{ id: 1, verified: false }]);
    });

    test('notification without a breakpoint number is dropped instead of sent as id null', () => {
        expect(notifyBreakpointModified([])).toEqual([]);
        expect(notifyBreakpointModified({ addr: '<PENDING>' })).toEqual([]);
    });
});
