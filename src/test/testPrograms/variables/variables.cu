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

#include <cuda_runtime.h>

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
        if(__tmp != cudaSuccess) { \
            fprintf(stderr, "Operation \"%s\" failed with error code %x. (%s:%d)\n", \
                #c, (__tmp), __FILE__, __LINE__); \
            exit(__tmp); \
        } \
    } while(0)

#define ARRAY_LENGTH(x) (sizeof(x) / sizeof(x[0]))

constexpr int dataLength = 1 << 24;
constexpr int threadsPerBlock = 128;

typedef unsigned char byte;

struct TestType
{
    union {
        struct
        {
            unsigned lowHalf;
            unsigned highHalf;
        } halfAndHalf;

        unsigned long long whole;
    } takeYourPick;

    int arr[5];

    struct {
        char a;
        char b;
    } structArr[5];

    float theFloats[2];
    double theDouble;
};

__device__ void cudaComputeHashInner(TestType* input, unsigned *results)
{
    int idx = blockIdx.x * threadsPerBlock + threadIdx.x;
    TestType* myInput = input + idx;

    unsigned myResult = 0;

    myResult += myInput->takeYourPick.halfAndHalf.lowHalf - idx;
    myResult += myInput->takeYourPick.halfAndHalf.highHalf - idx;

    for(size_t i = 0; i < ARRAY_LENGTH(myInput->arr); i++)
    {
        myResult += myInput->arr[i] - idx;
    }

    for(size_t i = 0; i < sizeof(myInput->structArr); i++)
    {
        myResult += reinterpret_cast<byte *>(myInput->structArr)[i] - '0';
    }

    __syncthreads();

    results[idx] = myResult;
}

__global__ void cudaComputeHash(TestType* input, unsigned *results)
{
    int idx = blockIdx.x * threadsPerBlock + threadIdx.x;
    cudaComputeHashInner(input, results);
    results[idx] += 1;
}

int main()
{
    int cudaDeviceCount;
    assertSucceeded(cudaGetDeviceCount(&cudaDeviceCount));
    assert(cudaDeviceCount > 0);

    assertSucceeded(cudaSetDevice(0));

    TestType* input;
    unsigned* results;

    assertSucceeded(cudaMallocManaged(&input, sizeof(TestType) * dataLength));
    assert(!!input);

    for (size_t i = 0; i < dataLength; i++)
    {
        input[i].takeYourPick.halfAndHalf.lowHalf = i + 1;
        input[i].takeYourPick.halfAndHalf.highHalf = i + 3;

        for(size_t j = 0; j < ARRAY_LENGTH(input[i].arr); j++)
        {
            input[i].arr[j] = i + j + 2;
        }

        for(size_t j = 0; j < sizeof(input[i].structArr); j++)
        {
            reinterpret_cast<byte *>(input[i].structArr)[j] = '0' + static_cast<char>((i + j) % 10);
        }

        input[i].theFloats[0] = i + 1;
        input[i].theFloats[1] = input[i].theFloats[0] / 2;

        input[i].theDouble = input[i].theFloats[1] + 1;
    }

    assertSucceeded(cudaMallocManaged(reinterpret_cast<void **>(&results), sizeof(unsigned) * dataLength));
    assert(!!results);

    constexpr int blocks = dataLength / threadsPerBlock;
    cudaComputeHash<<<blocks, threadsPerBlock>>>(input, results);

    assertSucceeded(cudaDeviceSynchronize());

    const unsigned expectedResult =
        1 +
        3 +
        ARRAY_LENGTH(input[0].arr) * (ARRAY_LENGTH(input[0].arr) - 1) / 2 +
        ARRAY_LENGTH(input[0].arr) * 2 +
        sizeof(input[0].structArr) * (sizeof(input[0].structArr) - 1) / 2 +
        1; // Added by cudaComputeHash (rather than by cudaComputeHashInner)

    for (unsigned i = 0; i < dataLength; i++)
    {
        if (results[i] != expectedResult){
            fprintf(stderr, "results[%u] (%u) != %u\n", i, results[i], expectedResult);
            exit(1);
        }
    }

    assertSucceeded(cudaFree(input));
    assertSucceeded(cudaFree(results));

    fprintf(stderr, "Success\n");

    exit(0);
}
