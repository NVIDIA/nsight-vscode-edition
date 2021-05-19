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

#include <iostream>

struct A
{
    int alpha;
    int beta;
    A(int alpha, int beta)
    {
        this->alpha = alpha;
        this->beta = beta;
    }
};

int structAssignTest(A* a1, A* a2)
{
    A* a = a1;
    return (a->alpha + a2->alpha) * (a->beta + a2->beta);
}

int main()
{
    A a1(1,1);
    A a2(2,2);

    int x = 2;
    int satResult = structAssignTest(&a1, &a2);
    int result = x + satResult;

    std::cout << result << '\n';

    return 0;
}

