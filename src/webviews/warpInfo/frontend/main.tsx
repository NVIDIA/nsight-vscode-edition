/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { WarpViewState, FocusTarget, ViewPreferences } from '../model';
import { WarpInfo } from './warpInfo';
import './warpInfo.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

function App(): ReactElement {
    const [{ state, displayed }, setView] = useState<{
        state: WarpViewState;
        displayed: Extract<WarpViewState, { kind: 'ready' }> | null;
    }>({ state: { kind: 'no-session', revision: 0 }, displayed: null });
    useEffect(() => {
        const receive = ({ data }: MessageEvent): void => {
            if (data?.type !== 'state' || !Number.isSafeInteger(data.state?.revision)) return;
            const value: WarpViewState = data.state;
            if (
                !['no-session', 'running', 'loading', 'unavailable', 'error', 'ready'].includes(
                    value.kind
                )
            )
                return;
            if (
                value.kind === 'ready' &&
                (!Array.isArray(value.snapshot?.warps) ||
                    !Number.isSafeInteger(value.snapshot?.device?.id))
            )
                return;
            if (
                (value.kind === 'error' || value.kind === 'unavailable') &&
                typeof value.message !== 'string'
            )
                return;
            setView((previous) => ({
                state: value,
                // Retain only a visual backdrop; current debugger state remains authoritative.
                displayed:
                    value.kind === 'ready'
                        ? value
                        : (value.kind === 'running' || value.kind === 'loading') &&
                            value.sessionId === previous.displayed?.sessionId &&
                            (value.deviceId === undefined ||
                                value.deviceId === previous.displayed?.snapshot.device.id)
                          ? previous.displayed
                          : null
            }));
        };
        window.addEventListener('message', receive);
        vscode.postMessage({ type: 'ready' });
        return () => window.removeEventListener('message', receive);
    }, []);
    const retry = (selection?: { sm: number; warp: number }): void =>
        vscode.postMessage({ type: 'retry', revision: state.revision, selection });
    const focusLane = (target: FocusTarget): void => {
        if (state.kind === 'ready')
            vscode.postMessage({ type: 'focus', revision: state.revision, target });
    };
    const preferences = (value: ViewPreferences): void =>
        vscode.postMessage({ type: 'preferences', sessionId: state.sessionId, preferences: value });
    const message =
        state.kind === 'no-session'
            ? 'No active CUDA debug session.'
            : state.kind === 'running'
              ? 'Running. Pause at a CUDA stop to inspect warps.'
              : state.kind === 'loading'
                ? 'Loading warp and lane data…'
                : state.kind === 'ready'
                  ? undefined
                  : state.message;
    const stale = displayed !== null && state.kind !== 'ready';
    // The session key preserves local controls across stops and resets them on session switches.
    return (
        <>
            <div inert={stale}>
                <WarpInfo
                    key={state.sessionId ?? 'no-session'}
                    snapshot={displayed?.snapshot ?? null}
                    stale={stale}
                    message={message}
                    loading={state.kind === 'loading'}
                    stopId={displayed?.stopId ?? state.stopId}
                    deviceId={state.deviceId}
                    initialPreferences={state.preferences}
                    onPreferences={preferences}
                    pendingFocus={state.pendingFocus}
                    focusBlocked={state.focusBlocked || stale}
                    focusError={state.focusError}
                    onFocusLane={focusLane}
                    retrying={state.kind === 'ready' && state.retrying}
                    onRetry={state.kind === 'ready' || state.kind === 'error' ? retry : undefined}
                />
            </div>
            {stale && (
                <div className="stale-overlay loading-state" role="status">
                    {state.kind === 'loading' && (
                        <span className="loading-spinner" aria-hidden="true" />
                    )}
                    <p>
                        {state.kind === 'running'
                            ? 'Running. Showing previous stop.'
                            : 'Updating warp and lane data…'}
                    </p>
                    {state.kind === 'loading' && <p>Showing previous stop.</p>}
                </div>
            )}
        </>
    );
}

const element = document.querySelector('#warp-info-root');
if (!element) throw new Error('Warp Info root is missing.');
createRoot(element).render(<App />);
