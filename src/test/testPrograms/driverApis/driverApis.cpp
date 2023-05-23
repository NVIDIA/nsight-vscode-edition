/*

The MIT License (MIT)

Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.

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

#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>
#include <string>
#include <fstream>
#include <sstream>

#include <cuda.h>

#if defined(assert)
#undef assert
#endif

#define assert(c) \
    do { \
        if(!(c)) { \
            fprintf(stderr, "Assertion \"%s\" failed. (%s:%d)\n", \
                #c, __FILE__, __LINE__); \
            exit(1); \
        } \
    } while(0)

#define assertSucceeded(c) \
    do { \
        unsigned __tmp = c; \
        if(__tmp != CUDA_SUCCESS) { \
            fprintf(stderr, "Operation \"%s\" failed with error code %x. (%s:%d)\n", \
                #c, (__tmp), __FILE__, __LINE__); \
            exit(__tmp); \
        } \
    } while(0)

constexpr int logOfThreadsPerBlock = 5;
constexpr int logOfDataLength = 7;
constexpr int threadsPerBlock = 1 << logOfThreadsPerBlock;
constexpr int dataLength = 1 << logOfDataLength;

constexpr const char* binaryPath = "kernel.fatbin";
constexpr const char* functionName = "kernel";

int main(int argc, char* argv[])
{
    assert(argc == 2);

    assertSucceeded(cuInit(0));

    CUdevice cuDevice;
    assertSucceeded(cuDeviceGet(&cuDevice, 0));

    CUcontext cuContext;
    assertSucceeded(cuCtxCreate(&cuContext, 0, cuDevice));

    std::ostringstream binaryStream;

    {
        const char *binaryPath = argv[1];

        std::ifstream binaryFile(binaryPath, std::ios::binary);
        assert(binaryFile.good());

        binaryStream << binaryFile.rdbuf();

        binaryFile.close();
    }

    CUmodule cuModule;
    assertSucceeded(cuModuleLoadData(&cuModule, binaryStream.str().c_str()));

    CUfunction cuFunction;
    assertSucceeded(cuModuleGetFunction(&cuFunction, cuModule, functionName));

    CUdeviceptr d_results;
    assertSucceeded(cuMemAlloc(&d_results, sizeof(unsigned) << logOfDataLength));

    constexpr int blocks = 1 << (logOfDataLength - logOfThreadsPerBlock);
    void *args[] = {&d_results};

    assertSucceeded(cuLaunchKernel(cuFunction, blocks, 1, 1, threadsPerBlock, 1, 1, 0, NULL, args, NULL));

    unsigned* h_results = reinterpret_cast<unsigned*>(malloc(sizeof(unsigned) << logOfDataLength));
    assertSucceeded(cuMemcpyDtoH(reinterpret_cast<void *>(h_results), d_results, sizeof(unsigned) << logOfDataLength));

    for (unsigned i = 0; i < dataLength; i++)
    {
        if (h_results[i] != i){
            fprintf(stderr, "h_results[%u] is %u\n", i, h_results[i]);
            exit(1);
        }
    }

    delete[] h_results;
    assertSucceeded(cuMemFree(d_results));
    assertSucceeded(cuCtxDestroy(cuContext));

    fprintf(stderr, "Success\n");

    exit(0);
}
