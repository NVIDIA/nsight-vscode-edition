/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import type { Warp } from './model';

export const LANE_STATES = {
    active: { label: 'Active' },
    divergent: { label: 'Divergent' },
    assert: { label: 'Assert reported' },
    exception: { label: 'Exception reported' },
    'no-live-thread': { label: 'No live thread' },
    unavailable: { label: 'Data unavailable' }
} as const;

export type LaneState = keyof typeof LANE_STATES;

export interface LaneAppearance {
    readonly state: LaneState;
    readonly text: string;
}

function hasBit(mask: number | null, lane: number): boolean {
    return mask !== null && ((mask >>> lane) & 1) === 1;
}

/** Only reported, participating lanes are verified focus targets. */
export function isLaneFocusable(warp: Warp, lane: number): boolean {
    return (
        !!warp.lanes?.some((item) => item.id === lane) &&
        (hasBit(warp.activeMask, lane) || hasBit(warp.divergentMask, lane))
    );
}

export function laneAppearance(warp: Warp, lane: number): LaneAppearance {
    const participation = hasBit(warp.activeMask, lane)
        ? 'active'
        : hasBit(warp.divergentMask, lane)
          ? 'divergent'
          : warp.activeMask === null || warp.divergentMask === null
            ? 'unavailable'
            : 'no-live-thread';
    const detail = warp.lanes?.find((item) => item.id === lane);
    if (detail?.exception) {
        const state = detail.exception.toLowerCase().includes('assert') ? 'assert' : 'exception';
        return {
            state,
            text: `${LANE_STATES[state].label}; ${LANE_STATES[participation].label}`
        };
    }
    // Masks establish participation, but missing lane details leave fault status unknown.
    if (
        warp.lanes === null ||
        (!detail && (participation === 'active' || participation === 'divergent'))
    ) {
        return {
            state: 'unavailable',
            text: `${participation === 'unavailable' ? '' : `${LANE_STATES[participation].label}; `}Data unavailable; fault information unavailable`
        };
    }
    return { state: participation, text: LANE_STATES[participation].label };
}

export function overviewText(
    warp: Warp
): Record<'warp' | 'sm' | 'kernel' | 'block' | 'activeMask' | 'pc', string> {
    return {
        warp: String(warp.warp),
        sm: String(warp.sm),
        kernel:
            warp.kernelName === null && warp.gridId === null
                ? 'N/A'
                : `${warp.kernelName ?? 'N/A'} (grid ${warp.gridId ?? 'N/A'})`,
        block: warp.block === null ? 'N/A' : `(${warp.block.join(', ')})`,
        activeMask:
            warp.activeMask === null ? 'N/A' : `0x${warp.activeMask.toString(16).padStart(8, '0')}`,
        pc: warp.pc ?? 'N/A'
    };
}
