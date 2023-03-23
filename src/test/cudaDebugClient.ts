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

import * as fs from 'fs';
import { expect } from 'chai';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

export class CudaDebugClient extends DebugClient {
    constructor(debugAdapterPath: string) {
        expect(fs.existsSync(debugAdapterPath)).eq(true);

        super('node', debugAdapterPath, 'cuda-gdb', {
            shell: true
        });

        this.capabilities = {};
    }

    public capabilities: DebugProtocol.Capabilities;
}
