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

/**
 * Split a GDB/MI command into whitespace-delimited tokens.
 *
 * Each token is either an unquoted run of non-whitespace, non-quote characters,
 * or a double-quoted string. Inside a quoted string a backslash escapes the next
 * character, so an embedded escaped quote (`\"`) or escaped backslash (`\\`) is
 * kept as part of the same token rather than being mistaken for the closing
 * quote. This is required so that expressions such as `sizeof(\"hello\")` survive
 * a tokenize/rejoin round-trip intact.
 */
export function tokenizeMiCommand(command: string): string[] {
    const tokens: string[] = [];
    const tokenRe = /[\t\n\v\f\r ]*(?<token>([^\t\n\v\f\r "]+|"(\\.|[^"\\])*")|$)/y;
    for (;;) {
        const { lastIndex } = tokenRe;
        const { token } = tokenRe.exec(command)?.groups ?? {};
        if (token === undefined) {
            // If our regexp failed, just take the remaining unparsed text as is.
            tokens.push(command.slice(lastIndex));
            break;
        } else if (token === '') {
            // A zero-length match is only possible at the end of input.
            break;
        } else {
            tokens.push(token);
        }
    }
    return tokens;
}
