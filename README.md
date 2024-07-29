# Nsight Visual Studio Code Edition

#### [Overview](https://developer.nvidia.com/nsight-visual-studio-code-edition)&nbsp;&nbsp;|&nbsp;&nbsp;[Documentation](https://docs.nvidia.com/nsight-visual-studio-code-edition/)&nbsp;&nbsp;|&nbsp;&nbsp;[Forum](https://forums.developer.nvidia.com/c/developer-tools/nsight-vscode-edition)&nbsp;&nbsp;|&nbsp;&nbsp;[Code Samples](https://github.com/NVIDIA/cuda-samples)

Nsight Visual Studio Code edition is an extension for
[Visual Studio Code](https://code.visualstudio.com/) that
provides support for [CUDA](https://developer.nvidia.com/cuda-zone)
development, including features such as Intellisense, debugging, debugger views,
and productivity enhancements.

## Benefits

* **Higher Productivity**<br>
  Using smart CUDA auto-code completion features improves the overall
  development experience and enables users to save time and effort when writing
  code.

* **Interactivity**<br>
  Debugging with Nsight Visual Studio Code Edition provides diverse benefits,
  including code formatting, easy navigation through source code, displaying and
  interacting with different source files, building executables, and testing.

* **Remote Development Support**<br>
  Nsight Visual Studio Code Edition enables developers to implement CUDA code in
  various cluster environments such as Virtual Machines or remote Docker
  containers. It also supports code development for Linux systems via the Remote
  – WSL extension.

* **Free**<br>
  As with other Nsight tools from NVIDIA, Nsight Visual Studio Code Edition is
  offered free of charge.  We love it when your code works better and is
  delivered sooner. Enjoy!

## Key Features

* **CUDA Syntax Highlighting for Code Development and Debugging**<br>
  Edit code productively with syntax highlighting and IntelliSense for CUDA
  code.  Auto-completion, go to definition, find references, rename symbols, and
  more all seamlessly work for kernel functions the same as they do for C++
  functions.

* **CUDA Kernel Breakpoint Support and Kernel Execution Control**<br>
  Break into a debugging session in CPU or GPU device code using standard
  breakpoints, including support for conditional breakpoints with expression
  evaluation. GUI controls allow you to step over, into, or out of statements in
  the source code, just like normal CPU debugging. Breakpoints are evaluated for
  every kernel thread and will halt execution when any thread encounters them.

* **GPU and Kernel State Inspection**<br>
  Break into the debugger to see all the detailed information at any point in
  the application with GPU debugging support for register, variable, and
  call-stack. There is watchlist support to add specific variables of interest
  for tracking. Additionally, there are focus controls to manually select
  block and thread coordinates to switch the debugger
  focus.

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

* **[CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit)**: Install the CUDA Toolkit to get important tools for
  CUDA application development including the
  [NVCC compiler driver](https://docs.nvidia.com/cuda/cuda-compiler-driver-nvcc/index.html) and
  [cuda-gdb](https://docs.nvidia.com/cuda/cuda-gdb/index.html), the NVIDIA tool for debugging CUDA.

* **[Microsoft vscode-cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)**:
  Install Microsoft's C/C++ for Visual Studio Code to get Intellisense support for CUDA C++ code. 
  Nsight VS Code Edition will automatically install this extension.

## Quick Start

**Open or create a new CUDA application.** <br>
**Configure the debugging connection**<br>
 by creating a  [launch configuration](https://docs.nvidia.com/nsight-visual-studio-code-edition/cuda-debugger/index.html#walkthrough-create-launch-config) to launch and debug your application, or <br>
an [attach configuration](https://docs.nvidia.com/nsight-visual-studio-code-edition/cuda-debugger/index.html#walkthrough-attach-create-launch-config) if the target application is already running

![Create launch configuration](nsight-debug-config.gif)

**Start debugging!**

![Start debugging](nsight-debug.gif)

## Support
Reach out to us for feedback and questions via [our developer forum](https://forums.developer.nvidia.com/c/development-tools/nsight-vscode-edition/).

## Data and telemetry

This extension collects usage data and sends it to NVIDIA to help improve our products. This
extension respects the `"telemetry.enableTelemetry"` setting, for more info see
[Visual Studio Code Telemetry](https://code.visualstudio.com/docs/getstarted/telemetry).