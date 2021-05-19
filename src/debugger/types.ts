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

export interface OsInfo {
    platform?: string;

    architecture?: string;

    distribution?: string;

    distributionVersion?: string;
}

export interface GpuInfo {
    name?: string;

    description?: string;

    smType?: string;
}

export interface SystemInfo {
    os?: OsInfo;

    gpus?: GpuInfo[];
}
