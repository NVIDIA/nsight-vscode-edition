#include "../helpers.h"

// ===== MAIN DISPATCHER =====
void print_usage(const char* program_name) {
    printf("Usage: %s <test_prop>\n", program_name);
    printf("\nAvailable test props:\n");
    for (const auto& pair : getTestProps()) {
        printf("  %s\n", pair.first.c_str());
    }
}

int main(int argc, char** argv)
{
    if (argc < 2) {
        print_usage(argv[0]);
        return 1;
    }
    
    const char* test_prop = argv[1];
    auto& testProps = getTestProps();
    
    auto it = testProps.find(test_prop);
    if (it != testProps.end()) {
        return it->second();
    } else {
        printf("Unknown test prop: %s\n", test_prop);
        print_usage(argv[0]);
        return 1;
    }
}
