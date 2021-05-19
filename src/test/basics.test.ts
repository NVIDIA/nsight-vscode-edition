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

import { TestUtils } from './testUtils';
import { CudaDebugClient } from './cudaDebugClient';

describe('Basic tests', async () => {
    let dc: CudaDebugClient;

    beforeEach(async () => {
        dc = await TestUtils.launchDebugger('variables/variables');
    });

    afterEach(async () => {
        await dc?.stop();
    });

    it('Can launch the adapter', async () => {
        // Only run before-each and after-each
    });
});
