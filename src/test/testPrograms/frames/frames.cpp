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
#include <thread>

int callee1()
{
    int a = 3;
    int b = 5;

    // Breakpoint on the line with return:
    // Variable c in the callee should've
    // gone away from the variables panel
    // at this point.
    return a + b;
}

int callee2()
{
    int a = 8;
    int b = 13;
    int c = 21;
    int d = 34;

    // Breakpoint on the line with return:
    // Variable c should come back now but
    // have the value 21. Variable "a" and
    // "b" should be correctly updated and
    // a new variable "d" should appear.
    return a + b + c + d;
}

int callee3()
{
    int a = 8;

    // Breakpoint on the line with return:
    // Variable "a" still has the same value
    // meaning that -var-update should return
    // an empty changelist.
    return a;
}

int callee4()
{
    struct 
    {
        int x;
        int y;
        int z;
    } a = {55, 89, 144};

    // Breakpoint on the line with return:
    // Only variable "a" should be shown in
    // the panel but it should be expandable
    // now as it is a struct.
    return a.x + a.y;
}

int callee5()
{
    struct 
    {
        int x;
        int y;
        int z;
    } a = {233, 89, 377};

    // Breakpoint on the line with return:
    // a.x and a.z change but a.y remains
    // the same.
    return a.x + a.y;
}

int callee6()
{
    // Breakpoint on the line with return:
    // Only "a" should be in the panel but
    // it should be back to a leaf node.
    int a = 610;
    return a;
}

int caller()
{
    int c = 2;
    return c + callee1() + callee2() + callee3() + callee4() + callee5() + callee6();
}

int ovFunc()
{
    int a = 2;
    int b = 3;
    int c = 5;
    return a + b + c;
}

int ovFunc(int a)
{
    int b = a;
    char c = static_cast<char>(a) + '0';
    c++;
    a--;
    return a + b + c;
}

int ovFunc(int a, int c)
{
    struct {
        int x;
        int y;
    } b = {8, 13};

    return a + b.x + b.y + c;
}

double globalArray[2];

void threadMain(
    unsigned ufThreadId) // User-friendly thread ID
{
    int elementIdx = ufThreadId - 1;
    double result = ufThreadId;

    for(unsigned long long i = 0; i < 1000; i++)
    {
        result *= 1.5;
        if(result > 10)
        {
            result /= 10;
        }
    }

    globalArray[elementIdx] = result;
}

int main()
{
    int callChainResult = caller();

    int ovResult =
        ovFunc() + ovFunc(3) + ovFunc(1, 2) + ovFunc(3) + ovFunc();

    std::thread thread1(threadMain, 1);
    std::thread thread2(threadMain, 2);

    thread1.join();
    thread2.join();

    std::cout << callChainResult << '\n';
    std::cout << ovResult << '\n';
    std::cout << globalArray[0] << ", " << globalArray[1] << '\n';

    return 0;
}

