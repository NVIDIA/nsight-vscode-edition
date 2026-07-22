import * as vscode from 'vscode';
import { setupCpptools } from '../../src/languageSupport/cpptoolsSetup.ts';
import { resetVscodeMock, setInspectedConfiguration, workspace } from '../mocks/vscode.mts';

const folder = {
    name: 'workspace',
    uri: vscode.Uri.file('/workspace'),
    index: 0
} satisfies vscode.WorkspaceFolder;

function configurationUpdateMock(): jest.MockedFunction<(key: string, value: unknown, target?: unknown) => Promise<void>> {
    return (workspace.getConfiguration('C_Cpp') as { update: jest.MockedFunction<(key: string, value: unknown, target?: unknown) => Promise<void>> }).update;
}

describe('setupCpptools', () => {
    beforeEach(() => {
        resetVscodeMock();
    });

    test('writes compile_commands when a compilation database is available', async () => {
        await setupCpptools(folder, { compileCommandsPath: '/workspace/build/compile_commands.json' });

        expect(configurationUpdateMock()).not.toHaveBeenCalledWith('default.compilerPath', expect.anything(), expect.anything());
        expect(configurationUpdateMock()).toHaveBeenCalledWith('default.compileCommands', '${workspaceFolder}/build/compile_commands.json', vscode.ConfigurationTarget.WorkspaceFolder);
    });

    test('keeps external compile_commands paths absolute', async () => {
        await setupCpptools(folder, { compileCommandsPath: '/external/build/compile_commands.json' });

        expect(configurationUpdateMock()).toHaveBeenCalledWith('default.compileCommands', '/external/build/compile_commands.json', vscode.ConfigurationTarget.WorkspaceFolder);
    });

    test('reports failed setting writes without throwing', async () => {
        configurationUpdateMock().mockImplementation(async (section) => {
            if (section === 'default.compileCommands') {
                throw new Error('compileCommands locked');
            }
        });

        await expect(setupCpptools(folder, { compileCommandsPath: '/workspace/build/compile_commands.json' })).resolves.toEqual({
            failedSettings: ['C_Cpp.default.compileCommands: compileCommands locked']
        });

        expect(configurationUpdateMock()).toHaveBeenCalledWith('default.compileCommands', '${workspaceFolder}/build/compile_commands.json', vscode.ConfigurationTarget.WorkspaceFolder);
    });

    test('is idempotent against its own writes on a second invocation', async () => {
        await setupCpptools(folder, { compileCommandsPath: '/workspace/build/compile_commands.json' });
        expect(configurationUpdateMock()).toHaveBeenCalledTimes(1);

        configurationUpdateMock().mockClear();
        await setupCpptools(folder, { compileCommandsPath: '/workspace/build/compile_commands.json' });

        expect(configurationUpdateMock()).not.toHaveBeenCalled();
    });

    test('does not overwrite global, workspace, or workspace-folder values', async () => {
        setInspectedConfiguration('C_Cpp', {
            'default.compilerPath': { globalValue: '/configured/nvcc' },
            'default.compileCommands': { workspaceFolderValue: '/configured/compile_commands.json' }
        });

        await setupCpptools(folder, { compileCommandsPath: '/workspace/build/compile_commands.json' });

        expect(configurationUpdateMock()).not.toHaveBeenCalled();
    });

    test('does not write compilerPath without compile_commands', async () => {
        await setupCpptools(folder, {});

        expect(configurationUpdateMock()).not.toHaveBeenCalled();
    });
});
