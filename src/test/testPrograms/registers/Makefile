#  ----------------------------------------------------------------------------------
#
#  Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.
#
#  The contents of this file are licensed under the Eclipse Public License 2.0.
#  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/
#
#  SPDX-License-Identifier: EPL-2.0
#
#  ----------------------------------------------------------------------------------


all: build

build: registers_test

registers_test: registers_test.c
	gcc -g -o $@ $+

clean:
	rm -f registers_test

clobber: clean
