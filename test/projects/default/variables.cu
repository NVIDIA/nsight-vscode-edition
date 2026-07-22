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

// Shared functions used by this test prop
/*📍addNums*/ __device__ __host__ int addNums(int a, int b)
{
    return a + b;
}

class Multiplier {
public:
    /*📍Multiplier::mul*/ __device__ int mul(int a, int b) const {
        int result = 0;
        for (int i = 0; i < a; i++) {
            result += b;
        }
        return result;
    }
};

/*📍cudaComputeHashInner*/ __device__ void cudaComputeHashInner(TestType* input, unsigned *results)
{
    int idx = blockIdx.x * threadsPerBlock + threadIdx.x;
    TestType* myInput = input + idx;

    unsigned myResult = 0;

    myResult += myInput->takeYourPick.halfAndHalf.lowHalf - idx;
    myResult += myInput->takeYourPick.halfAndHalf.highHalf - idx;

    myResult += addNums(idx, 5);

    Multiplier m;
    myResult += m.mul(idx, 2);

    for(size_t i = 0; i < countof(myInput->arr); i++)
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

/*📍cudaComputeHash*/ __global__ void cudaComputeHash(TestType* input, unsigned *results)
{
    int idx = blockIdx.x * threadsPerBlock + threadIdx.x;
    /*📍deviceCall*/ cudaComputeHashInner(input, results);
    results[idx] += 1;
}

int run_variables_test()
{
    int cudaDeviceCount;
    cudaGetDeviceCount(&cudaDeviceCount) || panic;
    assert(cudaDeviceCount > 0);

    cudaSetDevice(0) || panic;

    TestType* input;
    unsigned* results;

    cudaMallocManaged(&input, sizeof(TestType) * dataLength) || panic;
    assert(!!input);

    for (size_t i = 0; i < dataLength; i++)
    {
        input[i].takeYourPick.halfAndHalf.lowHalf = i + 1;
        input[i].takeYourPick.halfAndHalf.highHalf = i + 3;

        for(size_t j = 0; j < countof(input[i].arr); j++)
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

    cudaMallocManaged(reinterpret_cast<void **>(&results), sizeof(unsigned) * dataLength) || panic;
    assert(results);

    // Host call to addNums for breakpoint test
    int hostSum = addNums(2, 3);
    (void)hostSum; /*📍hostCall*/

    constexpr int blocks = dataLength / threadsPerBlock;
    cudaComputeHash<<<blocks, threadsPerBlock>>>(input, results);

    cudaDeviceSynchronize() || panic; /*📍afterKernel*/

    const unsigned expectedResult =
        1 +
        3 +
        countof(input[0].arr) * (countof(input[0].arr) - 1) / 2 +
        countof(input[0].arr) * 2 +
        sizeof(input[0].structArr) * (sizeof(input[0].structArr) - 1) / 2 +
        1; // Added by cudaComputeHash (rather than by cudaComputeHashInner)

    for (unsigned i = 0; i < dataLength; i++)
    {
        const unsigned expectedResultForThread =
            (i + 1) + (i + 3) - i - i +  // lowHalf + highHalf - idx - idx
            (i + 5) +                    // addNums(idx, 5)
            (i * 2) +                    // m.mul(idx, 2)
            (5 * (5 - 1) / 2 + 5 * 2) + // arr sum
            (10 * (10 - 1) / 2) +        // structArr sum
            1;                           // Added by cudaComputeHash
        
        if (results[i] != expectedResultForThread){
            printf("Mismatch at i=%u: got %u, expected %u\n", i, results[i], expectedResultForThread);
            exit(1);
        }
    }

    //  loop for breakpoint removal
    int i = 0;
    while (i < 10) {
        ++i; /*📍loopInside*/
    }
    assert(i == 10); /*📍loopAfter*/

    cudaFree(input) || panic;
    cudaFree(results) || panic;

    print("Success\n");

    exit(0);
}

REGISTER_TEST_PROP(variables, run_variables_test);
