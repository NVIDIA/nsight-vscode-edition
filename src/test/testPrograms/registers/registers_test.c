/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

#include <stddef.h>

__attribute__((naked)) size_t testFunc(size_t a, size_t b, size_t c, size_t d, size_t e, size_t f)
{
    __asm__("movq $0x59,%rax");
    __asm__("retq");
}

int main()
{
    return testFunc(5, 8, 13, 21, 34, 55);
}
