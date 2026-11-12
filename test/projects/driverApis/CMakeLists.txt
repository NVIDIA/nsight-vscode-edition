cmake_minimum_required(VERSION 3.20)

project(driverApis LANGUAGES CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_SIZEOF_VOID_P EQUAL 8)
    # Multilib sysroots can place x86-64 libraries in lib64 on Debian hosts.
    set_property(GLOBAL PROPERTY FIND_LIBRARY_USE_LIB64_PATHS TRUE)
endif()

find_package(CUDAToolkit REQUIRED)

# Enabling the CUDA language in the parent project already sets
# CMAKE_CUDA_ARCHITECTURES to nvcc's single default architecture, so the full list
# is set here instead. sm_101 is omitted because CUDA 13 no longer accepts it.
set(CMAKE_CUDA_ARCHITECTURES 75 80 86 87 89 90 100 120)

# The fatbin is loaded at runtime via cuModuleLoadData, so it is built by
# invoking nvcc directly instead of being compiled into a target.
set(gencodeFlags "")
foreach(arch IN LISTS CMAKE_CUDA_ARCHITECTURES)
    list(APPEND gencodeFlags -gencode arch=compute_${arch},code=sm_${arch})
endforeach()

add_custom_command(
    OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/kernel.fatbin
    COMMAND ${CUDAToolkit_NVCC_EXECUTABLE}
        -fatbin ${gencodeFlags} --debug --device-debug
        -o ${CMAKE_CURRENT_BINARY_DIR}/kernel.fatbin
        ${CMAKE_CURRENT_SOURCE_DIR}/kernel.cu
    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/kernel.cu
    COMMENT "Building kernel.fatbin"
    VERBATIM
)

add_custom_target(kernelFatbin DEPENDS ${CMAKE_CURRENT_BINARY_DIR}/kernel.fatbin)

add_executable(driverApis driverApis.cpp)

target_link_libraries(driverApis PRIVATE CUDA::cuda_driver)

add_dependencies(driverApis kernelFatbin)
