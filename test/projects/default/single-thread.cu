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

/*📍singleThreadKernel*/ __global__ void singleThreadKernel(int* data, int iterations)
{
    if (threadIdx.x == 0) {
        for (int i = 0; i < iterations; i++) {
            /*📍loopIteration*/ data[i] = i * 2;
        }
    }
}

int run_single_thread_test(const char* mode)
{
    int cudaDeviceCount;
    cudaGetDeviceCount(&cudaDeviceCount) || panic;
    assert(cudaDeviceCount > 0);
    cudaSetDevice(0) || panic;

    if (strcmp(mode, "warp") == 0) {
        const int iterations = 10;
        int* data;
        cudaMallocManaged(&data, sizeof(int) * iterations) || panic;
        singleThreadKernel<<<1, 32>>>(data, iterations);
        cudaDeviceSynchronize() || panic;
        for (int i = 0; i < iterations; i++) {
            if (data[i] != i * 2) exit(1);
        }
        cudaFree(data) || panic;
    }
    else {
        exit(1);
    }

    print("Success\n");
    exit(0);
}

int run_single_thread_warp_test() {
    return run_single_thread_test("warp");
}

REGISTER_TEST_PROP(single-thread-warp, run_single_thread_warp_test); 