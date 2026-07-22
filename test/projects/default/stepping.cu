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

// ===== BASIC STEPPING FUNCTIONS =====
__device__ int helperWithBreakpoint(int x) {
    /*📍helperBreakpoint*/ int doubled = x * 2;
    return doubled + 1;
}

__device__ int stepOutHelper(int x) {
    int result = x + 10;
    /*📍stepOutMiddle*/ result *= 2;
    /*📍stepOutEnd*/ return result;
}

__global__ void callingKernel(int* data) {
    /*📍callingKernelStart*/ int idx = threadIdx.x;
    /*📍callingKernelAssign*/ data[idx] = idx;
}

__global__ void stepOverTestKernel(int* data) {
    int idx = threadIdx.x;
    /*📍stepOverBeforeCall*/ int result = helperWithBreakpoint(idx);
    data[idx] = result;
}

__global__ void stepOutTestKernel(int* data) {
    int idx = threadIdx.x;
    int result = stepOutHelper(idx);
    /*📍stepOutCallerAfterCall*/ data[idx] = result;
}

// ===== RECURSIVE STEPPING FUNCTIONS =====

// Launch kernel with single-thread pattern, fills warp but only thread 0 works
__device__ __noinline__ int rec_self_helper(int n) {
    /*📍selfRecEntry*/ if (n <= 0) {
        return 1;
    }
    int v = rec_self_helper(n - 1);
    return v + n;
}

__global__ void selfRecKernel(int* out, int n) {
    if (threadIdx.x == 0) {
        /*📍selfRecKernelBeforeCall*/ int tmp = rec_self_helper(n);
        out[0] = tmp;
        /*📍selfRecKernelAfterCall*/ ;
    }
}

__device__ int rec_isEven(int n);

__device__ __noinline__ int rec_isOdd(int n) {
    /*📍isOddEntry*/ if (n <= 0) {
        return 0;
    }
    return rec_isEven(n - 1);
}

__device__ __noinline__ int rec_isEven(int n) {
    /*📍isEvenEntry*/ if (n <= 0) {
        return 1;
    }
    return rec_isOdd(n - 1);
}

__global__ void mutualRecKernel(int* out, int n) {
    if (threadIdx.x == 0) {
        /*📍mutualRecKernelBeforeCall*/ int tmp = rec_isEven(n);
        out[0] = tmp;
        /*📍mutualRecKernelAfterCall*/ ;
    }
}

int run_stepping_calling_test() {
    int* d_data;
    cudaMallocManaged(&d_data, sizeof(int) * 32) || panic;

    callingKernel<<<1, 32>>>(d_data);
    cudaDeviceSynchronize() || panic;

    cudaFree(d_data) || panic;
    print("Success\n");
    exit(0);
}

int run_stepping_stepover_test() {
    int* d_data;
    cudaMallocManaged(&d_data, sizeof(int) * 32) || panic;

    stepOverTestKernel<<<1, 32>>>(d_data);
    cudaDeviceSynchronize() || panic;

    cudaFree(d_data) || panic;
    print("Success\n");
    exit(0);
}

int run_stepping_stepout_test() {
    int* d_data;
    cudaMallocManaged(&d_data, sizeof(int) * 32) || panic;

    stepOutTestKernel<<<1, 32>>>(d_data);
    cudaDeviceSynchronize() || panic;

    cudaFree(d_data) || panic;
    print("Success\n");
    exit(0);
}

int run_stepping_recursive_self_test() {
    int* d_data;
    cudaMallocManaged(&d_data, sizeof(int)) || panic;

    selfRecKernel<<<1, 32>>>(d_data, 3);
    cudaDeviceSynchronize() || panic;

    cudaFree(d_data) || panic;
    print("Success\n");
    exit(0);
}

int run_stepping_recursive_mutual_test() {
    int* d_data;
    cudaMallocManaged(&d_data, sizeof(int)) || panic;

    mutualRecKernel<<<1, 32>>>(d_data, 3);
    cudaDeviceSynchronize() || panic;

    cudaFree(d_data) || panic;
    print("Success\n");
    exit(0);
}


namespace stepping_calling_ns {
    REGISTER_TEST_PROP(stepping-calling, run_stepping_calling_test);
}

namespace stepping_stepover_ns {
    REGISTER_TEST_PROP(stepping-stepover, run_stepping_stepover_test);
}

namespace stepping_stepout_ns {
    REGISTER_TEST_PROP(stepping-stepout, run_stepping_stepout_test);
}

namespace stepping_recursive_self_ns {
    REGISTER_TEST_PROP(stepping-recursive-self, run_stepping_recursive_self_test);
}

namespace stepping_recursive_mutual_ns {
    REGISTER_TEST_PROP(stepping-recursive-mutual, run_stepping_recursive_mutual_test);
}