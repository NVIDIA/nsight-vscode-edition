all: build

build: driverApis kernel.fatbin

driverApis: driverApis.cpp
	nvcc -g -G -o $@ $+ -lcuda

kernel.fatbin: kernel.cu
	nvcc -g -G -o $@ $+ -fatbin

clean:
	rm -f driverApis
	rm -f kernel.fatbin

clobber: clean
