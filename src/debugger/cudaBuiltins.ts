import { type GDBBackend, type ObjectVariableReference, sendDataEvaluateExpression } from 'cdt-gdb-adapter';
import { logger } from '@vscode/debugadapter';

const CUDA_BUILTINS_CONTAINER = 'cudaBuiltins';
const CUDA_BUILTINS_VAROBJ = '__cuda_builtins__';
const CUDA_DIM_PREFIX = '__cuda_dim__:';
const PTX_REGS_VAROBJ = '__ptx_regs__';

export interface CudaBuiltinsVariableReference extends ObjectVariableReference {
    container: typeof CUDA_BUILTINS_CONTAINER;
}

// Type guards for synthetic CUDA handles
function isCudaBuiltinsRef(ref: unknown): ref is CudaBuiltinsVariableReference {
    return !!ref && (ref as any).type === 'object' && (ref as any).container === CUDA_BUILTINS_CONTAINER;
}

function isCudaDimRef(ref: unknown): ref is ObjectVariableReference {
    const candidate: any = ref as any;
    return !!ref && candidate.type === 'object' && typeof candidate.varobjName === 'string' && candidate.varobjName.startsWith(CUDA_DIM_PREFIX);
}

function isCudaPtxSpecialsRef(ref: unknown): ref is ObjectVariableReference {
    const candidate: any = ref as any;
    return !!ref && candidate.type === 'object' && typeof candidate.varobjName === 'string' && candidate.varobjName === PTX_REGS_VAROBJ;
}

// Evaluation helper functions
async function evaluateScalar(gdb: GDBBackend, expression: string, frameId: number, threadId: number): Promise<string> {
    try {
        const response = await sendDataEvaluateExpression(gdb, expression, frameId, threadId);
        return response.value ?? 'N/A';
    } catch (error) {
        logger.verbose(`Failed to evaluate built-in ${expression}: ${String(error)}`);
        return 'N/A';
    }
}

async function evaluateDimFormatted(gdb: GDBBackend, name: 'threadIdx' | 'blockIdx' | 'blockDim' | 'gridDim', frameId: number, threadId: number): Promise<string> {
    // We don't cache the dimension components here even though they might be fetched again when the user expands the dimensions.
    // The fetch is cheap (3 simple MI commands) and completes quickly, so caching adds complexity without meaningful UX benefit.
    try {
        const [x, y, z] = await Promise.all([sendDataEvaluateExpression(gdb, `${name}.x`, frameId, threadId), sendDataEvaluateExpression(gdb, `${name}.y`, frameId, threadId), sendDataEvaluateExpression(gdb, `${name}.z`, frameId, threadId)]);
        return `(${x.value ?? '?'},${y.value ?? '?'},${z.value ?? '?'})`;
    } catch (error) {
        logger.verbose(`Failed to evaluate dimension ${name}: ${String(error)}`);
        return 'N/A';
    }
}

async function evaluateComponent(gdb: GDBBackend, dimName: string, component: 'x' | 'y' | 'z', frameHandle: number, threadId: number): Promise<string> {
    try {
        const response = await sendDataEvaluateExpression(gdb, `${dimName}.${component}`, frameHandle, threadId);
        return response.value ?? 'N/A';
    } catch (error) {
        logger.verbose(`Failed to evaluate built-in component ${dimName}.${component}: ${String(error)}`);
        return 'N/A';
    }
}

async function evaluateToken(gdb: GDBBackend, displayName: string, frameHandle: number, threadId: number): Promise<string | undefined> {
    const token = displayName.startsWith('%') ? `$${displayName.slice(1)}` : displayName;
    try {
        const evalResult = await sendDataEvaluateExpression(gdb, token, frameHandle, threadId);
        const { value } = evalResult;
        if (value === undefined || String(value) === 'void') {
            return undefined;
        }
        return String(value);
    } catch (error) {
        logger.verbose(`PTX register ${displayName} (${token}) not available: ${String(error)}`);
        return undefined;
    }
}

/**
 * Fallback of the most common PTX special register names.
 * We use this fallback for older versions of cuda-gdb (< 13.2), which do not support the -cuda-info-ptx-special-registers MI command.
 */
const ptxSpecialRegisterNamesFallback: string[] = ['%laneid', '%warpid', '%nwarpid', '%smid', '%nsmid', '%gridid', '%lanemask_eq', '%lanemask_le', '%lanemask_lt', '%lanemask_ge', '%lanemask_gt', '%aggr_smem_size'];

export default {
    CUDA_BUILTINS_CONTAINER,
    CUDA_BUILTINS_VAROBJ,
    CUDA_DIM_PREFIX,
    PTX_REGS_VAROBJ,
    isCudaBuiltinsRef,
    isCudaDimRef,
    isCudaPtxSpecialsRef,
    evaluateScalar,
    evaluateDimFormatted,
    evaluateComponent,
    evaluateToken,
    ptxSpecialRegisterNamesFallback
} as const;
