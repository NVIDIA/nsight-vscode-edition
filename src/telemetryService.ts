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
import axios from 'axios';
import * as uuid from 'uuid';
import * as vscode from 'vscode';

import * as types from './debugger/types';

export type TelemetryLocation = 'host' | 'debug-adapter';

type ActivityStartEvent = {
    name: 'activity_start';
    params: {
        name: string;
    };
};

type ActivityEndEvent = {
    name: 'activity_end';
    params: {
        name: string;
    };
};

type AdapterExitEvent = {
    name: 'adapter_exit';
    params: {
        code?: number;
        signal?: string;
    };
};

type ErrorEvent = {
    name: 'error';
    params: {
        name: string;
        message: string;
    };
};

type ExecCommandEvent = {
    name: 'exec_command';
    params: {
        name: string;
        status: string;
        reason?: string;
    };
};

type GpuInfoEvent = {
    name: 'gpu_info';
    params: {
        location: TelemetryLocation;
        name?: string;
        description?: string;
        sm_type?: string;
        name_by_os?: string;
    };
};

type OsInfoEvent = {
    name: 'os_info';
    params: {
        location: TelemetryLocation;
        platform?: string;
        architecture?: string;
        distribution?: string;
        distribution_version?: string;
    };
};

type CustomEvent = ActivityStartEvent | ActivityEndEvent | AdapterExitEvent | ErrorEvent | ExecCommandEvent | GpuInfoEvent | OsInfoEvent;

type Event = CustomEvent & {
    params: {
        session_id?: number;
        engagement_time_msec?: number;
        debug_mode?: boolean;
        traffic_type?: string;
    };
};

type UserProperties = {
    [key: string]: {
        value: string | number;
    };
};

type Payload = {
    client_id: string;
    events: Event[];
    user_properties: UserProperties;
};

class TelemetryClient {
    private readonly clientID: string;

    private readonly endpoint: string;

    private readonly userProperties: UserProperties = {};

    private sessionStartMs: number | undefined = undefined;

    private lastEngagementMs: number | undefined = undefined;

    GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

    NV_DEVTOOLS_UXT_DEBUG = 'NV_DEVTOOLS_UXT_DEBUG';

    NV_DEVTOOLS_UXT_ROLE = 'NV_DEVTOOLS_UXT_ROLE';

    NV_DEVTOOLS_QA_ROLE = 'internal-qa';

    isEnabled = false;

    isDebugMode = false;

    isInternal = false;

    constructor(clientID: string, apiSecret: string, measurementID: string) {
        this.clientID = clientID;
        this.endpoint = `${this.GA4_ENDPOINT}?api_secret=${apiSecret}&measurement_id=${measurementID}`;

        if (process.env[this.NV_DEVTOOLS_UXT_DEBUG]) {
            this.isDebugMode = true;
        }

        if (process.env[this.NV_DEVTOOLS_UXT_ROLE] === this.NV_DEVTOOLS_QA_ROLE) {
            this.isInternal = true;
        }
    }

    addUserProperty(name: string, value: string | number): void {
        this.userProperties[name] = {
            value
        };
    }

    sendEvent<T extends Event>(event: T): void {
        this.sendEvents([event]);
    }

    sendEvents(events: Event[]): void {
        if (!this.isEnabled) {
            return;
        }

        if (!this.sessionStartMs) {
            this.sessionStartMs = Date.now();
        }

        const engagementTimeMs: number = (() => {
            if (!this.lastEngagementMs) {
                this.lastEngagementMs = this.sessionStartMs;
                return 0;
            }

            const currentTimeMs = Date.now();
            const elapsedTimeMs = currentTimeMs - this.lastEngagementMs;
            this.lastEngagementMs = currentTimeMs;

            return elapsedTimeMs;
        })();

        // eslint-disable-next-line no-restricted-syntax
        for (const event of events) {
            event.params.session_id = this.sessionStartMs;
            event.params.engagement_time_msec = engagementTimeMs;

            if (this.isDebugMode) {
                event.params.debug_mode = true;
            }

            if (this.isInternal) {
                event.params.traffic_type = 'internal';
            }
        }

        const payload: Payload = {
            client_id: this.clientID,
            events,
            user_properties: this.userProperties
        };

        axios.post(this.endpoint, payload);
    }
}

export class TelemetryService {
    private readonly client: TelemetryClient;

    private static readonly CLIENT_ID_KEY = 'nsight.telemetryClientId';

    private static readonly TELEMETRY_CONFIG_ID = 'telemetry';

    private static readonly TELEMETRY_CONFIG_LEVEL = 'telemetryLevel';

    constructor(context: vscode.ExtensionContext, apiSecret: string, measurementID: string, extensionVersion: string) {
        let clientID: string | undefined = context.globalState.get<string>(TelemetryService.CLIENT_ID_KEY);
        if (!clientID) {
            clientID = uuid.v4();
            context.globalState.update(TelemetryService.CLIENT_ID_KEY, clientID);
        }

        this.client = new TelemetryClient(clientID, apiSecret, measurementID);

        const version: string = parseMajorMinorVersion(extensionVersion);
        this.client.addUserProperty('app_version', version);

        this.updateTelemetryEnabled();
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(() => {
                this.updateTelemetryEnabled();
            })
        );
    }

    get isEnabled(): boolean {
        return this.client.isEnabled;
    }

    set isEnabled(value: boolean) {
        this.client.isEnabled = value;
    }

    startSession(name: string): void {
        this.client.sendEvent<ActivityStartEvent>({
            name: 'activity_start',
            params: {
                name
            }
        });
    }

    endSession(name: string): void {
        this.client.sendEvent<ActivityEndEvent>({
            name: 'activity_end',
            params: {
                name
            }
        });
    }

    trackError(name: string, message: string): void {
        this.client.sendEvent<ErrorEvent>({
            name: 'error',
            params: {
                name,
                message
            }
        });
    }

    trackExit(code: number | undefined, signal: string | undefined): void {
        this.client.sendEvent<AdapterExitEvent>({
            name: 'adapter_exit',
            params: {
                code,
                signal
            }
        });
    }

    trackCommand(name: string): CommandTracker {
        // eslint-disable-next-line @typescript-eslint/no-this-alias, no-underscore-dangle
        const _this = this;

        type CommandTrackerStatus = 'initiated' | 'canceled' | 'completed';

        let status: CommandTrackerStatus = 'initiated';
        let reason: string | undefined;

        const tracker: CommandTracker = {
            cancel(cancelReason: string): void {
                status = 'canceled';
                reason = cancelReason;
            },

            complete(): void {
                status = 'completed';
            },

            dispose(): void {
                _this.client.sendEvent<ExecCommandEvent>({
                    name: 'exec_command',
                    params: {
                        name,
                        status,
                        reason
                    }
                });
            }
        };

        return tracker;
    }

    trackSystemInfo(location: TelemetryLocation, systemInfo?: types.SystemInfo): void {
        const events: Event[] = [];

        if (systemInfo?.os) {
            events.push({
                name: 'os_info',
                params: {
                    location,
                    platform: systemInfo?.os?.platform,
                    architecture: systemInfo?.os?.architecture,
                    distribution: systemInfo?.os?.distribution,
                    distribution_version: systemInfo?.os?.distributionVersion
                }
            } as OsInfoEvent);
        }

        if (systemInfo?.gpus?.length) {
            // eslint-disable-next-line no-restricted-syntax
            for (const gpu of systemInfo.gpus) {
                events.push({
                    name: 'gpu_info',
                    params: {
                        location,
                        name: gpu.name,
                        description: gpu.description,
                        sm_type: gpu.smType,
                        name_by_os: `${gpu.name}: ${systemInfo?.os?.platform}`
                    }
                } as GpuInfoEvent);
            }
        }

        this.client.sendEvents(events);
    }

    private updateTelemetryEnabled(): void {
        const telemetryConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(TelemetryService.TELEMETRY_CONFIG_ID);
        this.isEnabled = !(telemetryConfig[TelemetryService.TELEMETRY_CONFIG_LEVEL] === 'off');
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
