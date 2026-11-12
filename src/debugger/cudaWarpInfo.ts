/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2026, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

import * as types from './types';
import * as utils from './utils';

/** Raw row from `-cuda-info-warps` / InfoCudaWarpsTable. */
export interface MICudaWarpRow {
    current?: string;
    warp?: string;
    active_lanes_mask?: string;
    divergent_lanes_mask?: string;
    active_physical_pc?: string;
    kernel?: string;
    blockIdx?: string;
    threadIdx?: string;
}

/** Raw row from `-cuda-info-lanes` / InfoCudaLanesTable. */
export interface MICudaLaneRow {
    current?: string;
    lane?: string;
    state?: string;
    physical_pc?: string;
    threadIdx?: string;
    exception?: string;
}

const MAX_RAW_HEX_DIGITS = 64;
const MAX_UINT64_HEX_DIGITS = 16;
function parseUnsignedHex(input?: string): bigint | undefined {
    if (!input) {
        return undefined;
    }

    const trimmed = input.trim();
    if (!trimmed || trimmed === '?' || trimmed === '-') {
        return undefined;
    }

    const digits = trimmed.replace(/^0x/i, '');
    if (digits.length > MAX_RAW_HEX_DIGITS || !/^[0-9a-f]+$/i.test(digits)) {
        return undefined;
    }

    const significantDigits = digits.replace(/^0+/u, '') || '0';
    if (significantDigits.length > MAX_UINT64_HEX_DIGITS) {
        return undefined;
    }

    return BigInt(`0x${significantDigits}`);
}

export function parseLaneMask(input?: string): number | undefined {
    const value = parseUnsignedHex(input);
    return value !== undefined && value <= 0xff_ff_ff_ffn ? Number(value) : undefined;
}

export function parseHexAddress(input?: string): types.HexAddress | undefined {
    const value = parseUnsignedHex(input);
    return value === undefined ? undefined : (`0x${value.toString(16)}` as types.HexAddress);
}

export function parseOptionalInt(input?: string): number | undefined {
    if (!input) {
        return undefined;
    }

    const trimmed = input.trim();
    if (!trimmed || trimmed === '?' || trimmed === '-') {
        return undefined;
    }

    if (!/^\d+$/.test(trimmed)) return undefined;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : undefined;
}

export function parseId(input?: string): string | undefined {
    const text = input?.trim();
    return text && /^\d+$/.test(text) ? BigInt(text).toString() : undefined;
}

/** Device-launched kernels may have negative Grid IDs. */
export function parseGridId(input?: string): string | undefined {
    const text = input?.trim();
    return text && /^-?\d+$/.test(text) ? BigInt(text).toString() : undefined;
}

export function kernelName(invocation?: string): string | undefined {
    // cuda-gdb appends arguments as `(,args=[...])` (or ordinary `(args)`).
    const text = invocation?.trim();
    if (!text || text === '?' || text === '-') return undefined;
    const argumentsStart = text.indexOf('(,args=');
    const boundary = argumentsStart >= 0 ? argumentsStart : text.indexOf('(');
    return (boundary < 0 ? text : text.slice(0, boundary)).trim() || undefined;
}

export function isCurrentMarker(current?: string): boolean {
    return (current?.trim() ?? '') === '*';
}

export function mapWarpRow(
    row: MICudaWarpRow,
    context: { device?: number; sm?: number }
): types.CudaWarpInfo {
    const warp = parseOptionalInt(row.warp);

    return {
        device: context.device,
        sm: context.sm,
        warp,
        kernelId: parseId(row.kernel),
        blockIdx: utils.parseCudaDim(row.blockIdx ?? ''),
        pc: parseHexAddress(row.active_physical_pc),
        activeMask: parseLaneMask(row.active_lanes_mask),
        divergentMask: parseLaneMask(row.divergent_lanes_mask),
        lanes: [],
        isFocusWarp: isCurrentMarker(row.current)
    };
}

export function mapLaneRow(row: MICudaLaneRow, blockDim?: types.CudaDim): types.CudaLaneInfo {
    const lane = parseOptionalInt(row.lane);
    if (lane === undefined || lane > 31) throw new Error('Invalid lane index in CUDA response.');
    const threadIdx = utils.parseCudaDim(row.threadIdx ?? '');
    let flatThreadIdx: number | undefined;
    if (threadIdx?.x !== undefined && threadIdx.y !== undefined && threadIdx.z !== undefined) {
        const { x, y, z } = threadIdx;
        if (y === 0 && z === 0) {
            flatThreadIdx = x;
        } else if (blockDim?.x && blockDim.y) {
            flatThreadIdx = x + blockDim.x * (y + blockDim.y * z);
        }
    }
    const exceptionDetails = row.exception?.trim();
    const hasException =
        !!exceptionDetails && exceptionDetails !== '-' && exceptionDetails.toLowerCase() !== 'none';

    return {
        lane,
        threadIdx,
        flatThreadIdx,
        state: row.state?.trim() || undefined,
        pc: parseHexAddress(row.physical_pc),
        exceptionDetails: hasException ? exceptionDetails : undefined,
        isFocus: isCurrentMarker(row.current)
    };
}
