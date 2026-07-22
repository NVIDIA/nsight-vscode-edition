import { tokenizeMiCommand } from '../../src/debugger/miCommandTokenizer.ts';

describe('tokenizeMiCommand', () => {
    test('splits a simple command into tokens', () => {
        expect(tokenizeMiCommand('-data-evaluate-expression --frame 0 --thread 1')).toEqual(['-data-evaluate-expression', '--frame', '0', '--thread', '1']);
    });

    test('keeps a plain quoted argument as a single token', () => {
        expect(tokenizeMiCommand('-break-insert "foo.cu:42"')).toEqual(['-break-insert', '"foo.cu:42"']);
    });

    test('keeps escaped quotes inside a quoted argument together', () => {
        // Regression test: an expression containing quotes must survive a
        // tokenize/rejoin round-trip. Previously `"sizeof(\"hello\")"` was split
        // into `"sizeof(\""`, `hello\`, `")"` and rejoined as
        // `"sizeof(\" hello\ ")"`.
        const command = String.raw`-data-evaluate-expression --frame 0 --thread 1 "sizeof(\"hello\")"`;
        const tokens = tokenizeMiCommand(command);

        expect(tokens).toEqual(['-data-evaluate-expression', '--frame', '0', '--thread', '1', String.raw`"sizeof(\"hello\")"`]);
        // The command must be reproducible by rejoining with single spaces.
        expect(tokens.join(' ')).toBe(command);
    });

    test('handles escaped backslashes inside a quoted argument', () => {
        const command = String.raw`-data-evaluate-expression "path\\to"`;
        const tokens = tokenizeMiCommand(command);

        expect(tokens).toEqual(['-data-evaluate-expression', String.raw`"path\\to"`]);
        expect(tokens.join(' ')).toBe(command);
    });

    test('collapses leading and repeated whitespace', () => {
        expect(tokenizeMiCommand('   -exec-continue   --thread   2 ')).toEqual(['-exec-continue', '--thread', '2']);
    });
});
