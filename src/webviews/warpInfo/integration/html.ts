/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { randomBytes } from 'node:crypto';

function escapeAttribute(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

export function createWarpInfoHtml(scriptUri: string, styleUri: string, cspSource: string): string {
    const nonce = randomBytes(16).toString('base64url');
    const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none'`;
    return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">
<link rel="stylesheet" href="${escapeAttribute(styleUri)}"><title>Warp Info</title></head>
<body><div id="warp-info-root"></div><script type="module" nonce="${nonce}" src="${escapeAttribute(scriptUri)}"></script></body></html>`;
}
