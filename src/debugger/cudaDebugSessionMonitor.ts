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

import type { DebugProtocol } from '@vscode/debugprotocol';

import { isCudaDebugSession } from '../debugTypes';

const RESUME_REQUESTS = new Set(['continue', 'next', 'stepIn', 'stepOut']);

export interface DebugSessionIdentity {
    readonly id: string;
    readonly type: string;
}

// Unavailable covers startup and shutdown while the session is still tracked.
// No active CUDA session is represented separately by undefined.
export type ActiveCudaContext =
    | { readonly kind: 'unavailable'; readonly sessionId: string }
    | { readonly kind: 'running'; readonly sessionId: string }
    | { readonly kind: 'stopped'; readonly sessionId: string; readonly stopId: string };

export interface CudaDebugSessionSubscriber {
    resumePendingChanged?(sessionId: string): void;
    activeContextChanged?(context: ActiveCudaContext | undefined): void;
    focusChanged?(sessionId: string): void;
}

export interface CudaDebugSessionSubscription {
    dispose(): void;
}

interface PendingResumeRequest {
    readonly command: string;
    readonly stoppedContext: Extract<ActiveCudaContext, { readonly kind: 'stopped' }>;
}

/** Tracks session lifecycle and stop identities; debugSessionState owns CUDA focus values. */
export class CudaDebugSessionMonitor {
    private readonly sessions = new Map<string, ActiveCudaContext>();

    private readonly subscribers = new Set<CudaDebugSessionSubscriber>();

    private readonly pendingResumeRequests = new Map<string, Map<number, PendingResumeRequest>>();

    private activeSessionId: string | undefined;

    private nextStopNumber = 0;

    private disposed = false;

    getActiveContext(): ActiveCudaContext | undefined {
        if (this.disposed || this.activeSessionId === undefined) {
            return undefined;
        }
        return this.sessions.get(this.activeSessionId);
    }

    hasSession(sessionId: string): boolean {
        return !this.disposed && this.sessions.has(sessionId);
    }

    isResumePending(sessionId: string): boolean {
        const context = this.sessions.get(sessionId);
        return [...(this.pendingResumeRequests.get(sessionId)?.values() ?? [])].some(
            (request) => request.stoppedContext === context
        );
    }

    private publishResumePendingChanged(sessionId: string): void {
        for (const subscriber of this.subscribers)
            this.dispatchToSubscriber(() => subscriber.resumePendingChanged?.(sessionId));
    }

    subscribe(subscriber: CudaDebugSessionSubscriber): CudaDebugSessionSubscription {
        if (!this.disposed) {
            this.subscribers.add(subscriber);
        }
        this.dispatchToSubscriber(() => subscriber.activeContextChanged?.(this.getActiveContext()));

        let subscribed = !this.disposed;
        return {
            dispose: (): void => {
                if (!subscribed) {
                    return;
                }
                subscribed = false;
                this.subscribers.delete(subscriber);
            }
        };
    }

    trackSession(session: DebugSessionIdentity): void {
        if (this.disposed || !isCudaDebugSession(session.type) || this.sessions.has(session.id)) {
            return;
        }
        this.sessions.set(session.id, { kind: 'unavailable', sessionId: session.id });
    }

    setActiveSession(session: DebugSessionIdentity | undefined): void {
        if (this.disposed) {
            return;
        }

        if (session === undefined || !isCudaDebugSession(session.type)) {
            if (this.activeSessionId !== undefined) {
                this.activeSessionId = undefined;
                this.publishActiveContextChanged();
            }
            return;
        }

        this.trackSession(session);
        if (this.activeSessionId !== session.id) {
            this.activeSessionId = session.id;
            this.publishActiveContextChanged();
        }
    }

    resetSession(session: DebugSessionIdentity): void {
        if (this.disposed || !isCudaDebugSession(session.type)) {
            return;
        }

        this.sessions.set(session.id, { kind: 'unavailable', sessionId: session.id });
        this.pendingResumeRequests.delete(session.id);
        if (this.activeSessionId === session.id) {
            this.publishActiveContextChanged();
        }
    }

    invalidateStoppedContext(sessionId: string): void {
        if (this.disposed || !this.sessions.has(sessionId)) {
            return;
        }
        // Preserve the session and active selection until VS Code removes them;
        // an adapter restart can reuse the same session ID.
        this.pendingResumeRequests.delete(sessionId);
        this.updateSessionContext(sessionId, { kind: 'unavailable', sessionId });
    }

    handleAdapterEvent(sessionId: string, event: DebugProtocol.Event): void {
        if (this.disposed || !this.sessions.has(sessionId)) {
            return;
        }

        switch (event.event) {
            case 'stopped': {
                this.nextStopNumber += 1;
                this.updateSessionContext(sessionId, {
                    kind: 'stopped',
                    sessionId,
                    stopId: `stop:${this.nextStopNumber}`
                });
                break;
            }
            case 'continued': {
                this.updateSessionContext(sessionId, { kind: 'running', sessionId });
                break;
            }
            case 'exited':
            case 'terminated': {
                this.invalidateStoppedContext(sessionId);
                break;
            }
            case 'changedCudaFocus': {
                this.publishFocusChanged(sessionId);
                break;
            }
            default: {
                break;
            }
        }
    }

    handleClientRequest(sessionId: string, request: DebugProtocol.Request): void {
        if (
            this.disposed ||
            !RESUME_REQUESTS.has(request.command) ||
            !isSafeNonnegativeInteger(request.seq)
        ) {
            return;
        }
        const context = this.sessions.get(sessionId);
        if (context?.kind !== 'stopped') {
            return;
        }

        let requests = this.pendingResumeRequests.get(sessionId);
        if (requests === undefined) {
            requests = new Map();
            this.pendingResumeRequests.set(sessionId, requests);
        }
        requests.set(request.seq, { command: request.command, stoppedContext: context });
        this.publishResumePendingChanged(sessionId);
    }

    handleAdapterResponse(sessionId: string, response: DebugProtocol.Response): void {
        if (this.disposed || !isSafeNonnegativeInteger(response.request_seq)) {
            return;
        }
        const requests = this.pendingResumeRequests.get(sessionId);
        const pending = requests?.get(response.request_seq);
        if (pending === undefined) {
            return;
        }
        requests?.delete(response.request_seq);
        if (requests?.size === 0) {
            this.pendingResumeRequests.delete(sessionId);
        }

        // A new stop can arrive before this resume response.
        // Only mark running if the original stopped context is still current.
        if (
            response.success !== true ||
            response.command !== pending.command ||
            this.sessions.get(sessionId) !== pending.stoppedContext
        ) {
            this.publishResumePendingChanged(sessionId);
            return;
        }
        this.updateSessionContext(sessionId, { kind: 'running', sessionId });
    }

    removeSession(sessionId: string): void {
        if (this.disposed || !this.sessions.delete(sessionId)) {
            return;
        }
        this.pendingResumeRequests.delete(sessionId);
        if (this.activeSessionId === sessionId) {
            this.activeSessionId = undefined;
            this.publishActiveContextChanged();
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.activeSessionId = undefined;
        this.sessions.clear();
        this.pendingResumeRequests.clear();
        this.subscribers.clear();
    }

    private updateSessionContext(sessionId: string, context: ActiveCudaContext): void {
        if (!this.sessions.has(sessionId)) {
            return;
        }
        this.sessions.set(sessionId, context);
        if (this.activeSessionId === sessionId) {
            this.publishActiveContextChanged();
        }
    }

    private publishActiveContextChanged(): void {
        const context = this.getActiveContext();
        const subscribers = [...this.subscribers];
        for (const subscriber of subscribers) {
            this.dispatchToSubscriber(() => subscriber.activeContextChanged?.(context));
        }
    }

    private publishFocusChanged(sessionId: string): void {
        const subscribers = [...this.subscribers];
        for (const subscriber of subscribers) {
            this.dispatchToSubscriber(() => subscriber.focusChanged?.(sessionId));
        }
    }

    private dispatchToSubscriber(dispatch: () => void): void {
        try {
            dispatch();
        } catch {
            // A failed observer must not prevent other debugger consumers from updating.
        }
    }
}

function isSafeNonnegativeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}
