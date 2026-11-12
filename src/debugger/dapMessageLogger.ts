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

import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { type DebugProtocol } from '@vscode/debugprotocol';

const LOG_DIR_SEGMENTS = ['nsight-vscode-edition', 'daplogs'];
const SLOW_MESSAGE_THRESHOLD_MS = 2000;

// Requests whose round-trip time is worth tracking. Others (e.g. 'initialize', 'launch',
// 'configurationDone') are one-offs or not latency-sensitive, so we don't bother timing them.
const TIMED_REQUEST_COMMANDS = new Set([
    'setBreakpoints',
    'setFunctionBreakpoints',
    'setExceptionBreakpoints',
    'threads',
    'stackTrace',
    'evaluate',
    'pause',
    'stepIn',
    'next',
    'stepOut'
]);

export enum DapMessageDirection {
    toAdapter = 'CLIENT -> ADAPTER',
    fromAdapter = 'ADAPTER -> CLIENT'
}

interface PendingRequest {
    command: string;
    startTime: number;
}

interface SlowRequest {
    command: string;
    elapsedMs: number;
}

function getMessageName(message: DebugProtocol.ProtocolMessage): string {
    switch (message.type) {
        case 'request': {
            return (message as DebugProtocol.Request).command;
        }
        case 'response': {
            return (message as DebugProtocol.Response).command;
        }
        case 'event': {
            return (message as DebugProtocol.Event).event;
        }
        default: {
            return message.type;
        }
    }
}

/**
 * Visually distinguishes the four kinds of DAP traffic:
 *   request          (client -> adapter): ---> <request_name> eg. setBreakpoints
 *   response         (adapter -> client): <--- <response_name> eg. setBreakpoints
 *   event            (adapter -> client): <=== <event_name> eg. stopped
 *   reverse request  (adapter -> client): <=== <request_name> eg. runInTerminal
 * Reverse requests share the event marker since both are adapter-initiated;
 * the JSON payload (a 'command' field vs an 'event' field) disambiguates them.
 */
function getMessageHeader(
    direction: DapMessageDirection,
    message: DebugProtocol.ProtocolMessage
): string {
    let header = '';
    if (direction === DapMessageDirection.toAdapter) {
        header = '---> ';
    } else {
        header = message.type === 'response' ? '<--- ' : '<=== ';
    }

    return header + getMessageName(message);
}

function formatTimestampForFilename(date: Date): string {
    // Replace ':' and '.' since they aren't valid in filenames on Windows.
    return date.toISOString().replaceAll(/[:.]/g, '-');
}

/**
 * Computes (but does not create) the path this session's DAP log should be written to. Callers
 * generate this as early as possible — e.g. when the debug adapter descriptor is created, before
 * the DapMessageLogger itself exists — and pass the same path through to DapMessageLogger so the
 * final destination is known and can be surfaced even before the file is actually opened.
 */
export function generateDapLogFilePath(sessionId: string): string {
    const logDir = path.join(os.tmpdir(), ...LOG_DIR_SEGMENTS);
    return path.join(
        logDir,
        `${formatTimestampForFilename(new Date())}-${sessionId.slice(0, 8)}.log`
    );
}

/**
 * Logs Debug Adapter Protocol traffic for a single debug session to a log file under the OS
 * temp directory. One instance is owned per CudaDebugAdapterTracker/session, since VS Code
 * allows multiple concurrent debug sessions.
 */
export class DapMessageLogger {
    private stream: fs.WriteStream | undefined;

    private readonly pendingRequests = new Map<number, PendingRequest>();

    private readonly slowRequests: SlowRequest[] = [];

    constructor(
        private readonly sessionId: string,
        private readonly sessionName: string,
        private readonly filePath: string
    ) {}

    start(): void {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });

            this.stream.write(
                `=== DAP log started for session '${this.sessionName}' (${this.sessionId}) ===\n\n`
            );
        } catch {
            // No log file this session; logMessage()/end() below just become no-ops.
        }
    }

    end(): void {
        if (this.stream) {
            this.stream.write(`=== DAP log ended ===\n`);
            this.stream.end();
        }

        this.stream = undefined;
        this.pendingRequests.clear();
    }

    logMessage(direction: DapMessageDirection, message: DebugProtocol.ProtocolMessage): void {
        if (!this.stream) {
            return;
        }

        const timestamp = new Date().toISOString();
        const header = getMessageHeader(direction, message);
        this.stream.write(`[${timestamp}] ${header}\n${JSON.stringify(message)}\n\n`);

        this.trackRequestTiming(message);
    }

    // Records a non-protocol event (an adapter fault or exit) alongside the DAP traffic.
    logNote(note: string): void {
        if (!this.stream) {
            return;
        }

        this.stream.write(`[${new Date().toISOString()}] ${note}\n\n`);
    }

    private trackRequestTiming(message: DebugProtocol.ProtocolMessage): void {
        if (message.type === 'request') {
            const request = message as DebugProtocol.Request;
            if (!TIMED_REQUEST_COMMANDS.has(request.command)) {
                return;
            }

            this.pendingRequests.set(request.seq, {
                command: request.command,
                startTime: Date.now()
            });
        } else if (message.type === 'response') {
            const response = message as DebugProtocol.Response;
            const requestInfo = this.pendingRequests.get(response.request_seq);
            if (!requestInfo) {
                return;
            }

            this.pendingRequests.delete(response.request_seq);

            const elapsedMs = Date.now() - requestInfo.startTime;
            if (elapsedMs > SLOW_MESSAGE_THRESHOLD_MS) {
                this.slowRequests.push({ command: requestInfo.command, elapsedMs });
            }
        }
    }
}
