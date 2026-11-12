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

// The debug session types this extension contributes (see package.json `debuggers`).
export const cudaGdbDebugType = 'cuda-gdb';
export const cudaGdbServerType = 'cuda-gdbserver';
export const cudaQnxGdbServerType = 'cuda-qnx-gdbserver';

export function isCudaDebugSession(type: string): boolean {
    return type === cudaGdbDebugType || type === cudaGdbServerType || type === cudaQnxGdbServerType;
}
