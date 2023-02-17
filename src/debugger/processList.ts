import * as vscode from 'vscode';
import * as util from 'util';

const exec = util.promisify(require('child_process').exec);

interface ProcessItem extends vscode.QuickPickItem {
    pid: number;
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
    // sample ps -af -o uname,pid,time, cmd output
    // USER         PID     TIME CMD
    // uname1     13710 00:00:00 bash
    // uname1     18042 00:00:00  \_ ps -af -o uname,pid,time,cmd
    // uname1     13361 00:00:00 bash
    // uname1     13390 00:00:09  \_ /usr/bin/p4v.bin
    // root        1710 00:00:50 /usr/lib/xorg/Xorg -core :0 -seat seat0 -auth /var/run
    // root        1713 00:00:00 /sbin/agetty -o -p -- \u --noclear tty1 linux

    const { error, stdout, stderr } = await exec('ps -af -o uname,pid,time,cmd');
    const options = stdout;

    if (error || stderr) {
        throw new Error('Unable to select process to attach to');
    }

    const output = options.split('\n');

    // figure out the index where PID ends because all PIDs would end at that index
    const pidEndIdx = output[0].indexOf('PID') + 3;

    // based on the the format ps returns info, the pids would start after the first set of spaces we encounter
    const pidArray = output.map((x: string) => Number.parseInt(x.slice(x.indexOf(' '), pidEndIdx).trimStart())).slice(1);

    const cmdArray = output
        .map((x: string) => {
            // figuring out the index of the executable based on the last index of ':'
            const fullPathCmdSlice = x.slice(x.lastIndexOf(':') + 3, x.length).trimStart();
            const execCmdSlice = fullPathCmdSlice.slice(fullPathCmdSlice.lastIndexOf('/') + 1, fullPathCmdSlice.length);
            return execCmdSlice;
        })
        .slice(1);

    const username = output.map((x: string) => x.slice(0, x.indexOf(' ')).trimStart()).slice(1);

    const items: ProcessItem[] = pidArray.map((item: number, index: string) => ({ pid: pidArray[index], label: `${username[index]} : ${cmdArray[index]}` }));
    items.sort((a, b) => 0 - (a.label > b.label ? -1 : 1));

    const quickPickList: ProcessItem[] = items.filter((item: ProcessItem) => item.label.trim() !== ':');

    return quickPickList;
}
