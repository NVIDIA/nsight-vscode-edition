/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2026, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

import { build } from 'esbuild';

await build({
    entryPoints: ['test/extensionHost/runTest.mts', 'test/extensionHost/suite/index.mts', 'test/extensionHost/suite/languageSupport.smoke.mts'],
    outbase: 'test/extensionHost',
    outdir: 'out/extensionHost',
    bundle: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: 'inline',
    logLevel: 'info'
});
