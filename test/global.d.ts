/// Fully qualified name of the test currently being executed. Each element in the array is
/// a string passed to `test()` or `describe()`, in the order in which they were nested, e.g.:
/// ['Breakpoints', 'Can hit breakpoint in CUDA kernel'].
///
/// Updated by RubiconEnvironment in jest.environment.mts
declare const currentTest: string[];

/// Absolute path to the directory where log files for the current test should be stored.
///
/// Updated by RubiconEnvironment in jest.environment.mts
declare const currentLogPath: string | undefined;
