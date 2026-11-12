# Nsight Visual Studio Code Edition Changelog


## Version 2026.2

* **Key Features**
    * Added the Warp Info view, showing every warp and lane on the current GPU with their state, PC, and active/divergent masks, with filtering, sorting, and one-click CUDA focus changes.

    * Added instruction-level stepping: Step Over and Step Into advance one GPU instruction at a time when invoked from the Disassembly view.

* **General Enhancements**

    * Debug Adapter Protocol traffic for each session is now written to a log file to help troubleshoot debugging issues; its path is reported in the DEBUG CONSOLE. The Debug Console itself keeps showing cuda-gdb's output, errors, and command results.

    * Pending source breakpoints (eg. breakpoints from JIT code, delayed function/module load) are now properly reported as unverified until cuda-gdb resolves them, instead of always showing as verified.

    * Fixed breakpoint conditions being silently dropped from pending breakpoints. A warning is also shown when cuda-gdb failed to parse a condition.

    * Fixed the Disassembly view showing wrong or stale instructions when a source file could not be opened. A warning is printed to the DEBUG CONSOLE when a source file is unavailable, since source-line annotations for that file cannot be shown.

    * Fixed two launch configuration issues: the Auto-start snippets added via "Debug: Add Configuration..." inserted `"program": "/a.out"` instead of `"${workspaceFolder}/a.out"`, and `miDebuggerArgs` was not passed to cuda-gdb.

    * Fixed the default "CUDA GDB Server: Launch" configuration failing to connect to an already running cuda-gdbserver.

    * Fixed "CUDA GDB Server: Auto-start (Local)" sessions ending with a "this.stopGDBServer is not a function" error on stop; the cuda-gdbserver they started is now stopped on disconnect.

    * Fixed log lines from concurrent debug sessions being written to the wrong session's `logFile`.

    * Fixed Debug Console commands rejected by cuda-gdb (`-exec`, backtick, `-mi`) showing no result and leaving a "Canceled" row when the session ended; cuda-gdb's error message is now shown as the command's result.

    * Fixed a rejected CUDA focus change being reported twice.

    * CUDA commands typed in the Debug Console that change the focus, such as `-exec cuda thread (2,0,0)`, now update the Call Stack and the editor's current line, the same as changing the focus from the status bar.

    * Fixed kernel local variables missing from the VARIABLES view, and Debug Console commands failing with "No symbol in current context", after the CUDA Built-ins were shown.

* **CUDA Debugger**
    * See cuda-gdb release notes in the NVIDIA CUDA Toolkit 13.5.

## Version 2026.1

* **Key Features**
    * Added `cuda-gdbserver` autostart for remote debugging via the `autostart` launch configuration property, with modes `local`, `linux-remote`, `linux-remote-upload`, `qnx-remote`, and `qnx-remote-upload`.

    * CUDA built-in variables and PTX special registers are now shown in the Variables view.

    * Added guided CUDA C++ language support setup: the extension detects CUDA workspaces and configures clangd or Microsoft's C/C++ extension as the language provider.

    * Breakpoints can now be set in the Disassembly view.

    * Added Linux arm64 host support.

    * The extension is now published on the Open VSX Registry, enabling installation in VSCodium and other compatible editors.

* **General Enhancements**
    * Fixed debugger controls (continue, pause, step) getting out of sync with the debuggee after attach.

    * Fixed a duplicate `errorpc` entry in the Variables view.

    * Fixed an empty `args` array adding an empty argument to the debuggee command line.

    * Improved validation of attach request inputs.

* **CUDA Debugger**
    * See cuda-gdb release notes in the NVIDIA CUDA Toolkit 13.3.

## Version 2025.1

* **General Enhancements**
    * Arguments to debuggeed process (`args` in launch.json) can now be an array of strings rather than a single string.

    * CPU threads, stack frames, and variables can be fully inspected while stopped in GPU code, and vice versa.

* **CUDA Debugger**
    * See cuda-gdb release notes in the NVIDIA CUDA Toolkit 12.6 Update 2.

## Version 2024.1

* **General Enhancements**
    * Added ability to pass custom arguments in debugger using miDebuggerArgs.

    * Added ability to specify path to debugger using miDebuggerPath in addition to previously available debuggerPath.

    * Line cursor now changes accordingly when switching focus between blocks/threads via the Debug console.

* **CUDA Debugger**
    * See cuda-gdb release notes in the NVIDIA CUDA Toolkit 12.5 Update 1.

## Version 2023.2

* **Key Features**

    * Added support for remote debugging (via cuda-gdbserver) an application running on L4T.

    * Added support for remote debugging (via cuda-gdbserver) an application running on QNX.

    * Added five autostart tasks which help users easily set up and instantiate remote debugging sessions on L4T and QNX platforms.


* **General Enhancements**

    * Added the ability to set a SOLibSearchPath for the debugging session.

    * Added the ability to set environment variables before cuda-gdb/cuda-qnx-gdb is launched. 

* **CUDA Debugger** See cuda-gdb release notes in the NVIDIA CUDA Toolkit 12.1.

## Version 2023.1

* **Important Fixes**

    * Fixed an issue where Nsight VSCode Edition was not able to set breakpoints
      and debug in delayed module load scenarios (for example, in CUDA Driver
      API applications).

    * Fixed a bug where read for ptrace_scope was attempted on systems where
      it was not present.

* **CUDA Debugger** See cuda-gdb release notes in the NVIDIA CUDA Toolkit 12.0 Update 1.

## Version 2022.2

* **General Enhancements**

    * A fix for truncated process names during attach.

    * Support for when PIDs for attach are entered as a string.

    * New warnings for when cuda-gdb is not found in the path.

    * Improvements to the user experience when stepping out of functions during debugging.

    * Various bug fixes and performance improvements.

* **CUDA Debugger** See cuda-gdb release notes in the NVIDIA CUDA Toolkit 11.7 Update 1.

## Version 2022.1

### General

* **Attach to a running CUDA process** It is now possible to attach to a CUDA
  application that is already running. It is also possible to detach from the
  application before letting it run to completion. When attached, all the usual
  features of the debugger are available to the user, as if the application had
  been launched from the debugger. This feature is also supported with
  applications using Dynamic Parallelism.

* **Additional Launch Settings**

    * **envFile** Path to a file containing environment variables to set for the
      debuggee process. Each line is formatted as either:

        * KEY=VALUE
        * unset KEY

    * **initCommands** Provide an array of cuda-gdb commands to run before
      debugging is started.

    * **stopAtEntry** If true, the debugger should stop at the entry points of the debuggee.

    * **cwd** Set current working directory for debuggee.

* **Security Updates** We've updated the vscode npm packages to the latest
  versions to address known vulnerabilities.

* **CUDA Debugger** See cuda-gdb release notes in the NVIDIA CUDA Toolkit 11.6 Update 2.

## Version 2021.1

We would like to introduce our newest developer tool for CUDA kernel debugging,
NVIDIA Nsight™ Visual Studio Code Edition. NVIDIA Nsight™ Visual Studio Code
Edition (VSCE) is an application development environment for heterogeneous
platforms that brings CUDA® development for GPUs into Microsoft Visual Studio
Code. NVIDIA Nsight™ VSCE enables you to build and debug GPU kernels and native
CPU code as well as inspect the state of the GPU and memory.

### Benefits

* **Higher Productivity** Using smart CUDA auto-code completion features
  improves the overall development experience and allows users to save time and
  effort when writing code.

* **Interactivity** Debugging with Nsight Visual Studio Code Edition provides
i diverse benefits, including code formatting, easy navigation through source
  code, displaying and interacting with different source files, building
  executables, and testing.

* **Remote Development Support** Nsight Visual Studio Code Edition allows
  developers to implement CUDA code in various cluster environments such as
  Virtual Machines or remote Docker containers. It also supports code
  development for Linux systems via the Remote – WSL extension.

* **Free** As with other Nsight tools from NVIDIA, Nsight Visual Studio Code
  Edition is offered free of charge. We love it when your code works better and
  is delivered sooner. Enjoy!

### Key Features

* **CUDA Syntax Highlighting for Code Development and Debugging** Edit code
  productively with syntax highlighting and IntelliSense for CUDA code.
  Auto-completion, go to definition, find references, rename symbols, and more
  all seamlessly work for kernel functions the same as they do for C++
  functions.

* **CUDA Kernel Breakpoint Support and Kernel Execution Control** Break into a
  debugging session in CPU or GPU device code using standard breakpoints,
  including support for conditional breakpoints with expression evaluation. GUI
  controls allow you to step over, into, or out of statements in the source
  code, just like normal CPU debugging. Breakpoints are evaluated for every
  kernel thread and will halt execution when any thread encounters them.

* **GPU and Kernel State Inspection** Break into the debugger to see all the
  detailed information at any point in the application with GPU debugging
  support for register, variable, and call-stack. There is watchlist support to
  add specific variables of interest for tracking. Additionally, there are focus
  controls to manually select CUDA block and thread numbers to switch the
  debugger focus.
