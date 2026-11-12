cmake_minimum_required(VERSION 3.20)

# DVS build machines have no GPU, so CMake cannot auto-detect architectures.
# This default covers Turing through Blackwell. It must be set before project(),
# which otherwise seeds the variable with nvcc's single default architecture.
if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
    set(CMAKE_CUDA_ARCHITECTURES 75 80 86 87 89 90 100 120)
endif()

project(test_workspaces LANGUAGES C CXX CUDA)

# Test helpers use C++20 features (<format>), which requires GCC 13+.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug CACHE STRING "CMAKE_BUILD_TYPE" FORCE)
endif()
if(CMAKE_BUILD_TYPE STREQUAL Debug)
    # Enable debug symbols for cuda-gdb
    set(CMAKE_CUDA_FLAGS ${CMAKE_CUDA_FLAGS} "--debug --device-debug")
endif()

add_subdirectory(default)
add_subdirectory(driverApis)
