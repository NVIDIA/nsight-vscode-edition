#include <cuda.h>

#include <array>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <vector>

constexpr unsigned dataLength = 1 << 5;
constexpr unsigned threadsPerBlock = 1 << 5;

static void check(CUresult err, const char* what)
{
    if (err == CUDA_SUCCESS) {
        return;
    }

    const char* name = nullptr;
    cuGetErrorName(err, &name);
    const char* description = nullptr;
    cuGetErrorString(err, &description);
    std::fprintf(stderr, "%s failed: %s (%s)\n", what,
        name ? name : "unknown error", description ? description : "no description");
    std::exit(1);
}

static std::vector<char> readFile(const char* path)
{
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        std::fprintf(stderr, "cannot open %s\n", path);
        std::exit(1);
    }
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

int main(int argc, char* argv[])
{
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <path to kernel.fatbin>\n", argv[0]);
        return 1;
    }

    check(cuInit(0), "cuInit");

    CUdevice device = 0;
    check(cuDeviceGet(&device, 0), "cuDeviceGet");

    CUcontext context = nullptr;
#if CUDA_VERSION >= 13000
    // CUDA 13 redirects cuCtxCreate to cuCtxCreate_v4, which takes creation params.
    check(cuCtxCreate(&context, nullptr, 0, device), "cuCtxCreate");
#else
    check(cuCtxCreate(&context, 0, device), "cuCtxCreate");
#endif

    const std::vector<char> fatbin = readFile(argv[1]);

    CUmodule loadedModule = nullptr;
    check(cuModuleLoadData(&loadedModule, fatbin.data()), "cuModuleLoadData");

    CUfunction kernel = nullptr;
    check(cuModuleGetFunction(&kernel, loadedModule, "kernel"), "cuModuleGetFunction");

    CUdeviceptr results = 0;
    check(cuMemAlloc(&results, dataLength * sizeof(unsigned)), "cuMemAlloc");

    void* args[] = {&results};
    check(cuLaunchKernel(kernel, dataLength / threadsPerBlock, 1, 1, threadsPerBlock, 1, 1,
              0, nullptr, args, nullptr),
        "cuLaunchKernel");
    check(cuCtxSynchronize(), "cuCtxSynchronize");

    std::array<unsigned, dataLength> hostResults = {};
    check(cuMemcpyDtoH(hostResults.data(), results, sizeof(hostResults)), "cuMemcpyDtoH");

    check(cuMemFree(results), "cuMemFree");
    check(cuModuleUnload(loadedModule), "cuModuleUnload");
    check(cuCtxDestroy(context), "cuCtxDestroy");

    for (unsigned i = 0; i < dataLength; ++i) {
        if (hostResults[i] != i) {
            std::fprintf(stderr, "results[%u] is %u, expected %u\n", i, hostResults[i], i);
            return 1;
        }
    }
    std::printf("Success\n");
    return 0;
}
