# Nsight Visual Studio Code Edition

#### [Overview](https://developer.nvidia.com/nsight-visual-studio-code-edition)&nbsp;&nbsp;|&nbsp;&nbsp;[Documentation](https://docs.nvidia.com/nsight-visual-studio-code-edition/)&nbsp;&nbsp;|&nbsp;&nbsp;[Forum](https://forums.developer.nvidia.com/c/developer-tools/nsight-vscode-edition/379)&nbsp;&nbsp;|&nbsp;&nbsp;[Code Samples](https://github.com/NVIDIA/cuda-samples)

Nsight Visual Studio Code edition is an extension for
[Visual Studio Code](https://code.visualstudio.com/) that
provides support for [CUDA](https://developer.nvidia.com/cuda-zone)
development, including features such as Intellisense, debugging, debugger views,
and productivity enhancements.

The extension is available on the Visual Studio Marketplace and on the
[Open VSX Registry](https://open-vsx.org/extension/NVIDIA/nsight-vscode-edition)
for VSCodium and other compatible editors. Linux x86_64 and Linux arm64
hosts are supported.

## Benefits

* **Higher Productivity**<br>
  Using CUDA-aware code completion improves the overall development experience
  and enables users to save time and effort when writing code.

* **Interactivity**<br>
  Debug CPU and GPU code in the same session using familiar editor controls
  and debugger views. Investigate CUDA application behavior alongside your
  source code without switching to a separate debugger interface.

* **Remote Development Support**<br>
  Nsight Visual Studio Code Edition enables developers to implement CUDA code in
  various cluster environments such as Virtual Machines or remote Docker
  containers. It also supports code development for Linux systems via the Remote
  – WSL extension. For supported remote debugging configurations, Nsight VSCE
  can automatically start cuda-gdbserver.

* **Free**<br>
  As with other Nsight tools from NVIDIA, Nsight Visual Studio Code Edition is
  offered free of charge.  We love it when your code works better and is
  delivered sooner. Enjoy!

## Key Features

* **CUDA C++ Language Support**<br>
  Edit CUDA C++ with syntax highlighting and CUDA-aware code completion,
  navigation, references, and rename support using either Microsoft's C/C++
  extension or clangd.

* **CUDA Kernel Breakpoint Support and Kernel Execution Control**<br>
  Break into a debugging session in CPU or GPU device code using standard
  breakpoints, including support for conditional breakpoints with expression
  evaluation. Breakpoints can also be set on individual instructions in the
  Disassembly view. GUI controls allow you to step over, into, or out of
  statements in the source code, just like normal CPU debugging. Breakpoints are
  evaluated for every kernel thread and will halt execution when any thread
  encounters them.

* **GPU and Kernel State Inspection**<br>
  When your application is paused in the debugger, inspect call stacks,
  application variables, CUDA built-in variables, and registers, including PTX
  special registers. Use the Watch view to track expressions and focus controls
  to select the CUDA thread being inspected.

## Want to know more?

* **See the Nsight VSCode Edition spotlight video**<br>
  This [Nsight VSCode Edition
  spotlight](https://www.youtube.com/watch?v=gN3XeFwZ4ng) shows you how Nsight
  VSCode Edition fits in with the other NVIDIA IDE debuggers and can be set up
  in Microsoft's Visual Studio Code.  Then, you'll see all the key features in
  action.  You're going to love it!

* **See Nsight VSCode Edition demonstrated at GTC'21**<br>
  [GTC'21 Video On Demand: Latest Enhancements to CUDA Debugger IDEs](https://gtc21.event.nvidia.com/media/Latest%20Enhancements%20to%20CUDA%20Debugger%20IDEs%20%5BS31884%5D/1_geie6h11)

* **View the Microsoft announcement for the VSCode extension by Nsight VSCE**<br>
  [CUDA Support in Visual Studio Code with Julia Reid](https://www.youtube.com/watch?v=l6PgYhiQr-I&list=PLReL099Y5nRcWPNnKO4cwxN5RJZl9A48P&index=4)

* **Read the blog posting**<br>
  [Announcing NVIDIA Nsight Visual Studio Code Edition: New Addition to the Nsight Developer Tools Suite](https://developer.nvidia.com/blog/announcing-nvidia-nsight-visual-studio-code-edition-new-addition-to-the-nsight-developer-tools-suite/)

* **Visit the Nsight VSCode Edition overview page**<br>
  The [Nsight VSCode Edition overview
  page](https://developer.nvidia.com/nsight-visual-studio-code-edition) is your
  information hub for general information, availability, videos, and other links
  to other NVIDIA tools for GPU code development.

## Requirements

* **Visual Studio Code 1.101 or later** (or a compatible editor such as
  VSCodium).

* **[CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit)**: Install the CUDA Toolkit (13.3 recommended) to get
  important tools for CUDA application development including the
  [NVCC compiler driver](https://docs.nvidia.com/cuda/cuda-compiler-driver-nvcc/index.html) and
  [cuda-gdb](https://docs.nvidia.com/cuda/cuda-gdb/index.html), the NVIDIA tool for debugging CUDA.

* **Optional CUDA C++ language provider**: for code intelligence, install
  either [clangd](https://open-vsx.org/extension/llvm-vs-code-extensions/vscode-clangd) or
  [Microsoft's C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools).
  Neither is a hard dependency; Nsight guides the setup for whichever is
  available.

## Quick Start

**Open or create a new CUDA application.** <br>
**Configure CUDA C++ editing support**<br>
Open a workspace that contains `.cu` or `.cuh` files. Nsight can automatically
prompt to configure CUDA C++ language support, or you can run **CUDA: Configure
CUDA C++ Language Support** from the Command Palette.

For clangd, Nsight can generate a project-owned `.clangd` file and will not
overwrite an existing one. If a `.clangd` file already exists, run **CUDA:
Generate .clangd** and confirm the prompt to create a `.clangd.nsight.example`
file for comparison (only created if one does not already exist).

For Microsoft's C/C++ extension, Nsight uses `compile_commands.json` when
available and leaves existing C/C++ settings in place.

**Configure the debugging connection**<br>
 by creating a  [launch configuration](https://docs.nvidia.com/nsight-visual-studio-code-edition/cuda-debugger/index.html#walkthrough-create-launch-config) to launch and debug your application, or <br>
an [attach configuration](https://docs.nvidia.com/nsight-visual-studio-code-edition/cuda-debugger/index.html#walkthrough-attach-create-launch-config) if the target application is already running

![Create launch configuration](nsight-debug-config.gif)

**Start debugging!**

![Start debugging](nsight-debug.gif)

## Support
Reach out to us for feedback and questions via [our developer forum](https://forums.developer.nvidia.com/c/developer-tools/nsight-vscode-edition/379).

## Data and telemetry

This extension collects usage data and sends it to NVIDIA to help improve our products. This
extension respects the `"telemetry.telemetryLevel"` setting, for more info see
[Visual Studio Code Telemetry](https://code.visualstudio.com/docs/getstarted/telemetry).
