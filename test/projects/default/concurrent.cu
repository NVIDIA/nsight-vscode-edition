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

#include <cuda/barrier>
#include "../helpers.h"

__global__ void kernelFunc(cuda::barrier<cuda::thread_scope_system>* barrier) {
    volatile int threadNum = threadIdx.x;
    /*📍device1*/ barrier->arrive_and_wait();;
    /*📍device2*/ for (volatile int dummy = 0;;) dummy = dummy + 1; 
}

int run_concurrent_test() {
    const int numHostThreads = 1, numDeviceThreads = 32;

    int cudaDeviceCount;
    cudaGetDeviceCount(&cudaDeviceCount) || panic;
    assert(cudaDeviceCount > 0);
    cudaSetDevice(0) || panic;

    typedef cuda::barrier<cuda::thread_scope_system> barrier_t;
    barrier_t* barrier;
    cudaMallocHost(&barrier, sizeof *barrier) || panic;
    new(barrier) barrier_t(numHostThreads + numDeviceThreads);

    kernelFunc<<<1, numDeviceThreads>>>(barrier);
    /*📍host1*/ barrier->arrive_and_wait();
    /*📍host2*/ for (volatile int dummy = 0;;) dummy = dummy + 1; 
}

REGISTER_TEST_PROP(concurrent, run_concurrent_test);
