import { stripTypeScriptTypes } from 'node:module';

export default {
    process(sourceText: string, sourcePath: string) {
        const code = stripTypeScriptTypes(sourceText, {
            mode: 'transform',
            sourceMap: true,
            sourceUrl: sourcePath
        });
        return { code };
    }
};
