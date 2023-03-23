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

// eslint-disable-next-line max-classes-per-file
import * as ua from 'universal-analytics';
import * as uuid from 'uuid';
import * as vscode from 'vscode';
import { logger } from '@vscode/debugadapter';

import * as types from './debugger/types';

abstract class CustomDimension {
    static readonly platform: string = 'cd1';

    static readonly architecture: string = 'cd2';

    static readonly distribution: string = 'cd3';

    static readonly distributionVersion: string = 'cd4';

    static readonly location: string = 'cd5';

    static readonly gpuName: string = 'cd6';

    static readonly gpuDescription: string = 'cd7';

    static readonly gpuSmType: string = 'cd8';
}

type TelemetryParams = { [dim: string]: string | undefined };

type TelemetrySessionControl = 'start' | 'end';

export type TelemetryLocation = 'host' | 'debug-adapter';

export class TelemetryService {
    private visitor: ua.Visitor;

    private isTelemetryEnabled = false;

    private static readonly CLIENT_ID_KEY = 'nsight.telemetryClientId';

    private static readonly TELEMETRY_CONFIG_ID = 'telemetry';

    private static readonly TELEMETRY_CONFIG_ENABLED_ID = 'enableTelemetry';

    constructor(context: vscode.ExtensionContext, trackingId: string, extensionName: string, extensionVersion: string) {
        let clientId: string | undefined = context.globalState.get<string>(TelemetryService.CLIENT_ID_KEY);
        if (!clientId) {
            clientId = uuid.v4();
            context.globalState.update(TelemetryService.CLIENT_ID_KEY, clientId);
        }

        const version: string = parseMajorMinorVersion(extensionVersion);

        // Create a visitor and set persistent parameters that will be
        // included in every tracking call. For more info on parameters see:
        //
        // https://developers.google.com/analytics/devguides/collection/protocol/v1/parameters

        this.visitor = ua(trackingId, clientId);
        this.visitor.set('aip', '1');
        this.visitor.set('an', extensionName);
        this.visitor.set('av', version);
        this.visitor.set('ds', 'app');
        this.visitor.set('ul', vscode.env.language);

        this.updateTelemetryEnabled();

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(() => {
                this.updateTelemetryEnabled();
            })
        );
    }

    get isEnabled(): boolean {
        return this.isTelemetryEnabled;
    }

    startSession(label: string): void {
        this.sendSessionEvent('start', label);
    }

    endSession(label: string): void {
        this.sendSessionEvent('end', label);
    }

    private sendSessionEvent(sessionControl: TelemetrySessionControl, label: string): void {
        this.sendEvent({
            category: 'session',
            action: 'control',
            label,
            value: sessionControl,
            params: {
                sc: sessionControl
            }
        });
    }

    trackError(errorName: string, errorMessage: string): void {
        this.sendEvent({
            category: 'session',
            action: 'error',
            label: errorName,
            value: errorMessage
        });
    }

    trackExit(code: number | undefined, signal: string | undefined): void {
        const codeValue: string | undefined = code ? code.toString() : undefined;
        this.sendEvent({
            category: 'session',
            action: 'exit',
            label: signal,
            value: codeValue
        });
    }

    trackCommand(commandName: string): CommandTracker {
        // eslint-disable-next-line @typescript-eslint/no-this-alias, no-underscore-dangle
        const _this = this;

        type CommandTrackerStatus = 'initiated' | 'canceled' | 'completed';

        let trackerStatus: CommandTrackerStatus = 'initiated';
        let trackerReason = '';

        const tracker: CommandTracker = {
            cancel(reason: string): void {
                trackerStatus = 'canceled';
                trackerReason = reason;
            },

            complete(): void {
                trackerStatus = 'completed';
                trackerReason = '';
            },

            dispose(): void {
                _this.sendEvent({
                    category: 'command',
                    action: commandName,
                    label: trackerStatus,
                    value: trackerReason
                });
            }
        };

        return tracker;
    }

    trackSystemInfo(location: TelemetryLocation, label: string, systemInfo?: types.SystemInfo): void {
        const locationParams = TelemetryService.getLocationParams(location);
        const osParams = TelemetryService.getOsParams(systemInfo?.os);

        const category = 'info';
        const action = 'system';

        if (!systemInfo?.gpus || systemInfo?.gpus?.length === 0) {
            const params = { ...locationParams, ...osParams };
            this.sendEvent({
                category,
                action,
                label,
                params
            });
        } else {
            // eslint-disable-next-line no-restricted-syntax
            for (const gpuInfo of systemInfo?.gpus) {
                const gpuParams = TelemetryService.getGpuParams(gpuInfo);
                const params = { ...locationParams, ...osParams, ...gpuParams };

                this.sendEvent({
                    category,
                    action,
                    label,
                    params
                });
            }
        }
    }

    // prettier-ignore
    private sendEvent({
        category = '',
        action = '',
        label = '',
        value = '',
        params = {}
    } = {}): void {

        if (!this.isTelemetryEnabled) {
            return;
        }

        if (!category || !action) {
            logger.verbose('Telemetry events must include at least a category and an action.');
            return;
        }

        this.visitor.event(category, action, label, value, params).send();
    }

    private static getLocationParams(location: TelemetryLocation): TelemetryParams {
        return {
            [CustomDimension.location]: location
        };
    }

    private static getOsParams(osInfo?: types.OsInfo): TelemetryParams {
        return {
            [CustomDimension.platform]: osInfo?.platform,
            [CustomDimension.architecture]: osInfo?.architecture,
            [CustomDimension.distribution]: osInfo?.distribution,
            [CustomDimension.distributionVersion]: osInfo?.distributionVersion
        };
    }

    private static getGpuParams(gpuInfo?: types.GpuInfo): TelemetryParams {
        return {
            [CustomDimension.gpuName]: gpuInfo?.name,
            [CustomDimension.gpuDescription]: gpuInfo?.description,
            [CustomDimension.gpuSmType]: gpuInfo?.smType
        };
    }

    private updateTelemetryEnabled(): void {
        const telemetryConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(TelemetryService.TELEMETRY_CONFIG_ID);
        this.isTelemetryEnabled = telemetryConfig.get<boolean>(TelemetryService.TELEMETRY_CONFIG_ENABLED_ID, false);
    }
}

export interface CommandTracker extends vscode.Disposable {
    cancel(reason: string): void;

    complete(): void;

    dispose(): void;
}

function parseMajorMinorVersion(extensionVersion: string): string {
    const matches = extensionVersion.match(/^\d+\.\d+/);
    if (!matches || matches.length === 0) {
        return '';
    }

    return matches[0];
}
