/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { describe, expect, test } from '@jest/globals';
import type { Warp } from '../../src/webviews/warpInfo/model';
import { laneAppearance, overviewText } from '../../src/webviews/warpInfo/presentation';
import { filterWarps, sortWarps } from '../../src/webviews/warpInfo/frontend/warpTable';
import { createWarpInfoHtml } from '../../src/webviews/warpInfo/integration/html';

const warp: Warp = {
    sm: 0,
    warp: 0,
    kernelName: 'kernel',
    gridId: '1',
    block: [0, 0, 0],
    activeMask: 0x80_00_00_01,
    divergentMask: 2,
    pc: '0x1',
    lanes: [{ id: 0, exception: null }, { id: 1, exception: 'Warp Assert' }, { id: 31 }]
};

describe('Warp Info overview', () => {
    test('preserves high mask bits and participation underneath reported faults', () => {
        expect(laneAppearance(warp, 31)).toEqual({ state: 'active', text: 'Active' });
        expect(laneAppearance(warp, 1)).toEqual({
            state: 'assert',
            text: 'Assert reported; Divergent'
        });
        expect(
            laneAppearance({ ...warp, lanes: [{ id: 0, exception: 'Warp Illegal Address' }] }, 0)
                .text
        ).toBe('Exception reported; Active');
    });

    test('distinguishes unreported slots from unavailable state and fault data', () => {
        expect(laneAppearance(warp, 2).state).toBe('no-live-thread');
        expect(laneAppearance({ ...warp, lanes: null }, 0).state).toBe('unavailable');
        expect(laneAppearance({ ...warp, lanes: [] }, 31).state).toBe('unavailable');
        expect(laneAppearance({ ...warp, activeMask: null, divergentMask: null }, 2).state).toBe(
            'unavailable'
        );
        expect(laneAppearance({ ...warp, activeMask: null, divergentMask: null }, 1).state).toBe(
            'assert'
        );
    });

    describe('filtering and sorting', () => {
        test('filters separate displayed cells and status text, excluding strip lane numbers', () => {
            const row = { ...warp, warp: 8 };
            expect(filterWarps([row], /^8$/i)).toEqual([row]);
            expect(filterWarps([row], /^31$/i)).toEqual([]);
            expect(filterWarps([row], /assert/i)).toEqual([row]);
            expect(filterWarps([row], /kernel.*\(grid 1\)/i)).toEqual([row]);
            expect(filterWarps([row], /8.*kernel/i)).toEqual([]);
            expect(filterWarps([row], null)).toEqual([row]);
        });

        test('sorts masks and warp IDs numerically and keeps ties ordered by SM then Warp', () => {
            const rows = [
                { ...warp, sm: 2, warp: 2, activeMask: 0xff_ff_ff_ff },
                { ...warp, warp: 10, activeMask: 16 },
                { ...warp, warp: 2, activeMask: 1 }
            ];
            expect(
                sortWarps(rows, { column: 'warp', direction: 'ascending' }).map((w) => [
                    w.sm,
                    w.warp
                ])
            ).toEqual([
                [0, 2],
                [2, 2],
                [0, 10]
            ]);
            expect(
                sortWarps(rows, { column: 'activeMask', direction: 'descending' }).map(
                    (w) => w.activeMask
                )
            ).toEqual([0xff_ff_ff_ff, 16, 1]);
        });

        test('compares Grid IDs and addresses without losing precision', () => {
            const rows: Warp[] = [
                { ...warp, warp: 0, gridId: '9007199254740993', pc: '0x20000000000001' },
                { ...warp, warp: 1, gridId: '9007199254740992', pc: '0x20000000000000' },
                { ...warp, warp: 2, gridId: '9', pc: '0x9' },
                { ...warp, warp: 3, gridId: '10', pc: '0xa' }
            ];
            for (const column of ['kernel', 'pc'] as const) {
                expect(
                    sortWarps(rows, { column, direction: 'ascending' }).map((w) => w.warp)
                ).toEqual([2, 3, 1, 0]);
            }
            expect(overviewText(rows[0])).toMatchObject({
                kernel: 'kernel (grid 9007199254740993)',
                pc: '0x20000000000001'
            });
        });

        test('sorts block coordinates lexicographically and missing fields last in both directions', () => {
            const rows: Warp[] = [
                { ...warp, warp: 1, block: [0, 10, 0] },
                { ...warp, warp: 2, block: [0, 2, 10] },
                {
                    ...warp,
                    warp: 3,
                    block: null,
                    pc: null,
                    activeMask: null,
                    kernelName: null,
                    gridId: null
                }
            ];
            expect(
                sortWarps(rows, { column: 'block', direction: 'ascending' }).map((w) => w.warp)
            ).toEqual([2, 1, 3]);
            for (const column of ['block', 'pc', 'activeMask', 'kernel'] as const) {
                for (const direction of ['ascending', 'descending'] as const) {
                    expect(sortWarps(rows, { column, direction }).at(-1)?.warp).toBe(3);
                }
            }
        });
    });

    test('loads only bundled assets under a nonce CSP and escapes asset attributes', () => {
        const html = createWarpInfoHtml(
            'https://view/main.js" onerror="bad',
            'https://view/main.css',
            'https://view'
        );
        const nonce = html.match(/nonce="([^"]+)"/)?.[1];
        expect(nonce).toBeTruthy();
        expect(html).toContain(`script-src 'nonce-${nonce}'`);
        expect(html).toContain('main.js&quot; onerror=&quot;bad');
        expect(html).toContain("connect-src 'none'");
        expect(html).not.toContain('unsafe-inline');
        expect(html).not.toContain('unsafe-eval');
    });
});
