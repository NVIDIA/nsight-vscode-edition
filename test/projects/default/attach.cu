/*

The MIT License (MIT)

Copyright (c) 2025, NVIDIA CORPORATION. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/

#include "../helpers.h"

#include <cerrno>
#include <chrono>
#include <cstring>
#include <fstream>
#include <sys/prctl.h>
#include <thread>
#include <unistd.h>

namespace {

int get_tracer_pid()
{
    std::ifstream status("/proc/self/status");
    std::string line;

    while (std::getline(status, line)) {
        if (line.rfind("TracerPid:", 0) == 0) {
            return std::stoi(line.substr(std::string("TracerPid:").length()));
        }
    }

    return 0;
}

void wait_for_debugger_attach()
{
    if (prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY) != 0) {
        eprint("Unable to relax ptrace restrictions for attach test: {}\n", std::strerror(errno));
    }

    print("Waiting for debugger attach. PID: {}\n", getpid());
    std::cout.flush();

    while (get_tracer_pid() == 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }

    print("Debugger attached. Running variables scenario.\n");
    std::cout.flush();
}

int run_attach_test()
{
    wait_for_debugger_attach();

    auto& testProps = getTestProps();
    auto it = testProps.find("variables");
    if (it == testProps.end()) {
        eprint("Unable to find variables scenario\n");
        return 1;
    }

    return it->second();
}

}

REGISTER_TEST_PROP(attach, run_attach_test);
