/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import type { CudaWarpInfo, CudaWarpSnapshot, CudaDim } from '../../../debugger/types';
import type { Lane, Warp, WarpSnapshot } from '../model';

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function index(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}
function coordinates(value?: CudaDim): readonly [number, number, number] | null {
    return value && index(value.x) && index(value.y) && index(value.z)
        ? [value.x, value.y, value.z]
        : null;
}
function text(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function mask(value: unknown): number | null {
    return index(value) && value <= 0xff_ff_ff_ff ? value : null;
}
function address(value: unknown): Warp['pc'] {
    return typeof value === 'string' && /^0x[\da-f]{1,16}$/.test(value)
        ? (value as Warp['pc'])
        : null;
}

export function readAdapterSnapshot(response: unknown): CudaWarpSnapshot {
    if (
        !record(response) ||
        !record(response.snapshot) ||
        !Array.isArray(response.snapshot.warps)
    ) {
        throw new Error('The adapter returned an invalid warp inventory.');
    }
    const snapshot = response.snapshot;
    if (typeof snapshot.unavailableReason !== 'string' && !index(snapshot.device)) {
        throw new Error('The adapter did not identify the selected GPU.');
    }
    const identities = new Set<string>();
    for (const warp of response.snapshot.warps) {
        if (
            !record(warp) ||
            !index(warp.sm) ||
            !index(warp.warp) ||
            warp.device !== snapshot.device
        ) {
            throw new Error('The adapter returned an invalid warp identity.');
        }
        const id = `${warp.sm}:${warp.warp}`;
        if (identities.has(id)) throw new Error('The adapter returned duplicate warp identities.');
        identities.add(id);
    }
    // Identity is validated here; view converters normalize the optional display fields.
    return snapshot as unknown as CudaWarpSnapshot;
}

export function readLanes(response: unknown, device: number, warp: Warp): readonly Lane[] {
    if (
        !record(response) ||
        !record(response.warp) ||
        response.warp.device !== device ||
        response.warp.sm !== warp.sm ||
        response.warp.warp !== warp.warp ||
        !Array.isArray(response.warp.lanes)
    ) {
        throw new Error('The adapter returned lane data for an invalid warp.');
    }
    const seen = new Set<number>();
    return response.warp.lanes.map((raw) => {
        if (!record(raw) || !index(raw.lane) || raw.lane > 31 || seen.has(raw.lane)) {
            throw new Error('The adapter returned invalid or duplicate lane indices.');
        }
        seen.add(raw.lane);
        return {
            id: raw.lane,
            thread: coordinates(raw.threadIdx as CudaDim | undefined),
            pc: address(raw.pc),
            exception: text(raw.exceptionDetails)
        };
    });
}

function overviewWarp(raw: CudaWarpInfo): Warp {
    return {
        sm: raw.sm!,
        warp: raw.warp!,
        kernelName: text(raw.kernelName),
        gridId: typeof raw.gridId === 'string' && /^-?\d+$/.test(raw.gridId) ? raw.gridId : null,
        block: coordinates(raw.blockIdx),
        activeMask: mask(raw.activeMask),
        divergentMask: mask(raw.divergentMask),
        pc: address(raw.pc),
        lanes: null
    };
}

export function toViewWarp(raw: CudaWarpInfo, device: number): Warp {
    const warp = overviewWarp(raw);
    try {
        if (typeof raw.laneError === 'string') throw new Error(raw.laneError);
        return { ...warp, lanes: readLanes({ warp: raw }, device, warp) };
    } catch (error) {
        // Keep the inventory row usable so lane data can be retried independently.
        return { ...warp, laneError: error instanceof Error ? error.message : String(error) };
    }
}

export function toViewFocus(snapshot: Pick<CudaWarpSnapshot, 'focus'>): WarpSnapshot['focus'] {
    const focus = snapshot.focus;
    return focus?.type === 'hardware' && index(focus.sm) && index(focus.warp)
        ? {
              sm: focus.sm,
              warp: focus.warp,
              lane: index(focus.lane) && focus.lane < 32 ? focus.lane : null
          }
        : null;
}
