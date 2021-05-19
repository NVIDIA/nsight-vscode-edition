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

import * as fse from 'fs-extra';
import { logger } from 'vscode-debugadapter';
import { createInterface } from 'readline';

import * as types from './types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function assertNever(value: never): never {
    throw new Error(`Unexpected value: '${value}'`);
}

function formatCudaCoord(coord?: number): string {
    const formattedCoord = coord?.toString() ?? '?';
    return formattedCoord;
}

export function formatCudaDim(dim?: types.CudaDim): string {
    const x: string = formatCudaCoord(dim?.x);
    const y: string = formatCudaCoord(dim?.y);
    const z: string = formatCudaCoord(dim?.z);
    const formattedDim = `(${x}, ${y}, ${z})`;

    return formattedDim;
}

// eslint-disable-next-line consistent-return
export function formatCudaFocus(focus?: types.CudaFocus): string {
    const focusPrefix = 'CUDA:';

    if (!focus) {
        const undefDim: string = formatCudaDim();
        const formattedFocus = `${focusPrefix} ${undefDim} ${undefDim}`;

        return formattedFocus;
    }

    switch (focus?.type) {
        case 'software': {
            const formattedBlock: string = formatCudaDim(focus.blockIdx);
            const formattedThread: string = formatCudaDim(focus.threadIdx);
            const formattedFocus = `${focusPrefix} ${formattedBlock} ${formattedThread}`;

            return formattedFocus;
        }

        case 'hardware': {
            const sm: string = focus.sm?.toString() ?? '?';
            const warp: string = focus.warp?.toString() ?? '?';
            const lane: string = focus.lane?.toString() ?? '?';
            const formattedFocus = `${focusPrefix} sm ${sm} warp ${warp} lane ${lane}`;

            return formattedFocus;
        }

        default:
            assertNever(focus);
    }
}

export function parseCudaDim(input: string, name?: string): types.CudaDim | undefined {
    let dimExpr = String.raw`\(?(\d*)\s*(?:,?\s*(\d*)\s*(?:,?\s*(\d+))?)?\s*\)?`;
    if (name) {
        dimExpr = String.raw`(?:${name}\s*)` + dimExpr;
    }

    const matchGroupCount = 4;
    const matcher = new RegExp(dimExpr);
    const matches = matcher.exec(input);

    // There will be 4 elements in the matches array:
    //
    // [0]: Either matched expression or ''
    // [1]: x-value or ''
    // [2]: y-value or ''
    // [3]: z-value or ''

    if (!matches || matches.length !== matchGroupCount || !matches[0]) {
        // eslint-disable-next-line unicorn/no-useless-undefined
        return undefined;
    }

    // eslint-disable-next-line unicorn/consistent-function-scoping
    const parseCoord = (value: string): number | undefined => {
        const coord: number = Number.parseInt(value);
        return Number.isNaN(coord) ? undefined : coord;
    };

    const x: number | undefined = parseCoord(matches[1]);
    const y: number | undefined = parseCoord(matches[2]);
    const z: number | undefined = parseCoord(matches[3]);

    return { x, y, z };
}

function parseHwCoord(input: string, coordName: string): number | undefined {
    const expr = `${coordName}\\s+(\\d+)`;
    const regex = new RegExp(expr, 'i');
    const coordMatch = regex.exec(input);

    if (!coordMatch) {
        // eslint-disable-next-line unicorn/no-useless-undefined
        return undefined;
    }

    const coordStr: string = coordMatch[1];
    const coord: number = Number.parseInt(coordStr);

    return coord;
}

export function parseCudaHwFocus(focus: string): types.CudaHwFocus | undefined {
    if (!focus) {
        // eslint-disable-next-line unicorn/no-useless-undefined
        return undefined;
    }

    const sm: number | undefined = parseHwCoord(focus, 'sm');
    const warp: number | undefined = parseHwCoord(focus, 'warp');
    const lane: number | undefined = parseHwCoord(focus, 'lane');

    if (sm === undefined && warp === undefined && lane === undefined) {
        // eslint-disable-next-line unicorn/no-useless-undefined
        return undefined;
    }

    return { type: 'hardware', sm, warp, lane };
}

export function parseCudaSwFocus(focus: string): types.CudaSwFocus | undefined {
    if (!focus) {
        // eslint-disable-next-line unicorn/no-useless-undefined
        return undefined;
    }

    const blockIdx: types.CudaDim | undefined = parseCudaDim(focus, 'block');
    const threadIdx: types.CudaDim | undefined = parseCudaDim(focus, 'thread');

    if (blockIdx === undefined && threadIdx === undefined) {
        // eslint-disable-next-line unicorn/no-useless-undefined
        return undefined;
    }

    return { type: 'software', blockIdx, threadIdx };
}

export function equalsCudaDim(lhs?: types.CudaDim, rhs?: types.CudaDim): boolean {
    if (!lhs || !rhs) {
        return false;
    }

    // prettier-ignore
    const equals: boolean =
           lhs.x === rhs.x 
        && lhs.y === rhs.y
        && lhs.z === rhs.z;

    return equals;
}

export function equalsCudaFocus(lhs?: types.CudaFocus, rhs?: types.CudaFocus): boolean {
    if (!lhs || !rhs) {
        return false;
    }

    if (lhs.type === 'software' && rhs.type === 'software') {
        const equalsBlock = equalsCudaDim(lhs.blockIdx, rhs.blockIdx);
        const equalsThread = equalsCudaDim(lhs.threadIdx, rhs.threadIdx);
        const equals: boolean = equalsBlock && equalsThread;

        return equals;
    }

    if (lhs.type === 'hardware' && rhs.type === 'hardware') {
        // prettier-ignore
        const equals: boolean =
               lhs.sm === rhs.sm
            && lhs.warp === rhs.warp
            && lhs.lane === rhs.lane;

        return equals;
    }

    return false;
}

export function isCudaDimValid(dim?: types.CudaDim): boolean {
    if (!dim) {
        return false;
    }

    // prettier-ignore
    const isValid: boolean =
           dim.x !== undefined
        || dim.y !== undefined
        || dim.z !== undefined;

    return isValid;
}

// eslint-disable-next-line consistent-return
export function isCudaFocusValid(focus?: types.CudaFocus): boolean {
    if (!focus) {
        return false;
    }

    switch (focus.type) {
        case 'software': {
            const isBlockValid: boolean = isCudaDimValid(focus.blockIdx);
            const isThreadValid: boolean = isCudaDimValid(focus.threadIdx);
            const isValid: boolean = isBlockValid && isThreadValid;

            return isValid;
        }

        case 'hardware': {
            // prettier-ignore
            const isValid: boolean =
                   focus.sm !== undefined
                || focus.warp !== undefined
                || focus.lane !== undefined;

            return isValid;
        }

        default:
            assertNever(focus);
    }
}

export function formatSetDimCommand(name: string, dim?: types.CudaDim): string {
    if (!dim || dim.x === undefined) {
        return '';
    }

    let setFocusCommand = `${name} (${dim.x}`;

    if (dim.y !== undefined) {
        setFocusCommand += `, ${dim.y}`;

        if (dim.z !== undefined) {
            setFocusCommand += `, ${dim.z}`;
        }
    }

    setFocusCommand += ')';
    return setFocusCommand;
}

export function formatSetFocusCommand(focus?: types.CudaFocus): string {
    // TODO: Find MI command to switch focus or a way to suppress output message
    // Allow for partial focus change commands

    if (!focus) {
        return '';
    }

    let setFocusCommand = 'cuda';

    if (focus.type === 'software') {
        const setBlockCommand = formatSetDimCommand('block', focus.blockIdx);
        const setThreadCommand = formatSetDimCommand('thread', focus.threadIdx);
        setFocusCommand += ` ${setBlockCommand} ${setThreadCommand}`;
    } else if (focus.type === 'hardware') {
        if (focus?.sm !== undefined) {
            setFocusCommand += ` sm ${focus.sm}`;
        }

        if (focus?.warp !== undefined) {
            setFocusCommand += ` warp ${focus.warp}`;
        }

        if (focus?.lane !== undefined) {
            setFocusCommand += ` lane ${focus.lane}`;
        }
    } else {
        assertNever(focus);
    }

    return setFocusCommand;
}

async function readReleaseFile(releaseFile: string): Promise<Record<string, string>> {
    const fileStream: fse.ReadStream = fse.createReadStream(releaseFile);
    const fileInterface = createInterface({
        input: fileStream
    });

    try {
        const fileInfo: Record<string, string> = {};

        // eslint-disable-next-line no-restricted-syntax
        for await (const fileLine of fileInterface) {
            const [key, value] = fileLine.split('=');
            if (key && value) {
                const normalizedValue: string = value.replace(/[\r"']/gi, '');
                fileInfo[key] = normalizedValue;
            }
        }

        return fileInfo;
    } finally {
        if (fileInterface) {
            fileInterface.close();
        }

        if (fileStream) {
            fileStream.destroy();
        }
    }
}

export async function readOsInfo(): Promise<types.OsInfo> {
    const releaseFiles: string[] = ['/etc/os-release', '/usr/lib/os-release'];

    const osInfo: types.OsInfo = {
        platform: process.platform,
        architecture: process.arch
    };

    if (process.platform === 'linux') {
        // eslint-disable-next-line no-restricted-syntax
        for (const releaseFile of releaseFiles) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const releaseFileInfo = await readReleaseFile(releaseFile);
                if (releaseFileInfo) {
                    osInfo.distribution = releaseFileInfo.ID;
                    osInfo.distributionVersion = releaseFileInfo.VERSION_ID;
                    break;
                }
            } catch (error) {
                const message = `Failed to read OS release file: ${error.message}`;
                logger.error(message);
            }
        }
    }

    return osInfo;
}
