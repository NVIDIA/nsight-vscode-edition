/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { randomUUID } from 'node:crypto';
import { getCudaFocus } from '../../../debugSessionState';
import { CudaDebugProtocol } from '../../../debugger/cudaDebugProtocol';

import type {
    ActiveCudaContext,
    CudaDebugSessionMonitor
} from '../../../debugger/cudaDebugSessionMonitor';
import {
    DEFAULT_PREFERENCES,
    type FocusTarget,
    type ViewPreferences,
    type Warp,
    type WarpSnapshot,
    type WarpViewState,
    type WarpViewContent
} from '../model';
import { isLaneFocusable } from '../presentation';
import { toViewFocus, toViewWarp, readLanes, readAdapterSnapshot } from './acquisition';

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

interface PendingFocusChange {
    target: FocusTarget;
    focusRefreshPromise?: Promise<void>;
}

/** Owns one view's current stopped snapshot; React owns presentation and local controls. */
export class WarpInfoController {
    state: WarpViewState = { kind: 'no-session', revision: 0 };
    private context: ActiveCudaContext | undefined;
    // Invalidates inventory and lane retries when their context or visibility changes.
    private generation = 0;
    private visible = false;
    private disposed = false;
    private device: number | undefined;
    private focus: WarpSnapshot['focus'] = null;
    // Orders focus queries independently of the longer-running inventory acquisition.
    private focusVersion = 0;
    private focusQueryPending = false;
    private readonly subscription;
    private readonly preferences = new Map<string, ViewPreferences>();
    // Adapter-issued stop identity, checked again inside the MI queue before changing focus.
    private stopEpoch: number | undefined;
    private pendingFocusChange: PendingFocusChange | undefined;
    private focusError: string | undefined;
    private acquisition: { sessionId: string; requestId: string } | undefined;

    constructor(
        private readonly sessionMonitor: CudaDebugSessionMonitor,
        private readonly request: CudaDebugProtocol.SendRequest,
        private readonly publish: (state: WarpViewState) => void
    ) {
        this.subscription = sessionMonitor.subscribe({
            activeContextChanged: (context) => this.handleActiveContextChanged(context),
            resumePendingChanged: (sessionId) => this.handleResumePendingChanged(sessionId),
            focusChanged: (sessionId) => this.handleFocusChanged(sessionId)
        });
    }

    setVisible(visible: boolean): void {
        if (this.disposed || this.visible === visible) return;
        this.visible = visible;
        if (!visible) {
            this.cancelAcquisition();
            this.generation++;
            this.focusVersion++;
            if (this.focusQueryPending) {
                this.focusQueryPending = false;
                this.device = undefined;
                this.focus = null;
                this.setState({ kind: 'loading' });
            }
            if (this.state.kind === 'ready' && this.state.retrying)
                this.setState({ ...this.state, retrying: false });
        } else if (this.context?.kind === 'stopped' && this.state.kind === 'loading') {
            void this.acquire();
        }
    }

    dispose(): void {
        this.cancelAcquisition();
        this.disposed = true;
        this.generation++;
        this.focusVersion++;
        this.subscription.dispose();
        this.preferences.clear();
    }

    resetView(): void {
        const pending = !!this.pendingFocusChange;
        this.pendingFocusChange = undefined;
        this.focusError = undefined;
        if (pending && this.context?.kind === 'stopped') {
            this.generation++;
            this.focusVersion++;
            this.device = undefined;
            this.focus = null;
            this.setState({ kind: 'loading' });
            if (this.visible) void this.acquire();
        } else this.setState(this.state);
    }

    savePreferences(sessionId: string, value: unknown): void {
        if (sessionId !== this.context?.sessionId || !value || typeof value !== 'object') return;
        const candidate = value as ViewPreferences;
        if (
            typeof candidate.filter !== 'string' ||
            !candidate.sort ||
            !['warp', 'sm', 'kernel', 'block', 'activeMask', 'pc'].includes(
                candidate.sort.column
            ) ||
            !['ascending', 'descending'].includes(candidate.sort.direction)
        )
            return;
        try {
            new RegExp(candidate.filter, 'i');
        } catch {
            return;
        }
        const preferences = { filter: candidate.filter, sort: { ...candidate.sort } };
        this.preferences.set(sessionId, preferences);
        // React already applied the change; retain it without resending the snapshot.
        this.state = { ...this.state, preferences };
    }

    async focusLane(revision: number, target: FocusTarget): Promise<void> {
        const context = this.context;
        if (
            this.disposed ||
            !this.visible ||
            context?.kind !== 'stopped' ||
            this.state.kind !== 'ready' ||
            revision !== this.state.revision ||
            this.pendingFocusChange ||
            this.sessionMonitor.isResumePending(context.sessionId) ||
            this.stopEpoch === undefined
        )
            return;
        const warp = this.state.snapshot.warps.find(
            (w) => w.sm === target.sm && w.warp === target.warp
        );
        if (!warp || !isLaneFocusable(warp, target.lane)) return;
        const operation: PendingFocusChange = { target };
        this.pendingFocusChange = operation;
        this.focusError = undefined;
        const device = this.state.snapshot.device.id;
        const stopEpoch = this.stopEpoch;
        this.setState(this.state);
        let confirmedFocus: WarpSnapshot['focus'] = null;
        let error: string | undefined;
        try {
            const response = await this.request(
                context.sessionId,
                CudaDebugProtocol.Request.changeCudaFocus,
                {
                    focus: { type: 'hardware', ...target },
                    expectedContext: { device, stopEpoch }
                }
            );
            confirmedFocus = toViewFocus(response ?? {});
        } catch (error_) {
            error = errorText(error_);
        }
        if (this.pendingFocusChange !== operation || this.context !== context || this.disposed)
            return;
        if (!this.visible) {
            this.pendingFocusChange = undefined;
            this.setState({ kind: 'loading' });
            return;
        }
        // Reuse an event-triggered read; otherwise the successful response confirms focus.
        if (!operation.focusRefreshPromise) {
            if (confirmedFocus?.lane != null && this.state.kind === 'ready') {
                // Prevent older reads from overwriting this confirmed focus.
                this.focusVersion++;
                this.focusQueryPending = false;
                this.focus = confirmedFocus;
                this.focusError = undefined;
                this.state = {
                    ...this.state,
                    snapshot: { ...this.state.snapshot, focus: confirmedFocus }
                };
            } else {
                operation.focusRefreshPromise = this.refreshFocusFromDebugger();
            }
        }
        // A newer external focus event can replace the query while we await it.
        while (operation.focusRefreshPromise) {
            const focusRefreshPromise = operation.focusRefreshPromise;
            await focusRefreshPromise;
            if (focusRefreshPromise === operation.focusRefreshPromise) break;
        }
        if (this.pendingFocusChange !== operation || this.context !== context || this.disposed)
            return;
        this.pendingFocusChange = undefined;
        this.focusError = error ?? this.focusError;
        this.setState(this.state);
    }

    async retry(revision: number, selection?: { sm: number; warp: number }): Promise<void> {
        if (revision !== this.state.revision || !this.visible || this.context?.kind !== 'stopped')
            return;
        if (this.state.kind === 'error') {
            await this.acquire();
            return;
        }
        if (this.state.kind !== 'ready' || this.state.retrying || !selection) return;
        const failed = this.state.snapshot.warps.find(
            (w) => w.sm === selection.sm && w.warp === selection.warp && w.laneError
        );
        if (!failed) return;
        const generation = ++this.generation;
        const context = this.context;
        const device = this.state.snapshot.device.id;
        this.setState({ ...this.state, retrying: true });
        const updated = await this.fetchLanes(failed, device, context.sessionId);
        if (!this.isCurrentAcquisition(generation, context) || this.state.kind !== 'ready') return;
        this.setState({
            ...this.state,
            retrying: false,
            snapshot: {
                ...this.state.snapshot,
                warps: this.state.snapshot.warps.map((w) =>
                    w.sm === updated.sm && w.warp === updated.warp ? updated : w
                )
            }
        });
    }

    private handleActiveContextChanged(context: ActiveCudaContext | undefined): void {
        const isNewStop =
            context?.kind === 'stopped' &&
            this.context?.sessionId === context.sessionId &&
            this.context !== context;
        this.cancelAcquisition();
        this.context = context;
        this.stopEpoch = undefined;
        this.pendingFocusChange = undefined;
        this.focusError = undefined;
        for (const id of this.preferences.keys())
            if (!this.sessionMonitor.hasSession(id)) this.preferences.delete(id);
        this.generation++;
        this.focusVersion++;
        this.focusQueryPending = false;
        this.device = undefined;
        this.focus = null;
        // Stop events establish focus first; outside a new stop, absent focus may be unconfirmed.
        if (isNewStop && getCudaFocus(context.sessionId) === undefined) {
            this.setState({
                kind: 'unavailable',
                message: 'No CUDA GPU is selected at this stop.'
            });
            return;
        }
        if (context?.kind === 'unavailable') {
            this.setState({
                kind: 'unavailable',
                message: 'No stopped CUDA context is available.'
            });
        } else {
            this.setState({
                kind: context?.kind === 'stopped' ? 'loading' : context ? 'running' : 'no-session'
            });
        }
        if (this.visible && context?.kind === 'stopped') void this.acquire();
    }

    private handleResumePendingChanged(sessionId: string): void {
        if (this.context?.sessionId === sessionId) this.setState(this.state);
    }

    private handleFocusChanged(sessionId: string): void {
        if (this.context?.kind !== 'stopped' || this.context.sessionId !== sessionId) return;
        if (this.visible) {
            const focusRefreshPromise = this.refreshFocusFromDebugger();
            if (this.pendingFocusChange)
                this.pendingFocusChange.focusRefreshPromise = focusRefreshPromise;
        } else {
            this.generation++;
            this.focusVersion++;
            this.device = undefined;
            this.focus = null;
            this.setState({ kind: 'loading' });
        }
    }

    private isCurrentAcquisition(generation: number, context: ActiveCudaContext): boolean {
        return (
            !this.disposed &&
            this.visible &&
            generation === this.generation &&
            context === this.context &&
            context === this.sessionMonitor.getActiveContext()
        );
    }

    private setState(state: WarpViewContent): void {
        this.state = {
            ...state,
            revision: this.generation,
            sessionId: this.context?.sessionId,
            stopId: this.context?.kind === 'stopped' ? this.context.stopId : undefined,
            deviceId: this.device,
            preferences: this.preferences.get(this.context?.sessionId ?? '') ?? DEFAULT_PREFERENCES,
            pendingFocus: this.pendingFocusChange?.target,
            focusBlocked:
                !!this.pendingFocusChange ||
                this.stopEpoch === undefined ||
                !!(this.context && this.sessionMonitor.isResumePending(this.context.sessionId)),
            focusError: this.focusError
        };
        this.publish(this.state);
    }

    private async fetchLanes(warp: Warp, device: number, sessionId: string): Promise<Warp> {
        try {
            const response = await this.request(
                sessionId,
                CudaDebugProtocol.Request.cudaWarpDetails,
                {
                    selection: { device, sm: warp.sm, warp: warp.warp }
                }
            );
            return { ...warp, lanes: readLanes(response, device, warp), laneError: undefined };
        } catch (error) {
            return { ...warp, lanes: null, laneError: errorText(error) };
        }
    }

    private cancelAcquisition(): void {
        const operation = this.acquisition;
        this.acquisition = undefined;
        // Cancellation saves backend work; context/generation checks still reject late responses.
        if (operation)
            void this.request(operation.sessionId, CudaDebugProtocol.Request.cancelCudaWarps, {
                requestId: operation.requestId
            }).catch(() => {});
    }

    private async acquire(): Promise<void> {
        const context = this.context;
        if (!this.visible || context?.kind !== 'stopped' || this.disposed) return;
        this.cancelAcquisition();
        const operation = {
            sessionId: context.sessionId,
            requestId: randomUUID()
        };
        this.acquisition = operation;
        const generation = ++this.generation;
        const focusVersion = this.focusVersion;
        this.setState({ kind: 'loading' });
        try {
            // TODO: Consider rendering the warp overview with mask-based lane colors before
            // lane details arrive, then update colors with exception/assertion information.
            const snapshot = readAdapterSnapshot(
                await this.request(operation.sessionId, CudaDebugProtocol.Request.cudaWarps, {
                    includeLanes: true,
                    requestId: operation.requestId
                })
            );
            if (!this.isCurrentAcquisition(generation, context)) return;
            if (snapshot.unavailableReason) {
                this.setState({ kind: 'unavailable', message: snapshot.unavailableReason });
                return;
            }
            // Focus may have moved to another GPU while this inventory was loading.
            // Reacquire so the selected GPU and displayed rows stay consistent.
            if (
                focusVersion !== this.focusVersion &&
                this.device !== undefined &&
                this.device !== snapshot.device
            ) {
                void this.acquire();
                return;
            }
            this.stopEpoch = Number.isSafeInteger(snapshot.stopEpoch)
                ? snapshot.stopEpoch
                : undefined;
            this.device = snapshot.device!;
            if (focusVersion === this.focusVersion) this.focus = toViewFocus(snapshot);
            const warps = snapshot.warps.map((raw) => toViewWarp(raw, snapshot.device!));
            this.setState({
                kind: 'ready',
                snapshot: {
                    device: {
                        id: snapshot.device!,
                        name: typeof snapshot.deviceName === 'string' ? snapshot.deviceName : null
                    },
                    warps,
                    focus: this.focus
                }
            });
        } catch (error) {
            if (this.isCurrentAcquisition(generation, context))
                this.setState({ kind: 'error', message: errorText(error) });
        } finally {
            if (this.acquisition === operation) this.acquisition = undefined;
        }
    }

    private async refreshFocusFromDebugger(): Promise<void> {
        const context = this.context;
        if (context?.kind !== 'stopped') return;
        const version = ++this.focusVersion;
        this.focusQueryPending = true;
        // Keep the last confirmed marker until the query confirms a replacement.
        try {
            const snapshot = readAdapterSnapshot(
                await this.request(context.sessionId, CudaDebugProtocol.Request.cudaWarps, {
                    focusOnly: true
                })
            );
            if (
                this.disposed ||
                !this.visible ||
                this.context !== context ||
                version !== this.focusVersion
            )
                return;
            this.focusQueryPending = false;
            if (snapshot.unavailableReason) {
                this.cancelAcquisition();
                this.generation++;
                this.setState({ kind: 'unavailable', message: snapshot.unavailableReason });
                return;
            }
            const changedDevice = this.device !== undefined && this.device !== snapshot.device;
            this.device = snapshot.device;
            this.focus = toViewFocus(snapshot);
            if (changedDevice || this.state.kind === 'unavailable') {
                this.pendingFocusChange = undefined;
                this.focusError = undefined;
                await this.acquire();
            } else if (this.state.kind === 'ready') {
                this.setState({
                    ...this.state,
                    snapshot: { ...this.state.snapshot, focus: this.focus }
                });
            }
        } catch (error) {
            if (
                this.disposed ||
                !this.visible ||
                this.context !== context ||
                version !== this.focusVersion
            )
                return;
            this.focusQueryPending = false;
            if (this.pendingFocusChange && this.state.kind === 'ready') {
                this.focus = null;
                this.focusError = `Cannot confirm CUDA focus: ${errorText(error)}`;
                this.setState({ ...this.state, snapshot: { ...this.state.snapshot, focus: null } });
            } else {
                this.cancelAcquisition();
                this.generation++;
                this.setState({
                    kind: 'error',
                    message: `Cannot establish CUDA focus: ${errorText(error)}`
                });
            }
        }
    }
}
