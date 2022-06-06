import * as vscode from 'vscode';
import * as util from 'util';

const exec = util.promisify(require('child_process').exec);

interface ProcessItem extends vscode.QuickPickItem {
    pid: number;
}

export async function attachProcess(): Promise<boolean | undefined> {
    const result = await chooseProcess();

    if (result !== undefined) {
        const commandFolder = `readlink -e /proc/${result}/cwd`;
        const resFolder = await exec(commandFolder.toString());
        const folder = resFolder.stdout.trim();

        const config = {
            name: 'CUDA C++: Attach',
            request: 'attach',
            type: 'cuda-gdb',
            port: 4024,
            processId: result.pid,
            program: `${folder}/${result.label}`
        };

        return vscode.debug.startDebugging(folder, config);
    }

    // eslint-disable-next-line unicorn/no-useless-undefined
    return undefined;
}

export async function pickProcess(): Promise<string | undefined> {
    const processToReturn = await chooseProcess();
    const pid = processToReturn?.pid.toString();
    const label = processToReturn?.label;
    // returning this as a string because pickProcess must only return a string because of how package.json is set up
    const toReturn = `${pid}:${label}`;
    return toReturn;
}

export async function chooseProcess(): Promise<ProcessItem | undefined> {
    const items = getAttachItems();

    const chosenProcess: vscode.QuickPickOptions = {
        matchOnDescription: true,
        matchOnDetail: true
    };

    const process = await vscode.window.showQuickPick(items, chosenProcess);

    if (process === undefined) {
        throw new Error('Process not selected');
    } else {
        return process;
    }
}

export async function getAttachItems(): Promise<ProcessItem[]> {
    // these are the indices of the pid information and command name which we need to populate the process picker
    // sample ps output
    // UID          PID    PPID  C STIME TTY          TIME CMD
    // root        1483    1481  0 Mar07 tty1     00:00:04 /usr/lib/xorg/Xorg vt1 -disp
    // nsanan     47708   47707  5 12:02 pts/4    00:00:12 webpack
    // 0123456789
    const { error, stdout, stderr } = await exec('ps -af');
    const options = stdout;

    if (error || stderr) {
        throw new Error('Unable to select process to attach to');
    }

    const pidStartIdx = 11;
    const pidEndIdx = 19;
    const cmdStartIdx = 52;

    const pidArray = options
        .split('\n')
        .map((x: string) => Number.parseInt(x.slice(pidStartIdx, pidEndIdx).trimRight()))
        .slice(1);

    const cmdArray = options
        .split('\n')
        .map((x: string) => {
            const fullPathCmdSlice = x.slice(cmdStartIdx, x.length).trimRight();
            const execCmdSlice = fullPathCmdSlice.slice(fullPathCmdSlice.lastIndexOf('/') + 1, fullPathCmdSlice.length);
            return execCmdSlice;
        })
        .slice(1);

    const items: ProcessItem[] = pidArray.map((item: number, index: string) => ({ pid: pidArray[index], label: cmdArray[index] }));
    items.sort((a, b) => 0 - (a.label > b.label ? -1 : 1));
    return items;
}
