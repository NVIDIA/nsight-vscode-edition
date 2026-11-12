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

import type * as types from './debugger/types';

/*
 * Per-session CUDA focus, shared between the debug adapter trackers, which publish it from the
 * adapter's changedCudaFocus event, and the status bar, which shows it for the active session.
 * Keyed by vscode.DebugSession.id: VS Code allows several CUDA sessions at once.
 *
 * Deliberately free of vscode imports so it is unit-testable.
 */

export type DebugSessionStateListener = (sessionId: string) => void;

const focuses = new Map<string, types.CudaFocus | undefined>();
const listeners = new Set<DebugSessionStateListener>();

export function getCudaFocus(sessionId: string): types.CudaFocus | undefined {
    return focuses.get(sessionId);
}

export function setCudaFocus(sessionId: string, focus: types.CudaFocus | undefined): void {
    focuses.set(sessionId, focus);
    notify(sessionId);
}

// Forgets a session that has ended; listeners see one last change for it.
export function clearDebugSessionState(sessionId: string): void {
    if (focuses.delete(sessionId)) {
        notify(sessionId);
    }
}

// Fires with the id of the session whose state changed.
export function onDidChangeDebugSessionState(listener: DebugSessionStateListener): {
    dispose(): void;
} {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
}

export function resetDebugSessionStateForTesting(): void {
    focuses.clear();
    listeners.clear();
}

function notify(sessionId: string): void {
    for (const listener of listeners) {
        listener(sessionId);
    }
}
