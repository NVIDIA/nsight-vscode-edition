CUDA C++ project used for local debugging and automated tests. The `default` executable contains the sample `.cu` files in `default/`.

To build from CLI using npm:
```
npm run build:test
```

To build from CLI manually:
```
cmake -S . -B build
cmake --build build
```

To try Nsight Visual Studio Code Edition locally, install the [CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) extension, launch the Extension Development Host, and open this directory as its workspace. Select `default:launch` in **Run and Debug** and start debugging. Its `default:build` pre-launch task uses CMake Tools to configure and build the project before Rubicon launches `build/default/default` with `cuda-gdb`.

The `default` executable contains all sample `.cu` files and selects a scenario from its first command-line argument. `default:launch` runs `variables`; change its `args` to run another registered scenario.

To test attaching, first run the `default:run` task to build and start `build/default/default attach` in the background. The `attach` scenario prints its PID and waits until a debugger is attached. Then select `default:attach` in **Run and Debug**, choose the waiting `default attach` process, and continue from the attach stop to run the existing `variables` scenario.

The build uses the CMake Tools kit and CUDA Toolkit selected in the environment. After changing CUDA Toolkits, delete the CMake cache before rebuilding.
