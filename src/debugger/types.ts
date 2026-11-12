/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

/** A normalized, unsigned hexadecimal address with a lowercase `0x` prefix. */
export type HexAddress = `0x${Lowercase<string>}`;

export interface CudaDim {
    x?: number;
    y?: number;
    z?: number;
}

export interface CudaSwFocus {
    type: 'software';
    blockIdx?: CudaDim;
    threadIdx?: CudaDim;
}

export interface CudaHwFocus {
    type: 'hardware';
    sm?: number;
    warp?: number;
    lane?: number;
}

export type CudaFocus = CudaSwFocus | CudaHwFocus;

export interface CudaLaneInfo {
    lane: number;
    threadIdx?: CudaDim;
    flatThreadIdx?: number;
    /** Backend participation state; faults remain separate. */
    state?: string;
    pc?: HexAddress;
    exceptionDetails?: string;
    isFocus?: boolean;
}

export interface CudaWarpInfo {
    device?: number;
    sm?: number;
    warp?: number;
    kernelId?: string;
    gridId?: string;
    kernelName?: string;
    blockIdx?: CudaDim;
    pc?: HexAddress;
    activeMask?: number;
    divergentMask?: number;
    // Empty in an overview; lane queries contain only reported valid lanes.
    lanes: CudaLaneInfo[];
    /** Present when eager lane acquisition failed for this warp. */
    laneError?: string;
    isFocusWarp?: boolean;
}

// Identifies a warp for a lane query.
export interface CudaWarpSelection {
    device?: number;
    sm?: number;
    warp: number;
}

export interface CudaWarpSnapshot {
    /** Adapter stop generation, echoed by context-bound focus requests. */
    stopEpoch?: number;
    deviceName?: string;
    unavailableReason?: string;
    warps: CudaWarpInfo[];
    focus?: CudaFocus;
    device?: number;
    sm?: number;
}

export interface OsInfo {
    platform?: string;

    architecture?: string;

    distribution?: string;

    distributionVersion?: string;
}

export interface GpuInfo {
    // "current" is a string that contains a "*" character for the currently active device.
    current?: string;

    name?: string;

    description?: string;

    smType?: string;
}
