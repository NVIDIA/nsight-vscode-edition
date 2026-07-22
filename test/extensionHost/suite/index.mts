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

import path from 'node:path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
    const mocha = new Mocha({
        color: true,
        timeout: 20_000,
        ui: 'bdd'
    });

    // eslint-disable-next-line unicorn/prefer-module -- The extension-host test suite is bundled as CommonJS.
    mocha.addFile(path.resolve(__dirname, 'languageSupport.smoke.js'));

    await new Promise<void>((resolve, reject) => {
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} extension-host smoke test${failures === 1 ? '' : 's'} failed.`));
                return;
            }

            resolve();
        });
    });
}
