#pragma once

#include <array>
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <iterator>
#include <format>
#include <cuda_runtime.h>
#include <map>
#include <string>
#include <functional>
#include <cstdio>

template<std::size_t N, typename T>
__host__ __device__
constexpr std::size_t countof(const T (&)[N])
{
    return N;
}

template<typename... Args>
void print(std::format_string<Args...> fmt, Args&&... args)
{
    std::ostream_iterator<char> out(std::cout);
    std::format_to(out, fmt, std::forward<Args>(args)...);
}

template<typename... Args>
void eprint(std::format_string<Args...> fmt, Args&&... args)
{
    std::ostream_iterator<char> out(std::cerr);
    std::format_to(out, fmt, std::forward<Args>(args)...);
}

struct panic {
    friend void operator|| (cudaError_t err, panic) {
        print("CUDA error {}: {}\n", unsigned(err), cudaGetErrorString(err));
        if (err != cudaSuccess) {
            //print("CUDA error {}: {}\n", err, cudaGetErrorString(err));
            assert(err != cudaSuccess);
        }
    }
} const panic;

// SHARED CONSTANTS AND DATA STRUCTURES
constexpr int dataLength = 1 << 5;
constexpr int threadsPerBlock = 1 << 5;
typedef unsigned char byte;

// for variable inspection testing
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

// Global map for test prop registration 
inline std::map<std::string, std::function<int()>>& getTestProps() {
    static std::map<std::string, std::function<int()>> testProps;
    return testProps;
}

struct TestPropRegistrar {
    TestPropRegistrar(const char* name, std::function<int()> func) {
        getTestProps()[name] = func;
    }
};

#define REGISTER_TEST_PROP(name, func) \
    static TestPropRegistrar registrar(#name, func)


