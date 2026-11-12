extern "C" __global__ void kernel(unsigned* results)
{
    const unsigned idx = blockIdx.x * blockDim.x + threadIdx.x;
    results[idx] = idx; /*📍kernel*/
}
