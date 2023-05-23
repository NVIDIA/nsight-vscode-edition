import * as vscode from 'vscode';

enum AutostartType  {
    LocalHost = "autostart (localhost)",
    RemoteHost = "autostart (remote)",
    ScpRemoteHost = "autostart (secure copy executable binary, remote)",
    QNXHost = "autostart (remote QNX)",
    ScpQNXHost = "autostart (secure copy cuda-gdbserver binary, remote QNX)"
}

export interface RemoteTaskDefinition extends vscode.TaskDefinition {
    label: AutostartType;
    type: "shell"
    command:  string;
}

export class AutoStartTaskProvider implements vscode.TaskProvider {

    private tasks:vscode.Task[] | undefined;

    static remoteScriptType = 'shell';

    public async provideTasks(): Promise<vscode.Task[]> {
        return this.getTasks();
    }

    public resolveTask(task: vscode.Task): vscode.Task | undefined {
        const {label} = task.definition;
        if (!label) {
            // eslint-disable-next-line unicorn/no-useless-undefined
            return undefined;
        }
        const {definition} = task as any;
        return this.getTask(definition);
    }

    private getTasks(): vscode.Task[] {
        if (this.tasks !== undefined) {
            return this.tasks;
        }

        /* eslint-disable no-template-curly-in-string */
        const taskList: RemoteTaskDefinition[] = [
            {label: AutostartType.LocalHost, type : "shell", command: 'cuda-gdbserver ${config:host}:${config:port} ${config:executable}' },
            {label: AutostartType.RemoteHost, type : "shell", command: 'ssh ${config:username}@${config:host} "cuda-gdbserver ${config:host}:${config:port} ${config:remoteExecutable}"'},
            {label: AutostartType.ScpRemoteHost ,type : "shell", command: 'scp ${config:executable} ${config:username}@${config:host}:/tmp && ssh ${config:username}@${config:host} "cuda-gdbserver ${config:host}:${config:port} /tmp/${config:execName}"'},
            {label: AutostartType.QNXHost, type : "shell", command: 'ssh ${config:username}@${config:host} ${config:cudaGdbServerPath} ${config:port}' },
            {label: AutostartType.ScpQNXHost, type : "shell", command: 'scp ${config:cudaGdbServerPath} ${config:username}@${config:host}:/tmp && ssh ${config:username}@${config:host} /tmp/cuda-gdbserver ${config:port}' }
        ];
        /* eslint-enable no-template-curly-in-string */

        this.tasks = [];

        taskList.forEach((taskItem) => {
            this.tasks?.push(this.getTask(taskItem));
        });

        return this.tasks;
    }

    // eslint-disable-next-line class-methods-use-this
    private getTask(taskItem: RemoteTaskDefinition): vscode.Task {

        const shellExec = new vscode.ShellExecution(taskItem.command);
        const task = (new vscode.Task(taskItem, vscode.TaskScope.Workspace, taskItem.label, 'Nsight',  shellExec));
        // Setting this again based on suggestion from https://github.com/microsoft/vscode/issues/95876
        task.definition.command = taskItem.command;

        return task;
    }
}
