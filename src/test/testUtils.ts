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

import assert from 'node:assert/strict';
import { type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { type DebugProtocol } from '@vscode/debugprotocol';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { CudaDebugClient, type StopLocationInfo } from './cudaDebugClient';
import { type CudaLaunchRequestArguments } from '../debugger/cudaGdbSession';
import { expect } from '@jest/globals';
import { fileURLToPath } from 'node:url';

export { type StopLocationInfo } from './cudaDebugClient';

export interface StoppedContext {
    threadId: number;
    frameId: number;
    actLocals: Map<string, DebugProtocol.Variable>;
}

export interface LineNumbers {
    [marker: string]: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TestUtils {
    static readonly localScopeName = 'Local';

    static getDebugAdapterPath(): string {
        const debugAdapterPath = path.resolve(__dirname, '../../dist/debugAdapter.js');
        expect(fs.existsSync(debugAdapterPath)).toBe(true);
        return debugAdapterPath;
    }

    public static resolveTestPath(testPath: string): string {
        const searchPaths = ['../../src/test/testPrograms', '../src/test/testPrograms'];

        const testProgDirEnvVar = process.env.TEST_PROG_DIR;
        if (testProgDirEnvVar) {
            searchPaths.push(testProgDirEnvVar);
        }

        for (const searchPath of searchPaths) {
            const testProgramsDir = path.resolve(__dirname, searchPath);
            const resolvedTestPath = path.resolve(testProgramsDir, testPath);

            if (fs.existsSync(resolvedTestPath)) {
                return resolvedTestPath;
            }
        }

        throw new Error(`Unable to resolve test path "${testPath}"`);
    }

    static getTestProgram(programName: string): string {
        return this.resolveTestPath(programName);
    }

    /** For each lineNumber in programName that has a comment of the form
     *
     *  /*@someMarker*
     *
     * the returned object will contain {"someMarker": lineNumber}.
     */
    static getLineNumbersFromComments(fileName: string): LineNumbers {
        const filePath = this.resolveTestPath(fileName);
        const lines = fs.readFileSync(filePath, 'utf8').split('\n');
        const lineNumbers: LineNumbers = {};
        for (const [i, line] of lines.entries()) {
            const { marker } = /\/\*@(?<marker>.+?)\*/.exec(line)?.groups ?? {};
            if (marker !== undefined) {
                lineNumbers[marker] = i + 1;
            }
        }
        return lineNumbers;
    }

    static getTestSource(fileName: string): DebugProtocol.Source {
        return {
            name: fileName,
            path: TestUtils.getTestProgram(fileName)
        };
    }

    static async createDebugClient(spawnOptions?: SpawnOptions): Promise<CudaDebugClient> {
        const debugAdapterPath = TestUtils.getDebugAdapterPath();

        const dc = new CudaDebugClient(debugAdapterPath, spawnOptions);

        await dc.start();
        const initResp = await dc.initializeRequest();

        expect(initResp.success).toBe(true);
        assert(initResp.body);

        dc.capabilities = initResp.body;
        return dc;
    }

    static async getLaunchArguments(testProgram: string, args?: string): Promise<CudaLaunchRequestArguments> {
        const testProgramPath = TestUtils.getTestProgram(testProgram);
        const logFilePath = path.resolve(path.dirname(testProgramPath), '.rubicon_log');

        return {
            program: testProgramPath,
            args,
            verboseLogging: true,
            logFile: logFilePath,
            onAPIError: 'stop'
        };
    }

    static async launchDebugger(testProgram: string, args?: string): Promise<CudaDebugClient> {
        const dc = await this.createDebugClient();
        const launchArguments = await this.getLaunchArguments(testProgram, args);

        await dc.launchRequest(launchArguments);

        return dc;
    }

    static async assertStoppedLocation(dc: CudaDebugClient, reason: string, file: string, line: number, timeout?: number): Promise<StopLocationInfo> {
        return dc.expectToStopAt(reason, file, line, timeout, async () => {});
    }

    static async getLocals(dc: DebugClient, frameId: number): Promise<Map<string, DebugProtocol.Variable>> {
        const localsScopeReference = await this.getLocalsScopeReference(dc, frameId);
        const locals = await this.getChildren(dc, localsScopeReference);
        return locals;
    }

    static async getLocalsAsObject(dc: DebugClient, frameId: number): Promise<{ [name: string]: DebugProtocol.Variable }> {
        const localsScopeReference = await this.getLocalsScopeReference(dc, frameId);
        const locals = await this.getChildrenAsObject(dc, localsScopeReference);
        return locals;
    }

    static async getLocalsScopeReference(dc: DebugClient, frameId: number): Promise<number> {
        const scopesResp = await dc.scopesRequest({ frameId });
        const { scopes } = scopesResp.body;

        const localScope = scopes.find((s) => s.name === TestUtils.localScopeName);
        assert(localScope);

        return localScope.variablesReference;
    }

    static async getChildren(dc: DebugClient, variablesReference: number): Promise<Map<string, DebugProtocol.Variable>> {
        const vars = new Map<string, DebugProtocol.Variable>();

        const variablesResp = await dc.variablesRequest({
            variablesReference
        });

        for (const v of variablesResp.body.variables) {
            vars.set(v.name, v);
        }

        return vars;
    }

    static async getChildrenAsObject(dc: DebugClient, variablesReference: number): Promise<{ [name: string]: DebugProtocol.Variable }> {
        const vars: { [name: string]: DebugProtocol.Variable } = {};
        const variablesResp = await dc.variablesRequest({ variablesReference });
        for (const v of variablesResp.body.variables) {
            vars[v.name] = v;
        }
        return vars;
    }

    static readonly defaultVerifyLocalsTimeout = 120_000;

    static async verifyLocalsOnStop(
        dc: CudaDebugClient,
        source: string,
        line: number,
        stopReason: string,
        expLocals: {
            name: string;
            value?: string;
        }[],
        allowOthers?: boolean | undefined,
        stopTimeout?: number
    ): Promise<StoppedContext> {
        const { threadId, frameId } = await TestUtils.assertStoppedLocation(dc, stopReason, source, line, stopTimeout ?? TestUtils.defaultVerifyLocalsTimeout);

        const actual = await TestUtils.getLocals(dc, frameId);

        if (allowOthers === false) {
            expect(actual.size).toEqual(expLocals.length);
        }

        for (const v of expLocals) {
            const local = actual.get(v.name);
            assert(local);

            if (v.value) {
                expect(local.value).toEqual(v.value);
            }
        }

        return { threadId, frameId, actLocals: actual };
    }
}
