cmake_minimum_required(VERSION 3.20)

project(default LANGUAGES C CXX CUDA)

add_executable(default 
    default.cu
    attach.cu
    variables.cu
    concurrent.cu
    single-thread.cu
    stepping.cu
)

target_compile_features(default PRIVATE cxx_std_20)

set_target_properties(default PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    CUDA_ARCHITECTURES 75 80 86 87 89 90 100 101 120
    CUDA_SEPARABLE_COMPILATION ON
) 