#include <cstdlib>
#include <cstring>
#include <iostream>
#include <fstream>
#include <vector>

int main()
{
    std::vector<std::pair<const char*, const char*>> envVars = {
        {"ENV_VAR1", "Value1"},
        {"ENV_VAR2", "Value2"},
        {"ENV_VAR3", ""},
        {"HOME", nullptr}
    };

    bool success = true;
    for (const auto& var : envVars)
    {
            const char* actualValue = std::getenv(var.first);
            const char* expectedValue = var.second;

            success = success && (!actualValue || !expectedValue ? actualValue == expectedValue : !strcmp(actualValue, expectedValue));
            std::cout << var.first << "=" << (actualValue ? actualValue : "Var not found.") << std::endl;
    }

    std::cout << std::getenv("PWD") << std::endl;

    return success ? 0 : 1;
}
