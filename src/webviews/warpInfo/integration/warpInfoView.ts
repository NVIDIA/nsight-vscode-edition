/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import * as vscode from 'vscode';
import type { CudaDebugProtocol } from '../../../debugger/cudaDebugProtocol';
import type { CudaDebugSessionMonitor } from '../../../debugger/cudaDebugSessionMonitor';
import { WarpInfoController } from './controller';
import { createWarpInfoHtml } from './html';
import type { WarpViewState } from '../model';

export function registerWarpInfoView(
    context: vscode.ExtensionContext,
    sessionMonitor: CudaDebugSessionMonitor,
    sendRequest: CudaDebugProtocol.SendRequest
): void {
    const assets = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'warpInfo');
    let current: vscode.WebviewView | undefined;
    let ready = false;
    let displayedContext: { sessionId?: string; deviceId: number } | undefined;
    let deferredInvalidation: WarpViewState | undefined;
    const publish = (state: WarpViewState): void => {
        if (!current || !ready) return;
        const invalidatesDisplayed =
            displayedContext &&
            (state.sessionId !== displayedContext.sessionId ||
                (state.deviceId !== undefined && state.deviceId !== displayedContext.deviceId) ||
                state.kind === 'unavailable' ||
                state.kind === 'error' ||
                state.kind === 'no-session');
        if (!current.visible) {
            if (invalidatesDisplayed) deferredInvalidation ??= state;
            return;
        }
        // A retained document must observe invalidation even if Loading has since replaced it.
        if (deferredInvalidation) {
            void current.webview.postMessage({ type: 'state', state: deferredInvalidation });
            deferredInvalidation = undefined;
            displayedContext = undefined;
        }
        if (state.kind === 'ready')
            displayedContext = { sessionId: state.sessionId, deviceId: state.snapshot.device.id };
        else if (invalidatesDisplayed) displayedContext = undefined;
        void current.webview.postMessage({ type: 'state', state });
    };
    // The controller and its stopped snapshot outlive individual webview documents.
    const controller = new WarpInfoController(sessionMonitor, sendRequest, publish);

    function handleMessage(view: vscode.WebviewView, message: unknown): void {
        if (current !== view || !message || typeof message !== 'object') return;
        const data = message as Record<string, unknown>;
        if (data.type === 'ready') {
            ready = true;
            controller.setVisible(view.visible);
            publish(controller.state);
        } else if (data.type === 'preferences' && typeof data.sessionId === 'string') {
            controller.savePreferences(data.sessionId, data.preferences);
        } else if (data.type === 'focus' && Number.isSafeInteger(data.revision)) {
            const target = data.target as { sm: number; warp: number; lane: number } | undefined;
            if (
                target &&
                [target.sm, target.warp, target.lane].every(
                    (n) => Number.isSafeInteger(n) && n >= 0
                ) &&
                target.lane < 32
            )
                void controller.focusLane(data.revision as number, target);
        } else if (data.type === 'retry' && Number.isSafeInteger(data.revision)) {
            const selection = data.selection as { sm?: unknown; warp?: unknown } | undefined;
            if (
                selection !== undefined &&
                (!selection ||
                    !Number.isSafeInteger(selection.sm) ||
                    !Number.isSafeInteger(selection.warp))
            )
                return;
            void controller.retry(
                data.revision as number,
                selection as { sm: number; warp: number } | undefined
            );
        }
    }

    context.subscriptions.push(
        controller,
        vscode.window.registerWebviewViewProvider(
            'cuda.warpInfo',
            {
                resolveWebviewView(view): void {
                    current = view;
                    displayedContext = undefined;
                    deferredInvalidation = undefined;
                    const { webview } = view;
                    webview.options = {
                        enableScripts: true,
                        enableForms: false,
                        localResourceRoots: [assets]
                    };
                    const messages = webview.onDidReceiveMessage((message: unknown) =>
                        handleMessage(view, message)
                    );
                    const visibility = view.onDidChangeVisibility(() => {
                        if (current !== view) return;
                        controller.setVisible(view.visible);
                        publish(controller.state);
                    });
                    view.onDidDispose(() => {
                        messages.dispose();
                        visibility.dispose();
                        if (current === view) {
                            current = undefined;
                            ready = false;
                            controller.setVisible(false);
                            controller.resetView();
                        }
                    });
                    ready = false;
                    controller.setVisible(false);
                    controller.resetView();
                    webview.html = createWarpInfoHtml(
                        webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.js')).toString(),
                        webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.css')).toString(),
                        webview.cspSource
                    );
                    // Acquire while the document loads; the ready message publishes cached state.
                    controller.setVisible(view.visible);
                }
            },
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );
}
