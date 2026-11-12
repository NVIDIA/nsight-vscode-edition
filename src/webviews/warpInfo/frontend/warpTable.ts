/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import type { Warp, Sort } from '../model';
export type { Sort, SortColumn } from '../model';
import { laneAppearance, overviewText } from '../presentation';

export const PC_HELP =
    'Program counter of the active lanes. Divergent lanes may have different instruction addresses.';
export const WARP_COLUMNS = [
    ['warp', 'Warp', 'Hardware warp number within its SM.'],
    ['sm', 'SM', 'Streaming multiprocessor containing this warp.'],
    ['kernel', 'Kernel / Grid', 'Kernel name and the Grid ID identifying its launch.'],
    ['block', 'Block', 'Block coordinates (x, y, z) within the grid.'],
    [
        'lanes',
        'Lanes',
        'Lanes 0–31, left to right. Colors show state; the yellow arrow marks CUDA focus.'
    ],
    [
        'activeMask',
        'Active Mask',
        'Hexadecimal bitmask of active lanes. Each set bit marks an active lane; bit 0 is lane 0.'
    ],
    ['pc', 'PC', PC_HELP]
] as const;

export function filterWarps(warps: readonly Warp[], expression: RegExp | null): readonly Warp[] {
    if (expression === null) return warps;
    return warps.filter(
        (warp) =>
            Object.values(overviewText(warp)).some((text) => expression.test(text)) ||
            Array.from({ length: 32 }, (_, lane) => laneAppearance(warp, lane).text).some((text) =>
                expression.test(text)
            )
    );
}

function compare(a: number | bigint | string, b: number | bigint | string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function nullable<T>(
    a: T | null,
    b: T | null,
    direction: number,
    compareValues: (a: T, b: T) => number
): number {
    // Resolve missing values before applying direction so they stay last in either order.
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return direction * compareValues(a, b);
}

export function sortWarps(warps: readonly Warp[], sort: Sort): readonly Warp[] {
    const direction = sort.direction === 'ascending' ? 1 : -1;
    return [...warps].sort((a, b) => {
        let order: number;
        switch (sort.column) {
            case 'warp':
            case 'sm': {
                order = direction * compare(a[sort.column], b[sort.column]);
                break;
            }
            case 'kernel': {
                order =
                    nullable(a.kernelName, b.kernelName, direction, compare) ||
                    nullable(a.gridId, b.gridId, direction, (left, right) =>
                        compare(BigInt(left), BigInt(right))
                    );
                break;
            }
            case 'block': {
                order = nullable(
                    a.block,
                    b.block,
                    direction,
                    (left, right) =>
                        compare(left[0], right[0]) ||
                        compare(left[1], right[1]) ||
                        compare(left[2], right[2])
                );
                break;
            }
            case 'activeMask': {
                order = nullable(a.activeMask, b.activeMask, direction, compare);
                break;
            }
            case 'pc': {
                order = nullable(a.pc, b.pc, direction, (left, right) =>
                    compare(BigInt(left), BigInt(right))
                );
                break;
            }
        }
        return order || a.sm - b.sm || a.warp - b.warp;
    });
}
